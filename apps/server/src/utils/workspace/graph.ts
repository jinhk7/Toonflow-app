import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { isTypeCompatible } from "@toonflow/nodes-scaffold/connection";
import { lockWorkspaceFiles, writeWorkspaceFile } from "@/utils/workspace/files";
import { resolve } from "node:path";

type Item = { id: string; type?: string; parentNode?: string; data?: { handles?: { id: string; type: "source" | "target"; dataType: string | string[] }[]; outputs?: Record<string, unknown>; [key: string]: unknown }; [key: string]: unknown };
type Edge = Item & { source: string; target: string; sourceHandle?: string; targetHandle?: string };
type Graph = { toonflowCanvas: true; nodes: Item[]; edges: Edge[]; viewport: { x: number; y: number; zoom: number }; toonflowGraph?: GraphState; [key: string]: unknown };
type GraphState = { id: string; revision: number; nodes: Record<string, number>; edges: Record<string, number>; outputs: Record<string, number>; viewport: number; receipts: Record<string, { digest: string; revision: number }> };
export type GraphChange = { kind: "node" | "edge"; id: string; expectedVersion: number; dependencies?: Record<string, number>; value: Item | Edge | null } | { kind: "output"; nodeId: string; slot: string; expectedVersion: number; expectedNodeVersion?: number; value: unknown } | { kind: "viewport"; expectedVersion: number; value: Graph["viewport"] };

function invalid(message: string, status = 400): never {
  throw Object.assign(new Error(message), { status });
}
function validItem(value: unknown): value is Item {
  return !!value && typeof value === "object" && !Array.isArray(value) && typeof (value as Item).id === "string" && !!(value as Item).id;
}
function validViewport(value: unknown): value is Graph["viewport"] {
  if (!value || typeof value !== "object") return false;
  const viewport = value as Graph["viewport"];
  return [viewport.x, viewport.y, viewport.zoom].every(Number.isFinite) && viewport.zoom > 0;
}
function parseGraph(content: string): Graph {
  const graph: unknown = JSON.parse(content);
  if (!graph || typeof graph !== "object" || (graph as Graph).toonflowCanvas !== true
    || !Array.isArray((graph as Graph).nodes) || !(graph as Graph).nodes.every(validItem)
    || !Array.isArray((graph as Graph).edges) || !(graph as Graph).edges.every(validItem)
    || !validViewport((graph as Graph).viewport)) invalid("画布文件格式无效");
  return graph as Graph;
}
function state(graph: Graph): GraphState {
  if (graph.toonflowGraph) {
    const meta = graph.toonflowGraph;
    if (!meta.id || !Number.isSafeInteger(meta.revision) || !meta.nodes || !meta.edges || !meta.receipts) invalid("画布版本元数据无效");
    meta.outputs ??= {};
    return meta;
  }
  return { id: crypto.randomUUID(), revision: 0,
    nodes: Object.fromEntries(graph.nodes.map(item => [item.id, 1])),
    edges: Object.fromEntries(graph.edges.map(item => [item.id, 1])), outputs: {}, viewport: 1, receipts: {} };
}
function validateGraph(graph: Graph) {
  const nodes = new Map(graph.nodes.map(node => [node.id, node]));
  if (nodes.size !== graph.nodes.length || new Set(graph.edges.map(edge => edge.id)).size !== graph.edges.length) invalid("画布元素 ID 重复");
  for (const node of graph.nodes) {
    const seen = new Set([node.id]);
    let parent = node.parentNode;
    while (parent) {
      if (seen.has(parent) || !nodes.has(parent) || nodes.get(parent)?.type !== "canvasGroup") invalid("分组归属无效或形成循环");
      seen.add(parent);
      parent = nodes.get(parent)?.parentNode;
    }
  }
  for (const edge of graph.edges) {
    const source = nodes.get(edge.source);
    const target = nodes.get(edge.target);
    if (!source || !target || source === target) invalid("连接端点不存在或自连接");
    const sourceHandle = source.data?.handles?.find(handle => handle.id === edge.sourceHandle && handle.type === "source");
    const targetHandle = target.data?.handles?.find(handle => handle.id === edge.targetHandle && handle.type === "target");
    if (!sourceHandle || !targetHandle || !isTypeCompatible(sourceHandle.dataType, targetHandle.dataType)) invalid("端口不存在、方向错误或类型不相容");
  }
}

export async function readGraphUnlocked(path: string) {
  const graph = parseGraph(await readFile(path, "utf8"));
  if (!graph.toonflowGraph) {
    graph.toonflowGraph = state(graph);
    await writeWorkspaceFile(path, JSON.stringify(graph, null, 2) + String.fromCharCode(10));
  }
  return graph;
}
// 同一画布的独立节点写入等待前一次落盘，真正的实体冲突仍由版本号判断。
const pendingGraphs = new Map<string, Promise<void>>();
async function serializeGraph<T>(path: string, action: () => Promise<T>): Promise<T> {
  const key = process.platform === "win32" ? resolve(path).toLowerCase() : resolve(path);
  const previous = pendingGraphs.get(key);
  let done!: () => void;
  const current = new Promise<void>(resolveDone => { done = resolveDone; });
  pendingGraphs.set(key, current);
  if (previous) await previous;
  try { return await action(); }
  finally {
    if (pendingGraphs.get(key) === current) pendingGraphs.delete(key);
    done();
  }
}

export async function readGraph(path: string) {
  return serializeGraph(path, async () => {
    const release = lockWorkspaceFiles([path]);
  try { return await readGraphUnlocked(path); }
  finally { release(); }
  });
}

export async function modifyGraph(path: string, operationId: string, changes: GraphChange[]) {
  if (!operationId || operationId.length > 100 || !changes.length || changes.length > 500) invalid("画布操作参数无效");
  return serializeGraph(path, async () => {
    const release = lockWorkspaceFiles([path]);
  try {
    const graph = parseGraph(await readFile(path, "utf8"));
    graph.toonflowGraph = state(graph);
    const meta = graph.toonflowGraph!;
    const digest = createHash("sha256").update(JSON.stringify(changes)).digest("hex");
    const receipt = meta.receipts[operationId];
    if (receipt) {
      if (receipt.digest !== digest) invalid("操作 ID 已用于其他内容", 409);
      return graph;
    }
    const originalNodeVersions = { ...meta.nodes };
    const originalNodes = new Map(graph.nodes.map(node => [node.id, node]));
    const originalEdges = new Map(graph.edges.map(edge => [edge.id, edge]));
    const touched = new Set<string>();
    for (const change of changes) {
      const key = change.kind === "viewport" ? "viewport" : change.kind === "output" ? JSON.stringify([change.nodeId, change.slot]) : `${change.kind}:${change.id}`;
      if (change.kind === "node" || change.kind === "edge") {
        const related = change.kind === "edge"
          ? [change.value ? (change.value as Edge).source : originalEdges.get(change.id)?.source,
            change.value ? (change.value as Edge).target : originalEdges.get(change.id)?.target]
          : [originalNodes.get(change.id)?.parentNode, change.value?.parentNode];
        for (const id of new Set(related.filter((id): id is string => typeof id === "string" && !!id))) {
          if (change.dependencies?.[id] !== (originalNodeVersions[id] ?? 0)) invalid(`版本冲突：依赖节点 ${id} 已变化或未声明`, 409);
        }
      }
      if (touched.has(key)) invalid("同一操作不能重复修改同一元素");
      touched.add(key);
      const current = change.kind === "viewport" ? meta.viewport : change.kind === "output" ? meta.outputs[key] ?? 0 : meta[change.kind === "node" ? "nodes" : "edges"][change.id] ?? 0;
      if (current !== change.expectedVersion) invalid(`画布版本冲突：${key}，当前版本 ${current}`, 409);
      if (change.kind === "viewport") {
        if (!validViewport(change.value)) invalid("视口参数无效");
        graph.viewport = change.value;
        meta.viewport++;
      } else if (change.kind === "output") {
        const node = graph.nodes.find(item => item.id === change.nodeId);
        if (change.expectedNodeVersion !== undefined && meta.nodes[change.nodeId] !== change.expectedNodeVersion)
          invalid("节点已变化，不能关联过期任务结果", 409);
        if (!node || !change.slot || change.slot.length > 255) invalid("输出槽位或节点无效", 409);
        (node.data ??= {}).outputs ??= {};
        if (change.value === null) delete node.data.outputs[change.slot];
        else node.data.outputs[change.slot] = change.value;
        meta.outputs[key] = current + 1;
      } else {
        const items = change.kind === "node" ? graph.nodes : graph.edges;
        const versions = change.kind === "node" ? meta.nodes : meta.edges;
        const index = items.findIndex(item => item.id === change.id);
        if (change.value !== null && (!validItem(change.value) || change.value.id !== change.id)) invalid("元素 ID 无效");
        if (change.value === null) {
          if (index < 0) invalid("元素不存在", 409);
          items.splice(index, 1);
        } else if (index < 0) items.push(change.value as Edge);
        else {
          const value = change.value as Item;
          const previous = items[index] as Item;
          if (change.kind === "node" && previous.data?.outputs) value.data = { ...value.data, outputs: previous.data.outputs };
          items[index] = value as Edge;
        }
        versions[change.id] = current + 1;
      }
    }
    validateGraph(graph);
    meta.revision++;
    meta.receipts[operationId] = { digest, revision: meta.revision };
    await writeWorkspaceFile(path, `${JSON.stringify(graph, null, 2)}\n`);
    return graph;
  } finally { release(); }
  });
}
