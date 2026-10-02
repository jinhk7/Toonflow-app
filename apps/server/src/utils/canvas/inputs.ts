import { lstat, mkdir, readFile, readdir, rm, stat } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import type { NodeExecutionContext, NodeExecutionSnapshot } from "@toonflow/nodes-scaffold/execution";
import type { NodeInputValue } from "@toonflow/nodes-scaffold/values";
import { getTargetValues } from "@toonflow/nodes-scaffold/inputValues";
import { readGraph } from "@/utils/workspace/graph";
import { resolveWorkspacePath, writeWorkspaceFile } from "@/utils/workspace/files";
import { loadNodeExecution } from "@/utils/plugins/nodeExecution";
import { readNode, getNodeConfig } from "@/utils/plugins/nodes";
import { readVersionedContent } from "@/utils/canvas/content";
import conf from "@/utils/conf";
import { hasPendingInputSnapshot } from "@/utils/canvas/store";

type Graph = Awaited<ReturnType<typeof readGraph>>;
type Node = Graph["nodes"][number];
const activeSnapshots = new Set<string>();
const snapshotName = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export type NodeInputSnapshot = {
  node: NodeExecutionSnapshot;
  revision: string;
  config: Record<string, unknown>;
  inputs: Record<string, NodeInputValue[]>;
  texts: Record<string, { content: string; revision: string; exists?: boolean }>;
  files: Record<string, string>;
  directory: string;
  capturedInputs: boolean;
};

export async function discardNodeInputs(snapshot?: Pick<NodeInputSnapshot, "directory">) {
  if (!snapshot) return;
  const root = resolve(dirname(conf.path), "nodeInputs");
  const path = resolve(snapshot.directory);
  try {
    if (dirname(path) !== root || !snapshotName.test(basename(path))) throw new Error("输入快照清理路径无效");
    if (hasPendingInputSnapshot(snapshot.directory)) return;
    const info = await lstat(path).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; });
    if (!info) return;
    if (!info.isDirectory() || info.isSymbolicLink() || (await lstat(root)).isSymbolicLink()) throw new Error("输入快照清理目录无效");
    await rm(path, { recursive: true, force: true });
  } catch (error) {
    // 已保存的命令结果不能因清理失败回退；下次启动继续回收孤立副本。
    console.error("输入快照清理失败，已保留待下次启动回收", error);
  } finally { activeSnapshots.delete(path); }
}

export async function pruneNodeInputs(retained: string[]) {
  const root = resolve(dirname(conf.path), "nodeInputs");
  const keep = new Set(retained.map(path => resolve(path)));
  const entries = await readdir(root, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory() && snapshotName.test(entry.name) && !keep.has(path) && !activeSnapshots.has(path)) await discardNodeInputs({ directory: path });
  }
}

export async function captureInputFile(snapshot: NodeInputSnapshot, directory: string, relativePath: string) {
  if (snapshot.files[relativePath]) return snapshot.files[relativePath]!;
  const { path } = await resolveWorkspacePath(directory, relativePath);
  const info = await stat(path);
  if (!info.isFile() || !info.size || info.size > 100 * 1024 * 1024) throw Object.assign(new Error("输入素材须为不超过 100 MB 的有效文件"), { status: 400 });
  const bytes = await readFile(path);
  if (!bytes.length || bytes.length > 100 * 1024 * 1024) throw Object.assign(new Error("输入素材为空或超过 100 MB"), { status: 400 });
  await mkdir(snapshot.directory, { recursive: true });
  const name = String(Object.keys(snapshot.files).length);
  await writeWorkspaceFile(join(snapshot.directory, name), bytes, true);
  snapshot.files[relativePath] = name;
  return name;
}

function nodeSnapshot(graph: Graph, node: Node): NodeExecutionSnapshot {
  return { id: node.id, type: node.type ?? "", position: node.position as { x: number; y: number }, data: structuredClone(node.data ?? {}), parentNode: node.parentNode, version: graph.toonflowGraph!.nodes[node.id] ?? 0 };
}

// ACT: 只派生目标节点的直接输入；不运行动作、不改变图，也不要求挂载任何 UI。
export async function captureNodeInputs(directory: string, canvasPath: string, graph: Graph, nodeId: string, revision?: string, actionName?: string, copyFiles = true): Promise<NodeInputSnapshot> {
  const target = graph.nodes.find(node => node.id === nodeId);
  if (!target) throw Object.assign(new Error("目标节点不存在"), { status: 404 });
  const loaded = await loadNodeExecution((target.type ?? "").replace(/^remote-/, ""), revision);
  const capturedInputs = loaded.definition.actions.find(action => `node:${action.name}` === actionName)?.snapshotInputs !== false;
  const result: NodeInputSnapshot = { node: nodeSnapshot(graph, target), revision: loaded.revision, config: getNodeConfig(await readNode(loaded.definition.name)), inputs: {}, texts: {}, files: {}, directory: join(dirname(conf.path), "nodeInputs", crypto.randomUUID()), capturedInputs };
  if (!capturedInputs) return result;
  if (copyFiles) activeSnapshots.add(resolve(result.directory));
  try {
    const copy = structuredClone(graph);
    const sources = new Set(copy.edges.filter(edge => edge.target === nodeId).map(edge => edge.source));
    sources.add(nodeId);
    const unavailable = () => { throw new Error("readOutputs 只能读取节点状态"); };
    for (const id of sources) {
      const node = copy.nodes.find(item => item.id === id);
      if (!node || node.type === "canvasGroup") continue;
      const source = id === nodeId ? loaded : await loadNodeExecution((node.type ?? "").replace(/^remote-/, ""));
      if (!source.definition.readOutputs) continue;
      const context: NodeExecutionContext = {
        directory, canvasPath, commandId: "readOutputs", revision: source.revision,
        node: nodeSnapshot(copy, node), config: getNodeConfig(await readNode(source.definition.name)), signal: new AbortController().signal,
        async readText(path) { return result.texts[path] ??= await readVersionedContent(directory, path); },
        async read(path) { return new Uint8Array(await readFile((await resolveWorkspacePath(directory, path)).path)); },
        async getInputs(handleId) { return getTargetValues(id, handleId, copy.nodes as Parameters<typeof getTargetValues>[2], copy.edges); },
        writeText: unavailable, write: unavailable, patchData: unavailable, setOutput: unavailable,
        runJob: unavailable, getJob: unavailable, waitForJob: unavailable,
        getModels: unavailable, cancelJob: unavailable, getMediaJob: unavailable, retryMediaCollection: unavailable,
      };
      node.data = { ...node.data, outputs: { ...node.data?.outputs, ...await source.definition.readOutputs(context) } };
    }
    for (const handle of loaded.definition.handles.filter(item => capturedInputs && item.type === "target")) {
      const values = getTargetValues(nodeId, handle.id, copy.nodes as Parameters<typeof getTargetValues>[2], copy.edges);
      result.inputs[handle.id] = values;
      for (const input of values) {
        if (!input.value || typeof input.value !== "object" || !("url" in input.value) || typeof input.value.url !== "string" || result.files[input.value.url]) continue;
        if (copyFiles) await captureInputFile(result, directory, input.value.url);
      }
    }
    return result;
  } catch (error) {
    await discardNodeInputs(result);
    throw error;
  }
}
