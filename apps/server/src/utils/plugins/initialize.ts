import { copyFile, cp, lstat, mkdir, readFile, readdir, realpath, rename, unlink, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
import { z } from "zod";

const artifactLimit = 20 * 1024 * 1024;
const nodeUpgradeSchema = z.object({
  version: z.literal(1),
  initialized: z.string().max(1024).nullable(),
  files: z.array(z.object({
    fileName: z.string().regex(/^[a-z][a-zA-Z0-9]*\.[a-z][a-zA-Z0-9]*\.js$/),
    archive: z.string().regex(/^[a-z][a-zA-Z0-9]*\/p[a-f0-9]{64}\/[a-z][a-zA-Z0-9]*\.[a-z][a-zA-Z0-9]*\.js$/).optional(),
    revision: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  }).refine(file => (file.archive === undefined) === (file.revision === undefined)
    && (!file.archive || file.archive.split("/")[2] === file.fileName))),
  staged: z.array(z.string().regex(/^\.pluginSync[0-9a-f-]{36}$/)),
}).refine(intent => intent.files.length <= 4096 && intent.staged.length <= 4096
  && new Set(intent.files.map(file => file.fileName)).size === intent.files.length);
type NodeUpgradeIntent = z.infer<typeof nodeUpgradeSchema>;

async function readNodeArtifact(path: string, optional = false) {
  const info = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (optional && error.code === "ENOENT") return undefined;
    throw error;
  });
  if (!info) return;
  if (!info.isFile() || info.isSymbolicLink() || info.size < 1 || info.size > artifactLimit)
    throw new Error("节点产物必须为不超过 20 MB 的普通文件");
  const content = await readFile(path);
  if (content.byteLength > artifactLimit) throw new Error("节点产物不能超过 20 MB");
  return content;
}

function nodePackageDigest(files: Map<string, Buffer>, revision?: string) {
  const hashes = [...files].sort(([first], [second]) => first.localeCompare(second))
    .map(([name, content]) => [name, createHash("sha256").update(content).digest("hex")]);
  return createHash("sha256").update(JSON.stringify({ revision, files: hashes })).digest("hex");
}

async function restoreNodeUpgrade(targetDirectory: string, intent: NodeUpgradeIntent) {
  const { writeWorkspaceFile, isWithin } = await import("@/utils/workspace/files");
  const archives = resolve(dirname(targetDirectory), "nodeExecutions");
  // 全部旧快照先校验再恢复；损坏归档不能造成部分回退。
  const previous = new Map<string, Buffer | undefined>();
  for (const file of intent.files) {
    let content: Buffer | undefined;
    if (file.archive) {
      const parts = file.archive.split("/");
      for (const directory of [archives, resolve(archives, parts[0]!), resolve(archives, parts[0]!, parts[1]!)]) {
        const info = await lstat(directory);
        if (!info.isDirectory() || info.isSymbolicLink() || !isWithin(await realpath(dirname(targetDirectory)), await realpath(directory)))
          throw new Error("节点升级恢复归档目录无效");
      }
      content = (await readNodeArtifact(resolve(archives, file.archive)))!;
      if (createHash("sha256").update(content).digest("hex") !== file.revision) throw new Error("节点升级恢复归档校验失败");
    }
    previous.set(file.fileName, content);
  }
  const failures: unknown[] = [];
  for (const [fileName, content] of previous) {
    try {
      const path = resolve(targetDirectory, fileName);
      const current = await readNodeArtifact(path, true);
      if (content) {
        if (!current?.equals(content)) await writeWorkspaceFile(path, content);
      } else if (current) await unlink(path);
    } catch (error) { failures.push(error); }
  }
  const marker = resolve(targetDirectory, "initialized");
  try {
    const current = await readFile(marker, "utf8").catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return; throw error; });
    if (intent.initialized === null) {
      if (current !== undefined) await unlink(marker);
    } else if (current !== intent.initialized) await writeWorkspaceFile(marker, intent.initialized);
  } catch (error) { failures.push(error); }
  for (const temporary of intent.staged) {
    try { await unlink(resolve(targetDirectory, temporary)).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; }); }
    catch (error) { failures.push(error); }
  }
  if (failures.length) throw new AggregateError(failures, "官方节点升级回退未完成，请保留归档并在解除文件占用后重试");
  await unlink(resolve(targetDirectory, "nodeUpgrade.json")).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; });
}

export async function initializeNodePlugins(targetDirectory: string, sourceDirectory: string, revision?: string) {
  const { writeWorkspaceFile, lockWorkspaceFiles, isWithin } = await import("@/utils/workspace/files");
  await mkdir(targetDirectory, { recursive: true });
  if ((await lstat(targetDirectory)).isSymbolicLink()) throw new Error("节点目录不能是符号链接");
  const release = lockWorkspaceFiles([targetDirectory]);
  try {
    const intentPath = resolve(targetDirectory, "nodeUpgrade.json");
    const interrupted = await readNodeArtifact(intentPath, true);
    if (interrupted) await restoreNodeUpgrade(targetDirectory, nodeUpgradeSchema.parse(JSON.parse(interrupted.toString("utf8"))));
    const entries = await readdir(sourceDirectory, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (!entries) return;
    const names = entries.filter(entry => entry.isFile() && /^[a-z][a-zA-Z0-9]*\.(node|umd)\.js$/.test(entry.name))
      .map(entry => entry.name.replace(/\.(node|umd)\.js$/, ""));
    if (!names.length) return;
    // app 已设置数据目录；不能在模块顶层导入会初始化 conf 的节点工具。
    const { parseNodeExecution, validateNodeExecutionPair, retainNodeExecutionRevision } = await import("@/utils/plugins/nodeExecution");
    const packages: { name: string; files: Map<string, Buffer> }[] = [];
    const incoming = new Map<string, Buffer>();
    for (const name of [...new Set(names)].sort()) {
      const backend = (await readNodeArtifact(resolve(sourceDirectory, `${name}.node.js`)))!;
      const metadata = parseNodeExecution(backend.toString("utf8"), name);
      const ui = (await readNodeArtifact(resolve(sourceDirectory, `${name}.umd.js`)))!;
      validateNodeExecutionPair(ui.toString("utf8"), createHash("sha256").update(backend).digest("hex"));
      new Bun.Transpiler({ loader: "js" }).scan(ui.toString("utf8"));
      const files = new Map([[`${name}.node.js`, backend], [`${name}.umd.js`, ui]]);
      for (const [fileName, expected] of Object.entries(metadata.artifacts)) {
        const content = (await readNodeArtifact(resolve(sourceDirectory, fileName)))!;
        if (createHash("sha256").update(content).digest("hex") !== expected)
          throw new Error(`官方节点配套产物校验失败：${fileName}`);
        files.set(fileName, content);
      }
      packages.push({ name, files });
      for (const [fileName, content] of files) incoming.set(fileName, content);
    }
    const bundleRevision = nodePackageDigest(incoming, revision);
    const marker = resolve(targetDirectory, "initialized");
    const initialized = await readFile(marker, "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (initialized === bundleRevision) return;
    const previous = new Map<string, Buffer | undefined>();
    for (const fileName of incoming.keys()) previous.set(fileName, await readNodeArtifact(resolve(targetDirectory, fileName), true));
    const intent: NodeUpgradeIntent = { version: 1, initialized: initialized ?? null, files: [], staged: [] };
    const archived = new Map<string, string>();
    for (const item of packages) {
      const oldFiles = new Map([...item.files.keys()].flatMap(fileName => previous.get(fileName) ? [[fileName, previous.get(fileName)!] as const] : []));
      const backend = oldFiles.get(`${item.name}.node.js`);
      if (backend) {
        const metadata = parseNodeExecution(backend.toString("utf8"), item.name);
        for (const fileName of Object.keys(metadata.artifacts)) oldFiles.set(fileName, (await readNodeArtifact(resolve(targetDirectory, fileName)))!);
      }
      if (!oldFiles.size) continue;
      const archives = resolve(dirname(targetDirectory), "nodeExecutions");
      const oldRevision = nodePackageDigest(oldFiles);
      const archive = resolve(archives, item.name, `p${oldRevision}`);
      for (const directory of [archives, resolve(archives, item.name), archive]) {
        const info = await lstat(directory).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return; throw error; });
        if (info && (!info.isDirectory() || info.isSymbolicLink())) throw new Error("节点归档目录无效");
        await mkdir(directory, { recursive: true });
        if (!isWithin(await realpath(dirname(targetDirectory)), await realpath(directory))) throw new Error("节点归档目录越过数据目录");
      }
      for (const [fileName, content] of oldFiles) {
        const path = resolve(archive, fileName);
        await writeWorkspaceFile(path, content, true).catch((error: NodeJS.ErrnoException) => { if (error.code !== "EEXIST") throw error; });
        if (!(await readNodeArtifact(path))!.equals(content)) throw new Error("旧节点包归档校验失败");
        archived.set(fileName, `${item.name}/p${oldRevision}/${fileName}`);
      }
      // 固定 revision 的后台任务继续沿用原后端与声明的配套产物。
      await retainNodeExecutionRevision(item.name);
    }
    const staged = new Map<string, string>();
    for (const [fileName, content] of previous) intent.files.push({ fileName, archive: archived.get(fileName),
      revision: content ? createHash("sha256").update(content).digest("hex") : undefined });
    for (const fileName of incoming.keys()) {
      const temporary = `.pluginSync${crypto.randomUUID()}`;
      staged.set(fileName, resolve(targetDirectory, temporary));
      intent.staged.push(temporary);
    }
    nodeUpgradeSchema.parse(intent);
    try {
      // ACT: 小型持久 intent 覆盖多文件 rename；启动恢复旧包后再同步，无额外 worker。
      await writeWorkspaceFile(intentPath, JSON.stringify(intent));
      for (const [fileName, content] of incoming) {
        await writeFile(staged.get(fileName)!, content, { flag: "wx", mode: 0o600 });
      }
      for (const [fileName, temporary] of staged) await rename(temporary, resolve(targetDirectory, fileName));
      await writeWorkspaceFile(marker, bundleRevision);
      await unlink(intentPath);
    } catch (error) {
      // ACT: 恢复所有选定成员，包含原子 rename 成功后才抛错的那一个文件。
      try { await restoreNodeUpgrade(targetDirectory, intent); }
      catch (cause) { throw new AggregateError([error, cause], "官方节点升级失败且回退未完成，请保留归档并核对配对产物"); }
      throw error;
    }
  } finally { release(); }
}

export default async function initializePlugins(targetDirectory: string, sourceDirectory: string, fileFilter?: RegExp | readonly string[], revision?: string) {
  const marker = resolve(targetDirectory, "initialized");
  const initialized = await readFile(marker, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (initialized !== null && (revision === undefined || initialized === revision)) return;

  const entries = await readdir(sourceDirectory, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (!entries) return;
  await mkdir(targetDirectory, { recursive: true });
  const files = entries.filter(file => fileFilter
    ? file.isFile() && (fileFilter instanceof RegExp ? fileFilter.test(file.name) : fileFilter.includes(file.name))
    : file.isDirectory());
  if (!files.length && revision === undefined) return;
  for (const file of files) {
    const source = resolve(sourceDirectory, file.name);
    const target = resolve(targetDirectory, file.name);
    if (revision === undefined) {
      await cp(source, target, { recursive: true, force: false });
      continue;
    }
    // ACT: 版本同步仅覆盖节点和工具单文件；同目录 rename 保留失败时的旧文件。
    const temporary = resolve(targetDirectory, `.pluginSync${crypto.randomUUID()}`);
    try {
      await copyFile(source, temporary);
      await rename(temporary, target);
    } finally {
      await unlink(temporary).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; });
    }
  }
  // 同一构建只同步一次；安装器移除标记以支持同版本重装，构建变化支持升级和降级。
  await writeFile(marker, revision ?? "", { flag: revision === undefined ? "wx" : "w" }).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "EEXIST") throw error;
  });
}
