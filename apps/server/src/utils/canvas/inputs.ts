import { mkdir, readFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { NodeExecutionContext, NodeExecutionSnapshot } from "@toonflow/nodes-scaffold/execution";
import type { NodeInputValue } from "@toonflow/nodes-scaffold/values";
import { getTargetValues } from "@toonflow/nodes-scaffold/inputValues";
import { readGraph } from "@/utils/workspace/graph";
import { resolveWorkspacePath, writeWorkspaceFile } from "@/utils/workspace/files";
import { loadNodeExecution } from "@/utils/plugins/nodeExecution";
import { readNode, getNodeConfig } from "@/utils/plugins/nodes";
import { readVersionedContent } from "@/utils/canvas/content";
import conf from "@/utils/conf";

type Graph = Awaited<ReturnType<typeof readGraph>>;
type Node = Graph["nodes"][number];
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
export async function captureNodeInputs(directory: string, canvasPath: string, graph: Graph, nodeId: string, revision?: string, actionName?: string): Promise<NodeInputSnapshot> {
  const target = graph.nodes.find(node => node.id === nodeId);
  if (!target) throw Object.assign(new Error("目标节点不存在"), { status: 404 });
  const loaded = await loadNodeExecution((target.type ?? "").replace(/^remote-/, ""), revision);
  const capturedInputs = loaded.definition.actions.find(action => `node:${action.name}` === actionName)?.snapshotInputs !== false;
  const result: NodeInputSnapshot = { node: nodeSnapshot(graph, target), revision: loaded.revision, config: getNodeConfig(await readNode(loaded.definition.name)), inputs: {}, texts: {}, files: {}, directory: join(dirname(conf.path), "nodeInputs", crypto.randomUUID()), capturedInputs };
  if (!capturedInputs) return result;
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
      await captureInputFile(result, directory, input.value.url);
    }
  }
  return result;
}
