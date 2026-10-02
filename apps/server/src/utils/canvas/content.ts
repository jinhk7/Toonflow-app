import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, readdir } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { resolveWorkspacePath, writeWorkspaceFile, lockWorkspaceFiles, assertNoManagedGraph } from "@/utils/workspace/files";
import { resolveWorkspace } from "@/utils/workspace";
import { acceptResourceWrite, completeResourceWrite, getResourceWrite, markResourceWriteApplied, listIncompleteResourceWrites, appendWorkspaceEvent, registerManagedResource, isManagedResource, containsManagedResource } from "@/utils/canvas/store";

const pending = new Map<string, Promise<void>>();

export function contentRevision(content: string) {
  return createHash("sha256").update(content).digest("hex");
}

async function serialize<T>(path: string, action: () => Promise<T>) {
  const key = process.platform === "win32" ? path.toLowerCase() : path;
  const previous = pending.get(key);
  let finish!: () => void;
  const current = new Promise<void>(resolve => { finish = resolve; });
  pending.set(key, current);
  if (previous) await previous;
  try { return await action(); }
  finally { if (pending.get(key) === current) pending.delete(key); finish(); }
}

async function readOptional(path: string) {
  return readFile(path, "utf8").then(content => ({ content, exists: true })).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return { content: "", exists: false };
    throw error;
  });
}

export async function readVersionedContent(directory: string, path: string) {
  const target = await resolveWorkspacePath(await resolveWorkspace(directory), path, true);
  registerManagedResource(target.directory, relative(target.directory, target.path));
  return serialize(target.path, async () => {
    const { content, exists } = await readOptional(target.path);
    return { content, revision: contentRevision(content), exists };
  });
}

export async function writeVersionedContent(input: { directory: string; path: string; content: string; expectedRevision: string; commandId: string }) {
  const target = await resolveWorkspacePath(await resolveWorkspace(input.directory), input.path, true);
  const path = relative(target.directory, target.path).replaceAll("\\", "/");
  registerManagedResource(target.directory, path);
  return serialize(target.path, async () => {
    const release = lockWorkspaceFiles([target.path]);
    try {
      const revision = contentRevision(input.content);
      const existing = getResourceWrite(target.directory, input.commandId);
      // 已完成命令只返回原收据，后续编辑不能使旧重试重新写文件。
      if (existing) {
        const status = acceptResourceWrite({ ...input, directory: target.directory, path, beforeHash: input.expectedRevision, afterHash: revision });
        if (status === "completed") return { revision };
        if (status === "written") return finishResourceWrite(target.directory, input.commandId, path, revision);
      }
      await assertNoManagedGraph(target.path);
      const current = await readOptional(target.path);
      const currentRevision = contentRevision(current.content);
      const alreadyApplied = !!existing && current.exists && currentRevision === revision;
      if (!alreadyApplied && currentRevision !== input.expectedRevision) throw Object.assign(new Error("正文版本冲突，请保留草稿并刷新后重试"), { status: 409, currentRevision });
      if (!existing) acceptResourceWrite({ ...input, directory: target.directory, path, beforeHash: input.expectedRevision, afterHash: revision });
      // 写入后、完成入账前崩溃可以按内容哈希补记，不再次覆盖用户文件。
      if (!current.exists || currentRevision !== revision) {
        await mkdir(dirname(target.path), { recursive: true });
        await writeWorkspaceFile(target.path, input.content);
      }
      return finishResourceWrite(target.directory, input.commandId, path, revision);
    } finally { release(); }
  });
}

function finishResourceWrite(directory: string, commandId: string, path: string, revision: string) {
  try {
    markResourceWriteApplied(directory, commandId);
    completeResourceWrite(directory, commandId, { path, revision });
    return { revision };
  } catch {
    // ACT: 文件已经落盘，通知事务失败保留意图恢复，不能向调用方谎报文件未写入。
    return { revision, pendingRecovery: true };
  }
}

export async function ensureContentDirectory(directory: string, path: string) {
  const { path: target } = await resolveWorkspacePath(await resolveWorkspace(directory), path, true);
  await mkdir(dirname(target), { recursive: true });
}

export async function recoverResourceWrites() {
  for (const row of listIncompleteResourceWrites()) {
    try {
      await writeVersionedContent({ directory: row.directory, commandId: row.commandId, path: row.path, expectedRevision: row.beforeHash, content: JSON.parse(row.contentJson) });
    } catch (error) {
      // 不覆盖外部改动；命令仍保留意图供核对。
      try { appendWorkspaceEvent(row.directory, "contentChanged", { path: row.path, needsReview: true, errorMessage: error instanceof Error ? error.message : "恢复失败" }, { commandId: row.commandId }); }
      catch { /* 通知失败仍保留恢复意图，下次启动继续核对。 */ }
    }
  }
}

export function assertNoManagedResource(directory: string, path: string) {
  if (isManagedResource(directory, path)) throw Object.assign(new Error("节点正文或插件状态必须使用带版本的内容接口"), { status: 428 });
}

export async function assertNoManagedResourceTree(directory: string, path: string): Promise<void> {
  if (containsManagedResource(directory, path)) throw Object.assign(new Error("节点正文或插件状态必须使用带版本的内容接口"), { status: 428 });
  const target = await resolveWorkspacePath(directory, path, true);
  const info = await lstat(target.path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (!info?.isDirectory()) return;
  // 旧项目可能尚未登记正文；逐层检查实际文件，纯媒体目录仍可普通操作。
  for (const entry of await readdir(target.path)) {
    const child = resolve(target.path, entry);
    const childInfo = await lstat(child);
    if (childInfo.isSymbolicLink()) continue;
    await assertNoManagedResourceTree(directory, relative(directory, child));
  }
}
