import { createHash } from "node:crypto";
import { closeSync, fstatSync, openSync, readSync, realpathSync } from "node:fs";
import { lstat, mkdir, readFile, readdir, realpath } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { isBuiltin } from "node:module";
import * as zod from "zod";
import type { NodeExecutionAction, NodeExecutionDefinition, NodeExecutionDescriptor } from "@toonflow/nodes-scaffold/execution";
import conf from "@/utils/conf";
import { isWithin, writeWorkspaceFile } from "@/utils/workspace/files";

const { z } = zod;
const nodeNameSchema = z.string().max(96).regex(/^[a-z][a-zA-Z0-9]*$/);
const revisionSchema = z.string().regex(/^[a-f0-9]{64}$/);
const nodesDirectory = resolve(dirname(conf.path), "nodes");
const revisionsDirectory = resolve(dirname(conf.path), "nodeExecutions");
const packageLimit = 20 * 1024 * 1024;
const apply = Reflect.apply;
const mapGet = Map.prototype.get;
const mapSet = Map.prototype.set;
const mapClear = Map.prototype.clear;
const weakMapGet = WeakMap.prototype.get;
const weakMapSet = WeakMap.prototype.set;
const freeze = Object.freeze;
const builtinHashes = new Map<string, string>();
const loaded = new Map<string, Promise<LoadedNodeExecution>>();
const loadedDefinitions = new Map<string, LoadedNodeExecution>();
const builtinHandlers = new WeakMap<object, { name: string; action: string; revision: string }>();
type LoadedNodeExecution = { definition: NodeExecutionDefinition; revision: string; builtin: boolean };
type NodeExecutionMetadata = { name: string; protocolVersion: 2; version: string; artifacts: Record<string, string> };

// ACT: 后端节点使用宿主 Zod，归档副本不依赖用户安装目录中的 node_modules。
Bun.plugin({
  name: "nodeExecutionHost",
  setup(build) {
    build.module("toonflow:node-zod", () => ({ exports: zod, loader: "object" }));
  },
});

function invalid(message: string, status = 400): never {
  throw Object.assign(new Error(message), { status });
}

const handleSchema = z.object({
  id: z.string().min(1).max(128),
  type: z.enum(["source", "target"]),
  dataType: z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]),
  label: z.string().optional(),
});
const definitionSchema = z.object({
  protocolVersion: z.literal(2),
  name: nodeNameSchema,
  stateVersion: z.number().int().min(1),
  handles: z.array(handleSchema).max(256),
  defaultData: z.record(z.string(), z.json()),
  layoutSize: z.object({ width: z.number().positive().finite(), height: z.number().positive().finite() }),
  actions: z.array(z.object({ name: z.string().min(1).max(128), description: z.string(), snapshotInputs: z.boolean().optional(), parameters: z.unknown(), execute: z.custom<Function>(value => typeof value === "function") })).max(256),
});

export function parseNodeExecution(source: string, name: string) {
  nodeNameSchema.parse(name);
  let metadata: NodeExecutionMetadata;
  try {
    const header = source.match(/^\/\*! toonflowNodeExecution:([^\r\n]*) \*\/(?:\r?\n|$)/)?.[1];
    metadata = z.object({ name: nodeNameSchema, protocolVersion: z.literal(2), version: z.string().min(1).max(100), artifacts: z.record(z.string().max(256), revisionSchema).default({}) }).parse(JSON.parse(header ?? ""));
    if (metadata.name !== name) throw new Error("name");
    if (Object.keys(metadata.artifacts).length > 16 || Object.keys(metadata.artifacts).some(fileName =>
      !fileName.startsWith(`${name}.`) || !/^[a-z][a-zA-Z0-9]*\.[a-z][a-zA-Z0-9]*\.js$/.test(fileName) || fileName === `${name}.node.js` || fileName === `${name}.umd.js`)) throw new Error("artifacts");
    const scanned = new Bun.Transpiler({ loader: "js" }).scan(source);
    if (!scanned.exports.includes("default") || scanned.imports.some(item => !isBuiltin(item.path) && item.path !== "toonflow:node-zod")) throw new Error("imports");
  } catch {
    invalid("节点后端元数据、默认导出或依赖无效，请使用 v2 节点脚手架生成自包含的 .node.js 文件");
  }
  return metadata;
}

export function validateNodeExecutionPair(source: string, revision: string) {
  try {
    const header = source.match(/^\/\*! toonflowNode:([^\r\n]*) \*\/(?:\r?\n|$)/)?.[1];
    const metadata = JSON.parse(header ?? "");
    if (metadata.protocolVersion !== 2 || metadata.executionRevision !== revision) throw new Error("pair");
  } catch { invalid("节点界面与后端执行产物未配对，请安装同一构建的完整节点包", 409); }
}

async function readArtifact(path: string) {
  const file = await lstat(path);
  if (!file.isFile() || file.isSymbolicLink() || file.size < 1 || file.size > packageLimit) invalid("节点后端必须为不超过 20 MB 的普通文件");
  const content = await readFile(path);
  if (content.byteLength > packageLimit) invalid("节点后端不能超过 20 MB", 413);
  return { content, revision: createHash("sha256").update(content).digest("hex") };
}

export async function configureBuiltinNodeExecutions(nodesRoot?: string) {
  apply(mapClear, builtinHashes, []);
  if (!nodesRoot) return;
  const root = await realpath(nodesRoot).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (!root) return;
  const files = await readdir(root, { withFileTypes: true });
  for (const file of files) {
    if (!file.isFile() || !/^[a-z][a-zA-Z0-9]*\.node\.js$/.test(file.name)) continue;
    const name = file.name.slice(0, -8);
    const artifact = await readArtifact(resolve(root, file.name));
    const metadata = parseNodeExecution(artifact.content.toString("utf8"), name);
    for (const [fileName, revision] of Object.entries(metadata.artifacts)) {
      if ((await readArtifact(resolve(root, fileName))).revision !== revision) invalid(`官方节点配套产物校验失败：${fileName}`, 409);
    }
    apply(mapSet, builtinHashes, [name, artifact.revision]);
  }
}

async function archiveArtifact(name: string, content: Buffer, revision: string) {
  const directory = resolve(revisionsDirectory, name);
  await mkdir(directory, { recursive: true });
  if (!isWithin(await realpath(revisionsDirectory), await realpath(directory)) || (await lstat(revisionsDirectory)).isSymbolicLink() || (await lstat(directory)).isSymbolicLink()) invalid("节点执行归档目录无效", 403);
  const path = resolve(directory, `r${revision}.node.js`);
  // 使用已有完整临时文件 + exclusive link，避免并发加载读到半写入归档。
  await writeWorkspaceFile(path, content, true).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "EEXIST") throw error;
  });
  if ((await readArtifact(path)).revision !== revision) invalid("节点执行归档校验失败", 409);
  return path;
}

async function archiveCompanionArtifacts(name: string, revision: string, artifacts: Record<string, string>, sourceDirectory?: string) {
  const entries = Object.entries(artifacts);
  if (!entries.length) return;
  const directory = resolve(revisionsDirectory, name, `r${revision}`);
  if (sourceDirectory) await mkdir(directory, { recursive: true });
  const actualDirectory = await realpath(directory).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") invalid("固定版本节点的配套产物不可用，请恢复原完整节点包", 409);
    throw error;
  });
  if (!isWithin(await realpath(revisionsDirectory), actualDirectory) || (await lstat(directory)).isSymbolicLink()) invalid("节点配套产物归档目录无效", 403);
  for (const [fileName, expectedRevision] of entries) {
    const path = resolve(directory, fileName);
    const archived = await readArtifact(path).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (archived) {
      if (archived.revision !== expectedRevision) invalid(`固定版本节点配套产物校验失败：${fileName}`, 409);
      continue;
    }
    if (!sourceDirectory) invalid(`固定版本节点配套产物缺失：${fileName}`, 409);
    const artifact = await readArtifact(resolve(sourceDirectory, fileName)).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") invalid(`节点声明的配套产物缺失：${fileName}`, 409);
      throw error;
    });
    if (artifact.revision !== expectedRevision) invalid(`节点配套产物版本不匹配：${fileName}`, 409);
    await writeWorkspaceFile(path, artifact.content, true).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "EEXIST") throw error;
    });
    if ((await readArtifact(path)).revision !== expectedRevision) invalid(`节点配套产物归档校验失败：${fileName}`, 409);
  }
}

export async function retainNodeExecutionRevision(name: string) {
  nodeNameSchema.parse(name);
  let artifact: Awaited<ReturnType<typeof readArtifact>>;
  try { artifact = await readArtifact(resolve(nodesDirectory, `${name}.node.js`)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
  const metadata = parseNodeExecution(artifact.content.toString("utf8"), name);
  await archiveArtifact(name, artifact.content, artifact.revision);
  await archiveCompanionArtifacts(name, artifact.revision, metadata.artifacts, nodesDirectory);
  return artifact.revision;
}

function validateDefinition(definition: NodeExecutionDefinition, name: string) {
  const parsed = definitionSchema.parse(definition);
  if (parsed.name !== name) invalid("节点后端名称与文件名不一致");
  const handleNames = parsed.handles.map(handle => `${handle.type}:${handle.id}`);
  if (new Set(handleNames).size !== handleNames.length || new Set(parsed.actions.map(action => action.name)).size !== parsed.actions.length) invalid("节点后端存在重复端口或动作");
  for (const action of definition.actions) {
    // 不依赖 Zod instanceof；共享宿主或兼容 parse/toJSONSchema 的模块均可校验。
    if (!action.parameters || typeof action.parameters.parse !== "function") invalid(`节点动作 ${action.name} 缺少参数校验`);
    z.toJSONSchema(action.parameters, { io: "input" });
    freeze(action);
  }
  for (const key of ["initialize", "remove", "migrate", "readOutputs", "validateConnection"] as const) {
    if (definition[key] !== undefined && typeof definition[key] !== "function") invalid(`节点后端 ${key} 无效`);
  }
  freeze(definition.actions);
  freeze(definition);
  return definition;
}

export async function loadNodeExecution(name: string, expectedRevision?: string): Promise<LoadedNodeExecution> {
  nodeNameSchema.parse(name);
  if (expectedRevision !== undefined) revisionSchema.parse(expectedRevision);
  const keyPrefix = `${name}:`;
  if (!expectedRevision) {
    const disabled = await lstat(resolve(nodesDirectory, `${name}.disabled`)).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (disabled) invalid("节点已禁用", 409);
  }
  let path: string;
  let revision = expectedRevision;
  if (revision) {
    path = resolve(revisionsDirectory, name, `r${revision}.node.js`);
    const archived = await lstat(path).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (archived) {
      const actual = await realpath(path);
      const artifact = await readArtifact(path);
      if (!isWithin(await realpath(revisionsDirectory), actual) || artifact.revision !== revision) invalid("固定版本节点执行产物校验失败", 409);
      const metadata = parseNodeExecution(artifact.content.toString("utf8"), name);
      await archiveCompanionArtifacts(name, revision, metadata.artifacts);
    } else {
      const artifact = await readArtifact(resolve(nodesDirectory, `${name}.node.js`));
      if (artifact.revision !== revision) invalid("固定版本节点执行产物不可用，请保留旧版包后恢复任务", 409);
      const metadata = parseNodeExecution(artifact.content.toString("utf8"), name);
      path = await archiveArtifact(name, artifact.content, revision);
      await archiveCompanionArtifacts(name, revision, metadata.artifacts, nodesDirectory);
    }
  } else {
    let artifact: Awaited<ReturnType<typeof readArtifact>>;
    try { artifact = await readArtifact(resolve(nodesDirectory, `${name}.node.js`)); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") invalid("旧节点仅有 Vue 界面，需迁移后端执行模块", 409);
      throw error;
    }
    revision = artifact.revision;
    const metadata = parseNodeExecution(artifact.content.toString("utf8"), name);
    const ui = await readArtifact(resolve(nodesDirectory, `${name}.umd.js`));
    validateNodeExecutionPair(ui.content.toString("utf8"), revision);
    path = await archiveArtifact(name, artifact.content, revision);
    await archiveCompanionArtifacts(name, revision, metadata.artifacts, nodesDirectory);
  }
  const key = keyPrefix + revision;
  let promise = loaded.get(key);
  if (!promise) {
    const pinnedRevision = revision;
    promise = (async () => {
      // 安装的节点后端与现有服务端工具一样是可信代码，不是沙箱。
      const module = await import(pathToFileURL(path).href) as { default: NodeExecutionDefinition };
      const definition = validateDefinition(module.default, name);
      const builtin = apply(mapGet, builtinHashes, [name]) === pinnedRevision;
      const result = { definition, revision: pinnedRevision, builtin };
      apply(mapSet, loadedDefinitions, [key, result]);
      return result;
    })();
    loaded.set(key, promise);
    promise.catch(() => { if (loaded.get(key) === promise) loaded.delete(key); });
  }
  const result = await promise;
  // 重新配置官方构建后，旧缓存不能保留已撤销的可信来源。
  const builtin = apply(mapGet, builtinHashes, [name]) === result.revision;
  if (builtin) for (const action of result.definition.actions) apply(weakMapSet, builtinHandlers, [action.execute, { name, action: action.name, revision: result.revision }]);
  return { ...result, builtin };
}

export async function getNodeExecutionArtifact(name: string, revision: string, fileName: string): Promise<{ path: string; revision: string }> {
  nodeNameSchema.parse(name);
  revisionSchema.parse(revision);
  await loadNodeExecution(name, revision);
  const execution = await readArtifact(resolve(revisionsDirectory, name, `r${revision}.node.js`));
  const metadata = parseNodeExecution(execution.content.toString("utf8"), name);
  const expectedRevision = Object.hasOwn(metadata.artifacts, fileName) ? metadata.artifacts[fileName] : undefined;
  if (!expectedRevision) invalid("节点执行版本未声明此配套产物", 404);
  const path = resolve(revisionsDirectory, name, `r${revision}`, fileName);
  if ((await readArtifact(path)).revision !== expectedRevision) invalid("节点配套产物校验失败", 409);
  return { path, revision: expectedRevision };
}

export function isBuiltinNodeExecutionAction(name: string, action: NodeExecutionAction, revision: string) {
  if (!action || typeof action.execute !== "function" || apply(mapGet, builtinHashes, [name]) !== revision) return false;
  const proof = apply(weakMapGet, builtinHandlers, [action.execute]) as { name: string; action: string; revision: string } | undefined;
  return proof?.name === name && proof.action === action.name && proof.revision === revision;
}

export function isBuiltinNodeExecutionTool(name: string, actionName: string, revision: string) {
  const execution = apply(mapGet, loadedDefinitions, [`${name}:${revision}`]) as LoadedNodeExecution | undefined;
  const action = execution?.definition.actions.find(item => item.name === actionName);
  if (!action || !isBuiltinNodeExecutionAction(name, action, revision)) return false;
  let file: number | undefined;
  try {
    const root = realpathSync(nodesDirectory);
    const path = realpathSync(resolve(root, `${name}.node.js`));
    if (!isWithin(root, path)) return false;
    file = openSync(path, "r");
    const info = fstatSync(file);
    if (!info.isFile() || info.size < 1 || info.size > packageLimit) return false;
    const content = Buffer.alloc(info.size + 1);
    let offset = 0;
    while (offset < content.length) {
      const count = readSync(file, content, offset, content.length - offset, offset);
      if (!count) break;
      offset += count;
    }
    return offset === info.size && createHash("sha256").update(content.subarray(0, offset)).digest("hex") === revision;
  } catch { return false; }
  finally { if (file !== undefined) closeSync(file); }
}

export async function getNodeExecutionDescriptor(name: string): Promise<NodeExecutionDescriptor | undefined> {
  nodeNameSchema.parse(name);
  const file = await lstat(resolve(nodesDirectory, `${name}.node.js`)).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (!file) return;
  const { definition, revision } = await loadNodeExecution(name);
  return {
    protocolVersion: 2,
    name,
    executionRevision: revision,
    stateVersion: definition.stateVersion,
    handles: structuredClone(definition.handles),
    defaultData: structuredClone(definition.defaultData),
    layoutSize: { ...definition.layoutSize },
    actions: definition.actions.map(action => ({ name: action.name, description: action.description, parameters: z.toJSONSchema(action.parameters, { io: "input" }) })),
  };
}

export async function listNodeExecutions(): Promise<NodeExecutionDescriptor[]> {
  const files = await readdir(nodesDirectory, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  const disabled = new Set(files.filter(file => file.name.endsWith(".disabled")).map(file => file.name.slice(0, -9)));
  const descriptors = await Promise.all(files.filter(file => file.isFile() && /^[a-z][a-zA-Z0-9]*\.node\.js$/.test(file.name) && !disabled.has(file.name.slice(0, -8)))
    .sort((left, right) => left.name.localeCompare(right.name))
    .map(file => getNodeExecutionDescriptor(file.name.slice(0, -8)).catch(error => {
      // 元数据接口逐节点报告 loadError；损坏插件不能阻止其余节点注册。
      console.warn(`节点后端无法注册：${file.name}`, error);
      return undefined;
    })));
  return descriptors.filter((descriptor): descriptor is NodeExecutionDescriptor => descriptor !== undefined);
}
