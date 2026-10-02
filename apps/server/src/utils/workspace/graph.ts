import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, relative, resolve } from "node:path";
import type { NodeExecutionSnapshot } from "@toonflow/nodes-scaffold/execution";
import { isTypeCompatible } from "@toonflow/nodes-scaffold/connection";
import { isNodeOutput } from "@toonflow/nodes-scaffold/values";
import { lockWorkspaceFiles, resolveWorkspacePath, writeWorkspaceFile } from "@/utils/workspace/files";
import { loadNodeExecution } from "@/utils/plugins/nodeExecution";
import { acceptGraphWrite, completeGraphWrite, getGraphWrite, getWorkspaceCursor, listIncompleteGraphWrites, markGraphWriteApplied, requestDigest } from "@/utils/canvas/store";

type Item = { id: string; type?: string; parentNode?: string; data?: { handles?: { id: string; type: "source" | "target"; dataType: string | string[] }[]; outputs?: Record<string, unknown>; [key: string]: unknown }; [key: string]: unknown };
type Edge = Item & { source: string; target: string; sourceHandle?: string; targetHandle?: string };
type Graph = { toonflowCanvas: true; nodes: Item[]; edges: Edge[]; viewport: { x: number; y: number; zoom: number }; toonflowGraph?: GraphState; [key: string]: unknown };
type GraphState = { id: string; revision: number; nodes: Record<string, number>; edges: Record<string, number>; outputs: Record<string, number>; viewport: number; receipts: Record<string, { digest: string; revision: number }> };
export type GraphChange = { kind: "node" | "edge"; id: string; expectedVersion: number; dependencies?: Record<string, number>; value: Item | Edge | null } | { kind: "output"; nodeId: string; slot: string; expectedVersion: number; pendingJobKey?: string; value: unknown } | { kind: "viewport"; expectedVersion: number; value: Graph["viewport"] };

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
// ACT: 只校验本次改动及其相连的元素，旧画布里未改动的历史坏边不阻塞其他编辑。
async function validateGraph(graph: Graph, changedNodes: Set<string>, connectionNodes: Set<string>, changedEdges: Set<string>, changes: GraphChange[]) {
  const nodes = new Map(graph.nodes.map(node => [node.id, node]));
  const definitions = new Map<string, Awaited<ReturnType<typeof loadNodeExecution>>>();
  const definitionFor = async (node: Item) => {
    if (node.type === "canvasGroup") invalid("分组没有执行端口或输出");
    let loaded = definitions.get(node.id);
    if (!loaded) {
      if (typeof node.type !== "string") invalid("节点类型无效");
      const revision = node.data?.executionRevision;
      loaded = await loadNodeExecution(node.type.startsWith("remote-") ? node.type.slice(7) : node.type,
        typeof revision === "string" ? revision : undefined);
      definitions.set(node.id, loaded);
    }
    return loaded.definition;
  };
  const validateOutput = async (node: Item, slot: string, output: unknown) => {
    const definition = await definitionFor(node);
    const handle = definition.handles.find(item => item.id === slot && item.type === "source");
    if (!handle || (output !== null && (!isNodeOutput(output) || !isTypeCompatible(output.dataType, handle.dataType))))
      invalid("输出槽位、值或类型不符合节点后端定义");
  };
  if (nodes.size !== graph.nodes.length || new Set(graph.edges.map(edge => edge.id)).size !== graph.edges.length) invalid("画布元素 ID 重复");
  for (const node of graph.nodes) {
    if (!changedNodes.has(node.id) && !(node.parentNode && changedNodes.has(node.parentNode))) continue;
    const seen = new Set([node.id]);
    let parent = node.parentNode;
    while (parent) {
      if (seen.has(parent) || !nodes.has(parent) || nodes.get(parent)?.type !== "canvasGroup") invalid("分组归属无效或形成循环");
      seen.add(parent);
      parent = nodes.get(parent)?.parentNode;
    }
  }
  for (const change of changes) {
    if (change.kind === "output") {
      const node = nodes.get(change.nodeId);
      if (!node) invalid("输出节点不存在", 409);
      await validateOutput(node, change.slot, change.value);
    } else if (change.kind === "node" && change.value && change.expectedVersion === 0) {
      const node = nodes.get(change.id)!;
      for (const [slot, output] of Object.entries(node.data?.outputs ?? {})) await validateOutput(node, slot, output);
    }
  }
  for (const edge of graph.edges) {
    if (!changedEdges.has(edge.id) && !connectionNodes.has(edge.source) && !connectionNodes.has(edge.target)) continue;
    const source = nodes.get(edge.source);
    const target = nodes.get(edge.target);
    if (!source || !target || source === target) invalid("连接端点不存在或自连接");
    const sourceDefinition = await definitionFor(source);
    const targetDefinition = await definitionFor(target);
    const sourceHandle = sourceDefinition.handles.find(handle => handle.id === edge.sourceHandle && handle.type === "source");
    const targetHandle = targetDefinition.handles.find(handle => handle.id === edge.targetHandle && handle.type === "target");
    if (!sourceHandle || !targetHandle || !isTypeCompatible(sourceHandle.dataType, targetHandle.dataType)) invalid("端口不存在、方向错误或类型不相容");
    if (targetDefinition.validateConnection) {
      const snapshot = (node: Item): NodeExecutionSnapshot => ({
        id: node.id, type: node.type ?? "", position: structuredClone(node.position) as NodeExecutionSnapshot["position"],
        data: structuredClone(node.data ?? {}), parentNode: node.parentNode, version: graph.toonflowGraph!.nodes[node.id] ?? 0,
      });
      const request = { source: snapshot(source), sourceHandle: sourceHandle.id, target: snapshot(target), targetHandle: targetHandle.id,
        nodes: graph.nodes.map(snapshot), edges: structuredClone(graph.edges) };
      if (targetDefinition.validateConnection(request) !== true) invalid("节点连接业务校验失败");
    }
  }
}

function contentHash(content: string) { return createHash("sha256").update(content).digest("hex"); }

function graphRelativePath(path: string, directory: string) {
  const value = relative(directory, path).replaceAll("\\", "/");
  return process.platform === "win32" ? value.toLowerCase() : value;
}

function graphWriteEvent(write: NonNullable<ReturnType<typeof getGraphWrite>>) {
  const result = write.result as { canvasId: string; revision: number };
  return { type: "graphChanged" as const, payload: { path: write.path, revision: result.revision },
    target: { commandId: write.operationId, canvasId: result.canvasId } };
}

async function recoverGraphWrite(write: NonNullable<ReturnType<typeof getGraphWrite>>) {
  if (write.status === "completed") return;
  if (write.status !== "written") {
    const { path } = await resolveWorkspacePath(write.directory, write.path);
    const currentHash = contentHash(await readFile(path, "utf8"));
    if (currentHash !== write.afterHash) {
      if (currentHash !== write.beforeHash) invalid("画布写入结果需要核对，未覆盖后来修改", 409);
      await writeWorkspaceFile(path, write.content);
    }
    markGraphWriteApplied(write.directory, write.commandId);
  }
  completeGraphWrite(write.directory, write.commandId, graphWriteEvent(write));
}

async function recoverGraphPath(path: string, directory: string, strict = true) {
  const relativePath = graphRelativePath(path, directory);
  for (const write of listIncompleteGraphWrites()) {
    if (write.directory !== directory || write.path !== relativePath) continue;
    try { await recoverGraphWrite(write); }
    catch (error) {
      const persisted = getGraphWrite(write.directory, write.commandId);
      const applied = persisted?.status === "written" || contentHash(await readFile(path, "utf8")) === write.afterHash;
      if (!applied) throw error;
      if (strict) throw Object.assign(new Error("画布已保存或等待核对，通知尚未完成，请稍后重试"), { status: 503, cause: error });
      console.error("画布写入等待恢复", error);
    }
  }
}

async function persistGraph(path: string, directory: string, operationId: string, digest: string, before: string, graph: Graph) {
  const content = `${JSON.stringify(graph, null, 2)}\n`;
  const commandId = `graph:${operationId}`;
  acceptGraphWrite({ directory, commandId, path: graphRelativePath(path, directory), operationId, digest,
    beforeHash: contentHash(before), afterHash: contentHash(content), content,
    result: { canvasId: graph.toonflowGraph!.id, revision: graph.toonflowGraph!.revision } });
  await writeWorkspaceFile(path, content);
  try {
    markGraphWriteApplied(directory, commandId);
    completeGraphWrite(directory, commandId, graphWriteEvent(getGraphWrite(directory, commandId)!));
  } catch (error) {
    // 文件已经原子提交；持久意图保留结果，不把通知故障当成操作未执行。
    console.error("画布已保存，通知等待恢复", error);
  }
}

export async function readGraphUnlocked(path: string, directory = dirname(path), strictNotifications = false) {
  await recoverGraphPath(path, directory, strictNotifications);
  const content = await readFile(path, "utf8");
  const graph = parseGraph(content);
  if (!graph.toonflowGraph) {
    graph.toonflowGraph = state(graph);
    const digest = contentHash(content);
    // 画布身份先随写入意图持久化；恢复复用该身份，同路径新建画布使用独立生命周期。
    await persistGraph(path, directory, `initialize:${graph.toonflowGraph.id}`, digest, content, graph);
  }
  return graph;
}
// ACT: 文件回执只保留最近 1000 次；后端持久意图独立去重，不能因回执淘汰重做已写操作。
const receiptLimit = 1000;
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

export async function readGraph(path: string, directory = dirname(path)) {
  return serializeGraph(path, async () => {
    const release = lockWorkspaceFiles([path]);
  try { return await readGraphUnlocked(path, directory); }
  finally { release(); }
  });
}

export async function readGraphSnapshot(path: string, directory: string) {
  return serializeGraph(path, async () => {
    const release = lockWorkspaceFiles([path]);
    try {
      const graph = await readGraphUnlocked(path, directory, true);
      await recoverGraphPath(path, directory);
      return { graph, cursor: getWorkspaceCursor(directory) };
    }
    finally { release(); }
  });
}

export async function modifyGraph(path: string, operationId: string, changes: GraphChange[], directory?: string) {
  if (!operationId || operationId.length > 100 || !changes.length || changes.length > 500) invalid("画布操作参数无效");
  return serializeGraph(path, async () => {
    const release = lockWorkspaceFiles([path]);
  try {
    const workspaceDirectory = directory ?? dirname(path);
    const digest = requestDigest(changes);
    const knownWrite = getGraphWrite(workspaceDirectory, `graph:${operationId}`);
    if (knownWrite) {
      if (knownWrite.digest !== digest || knownWrite.path !== graphRelativePath(path, workspaceDirectory)) invalid("操作 ID 已用于其他画布或内容", 409);
      await recoverGraphPath(path, workspaceDirectory, false);
      return parseGraph(await readFile(path, "utf8"));
    }
    await recoverGraphPath(path, workspaceDirectory);
    const content = await readFile(path, "utf8");
    const graph = parseGraph(content);
    graph.toonflowGraph = state(graph);
    const meta = graph.toonflowGraph!;
    const receipt = meta.receipts[operationId];
    if (receipt) {
      if (receipt.digest !== digest && receipt.digest !== contentHash(JSON.stringify(changes))) invalid("操作 ID 已用于其他内容", 409);
      return graph;
    }
    const originalNodeVersions = { ...meta.nodes };
    const originalNodes = new Map(graph.nodes.map(node => [node.id, node]));
    const originalEdges = new Map(graph.edges.map(edge => [edge.id, edge]));
    const touched = new Set<string>();
    const connectionNodes = new Set<string>();
    for (const change of changes) {
      const key = change.kind === "viewport" ? "viewport" : change.kind === "output" ? JSON.stringify([change.nodeId, change.slot]) : `${change.kind}:${change.id}`;
      if (change.kind === "node" || change.kind === "edge") {
        for (const [id, version] of Object.entries(change.dependencies ?? {})) {
          if (version !== (originalNodeVersions[id] ?? 0)) invalid(`版本冲突：依赖节点 ${id} 已变化`, 409);
        }
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
      const outputNode = change.kind === "output" ? graph.nodes.find(item => item.id === change.nodeId) : undefined;
      if (change.kind === "output" && change.pendingJobKey !== undefined
        && (outputNode?.data?.pendingMediaJob as { idempotencyKey?: unknown } | undefined)?.idempotencyKey !== change.pendingJobKey)
        invalid("节点已不再等待该任务结果", 409);
      if (current !== change.expectedVersion) {
        // 后台任务与在线节点可能先后写入同一结果，内容相同即视为已完成，不算冲突。
        if (change.kind === "output" && JSON.stringify(outputNode?.data?.outputs?.[change.slot] ?? null) === JSON.stringify(change.value ?? null)) {
          if (change.pendingJobKey !== undefined) delete outputNode!.data!.pendingMediaJob;
          continue;
        }
        invalid(`画布版本冲突：${key}，当前版本 ${current}`, 409);
      }
      if (change.kind === "viewport") {
        if (!validViewport(change.value)) invalid("视口参数无效");
        graph.viewport = change.value;
        meta.viewport++;
      } else if (change.kind === "output") {
        const node = outputNode;
        if (!node || !change.slot || change.slot.length > 255) invalid("输出槽位或节点无效", 409);
        (node.data ??= {}).outputs ??= {};
        if (change.value === null) delete node.data.outputs[change.slot];
        else node.data.outputs[change.slot] = change.value;
        if (change.pendingJobKey !== undefined) delete node.data.pendingMediaJob;
        meta.outputs[key] = current + 1;
        connectionNodes.add(node.id);
      } else {
        const items = change.kind === "node" ? graph.nodes : graph.edges;
        const versions = change.kind === "node" ? meta.nodes : meta.edges;
        const index = items.findIndex(item => item.id === change.id);
        if (change.value !== null && (!validItem(change.value) || change.value.id !== change.id)) invalid("元素 ID 无效");
        if (change.value === null) {
          if (index < 0) invalid("元素不存在", 409);
          items.splice(index, 1);
        } else if (index < 0) {
          const value = structuredClone(change.value) as Item;
          if (change.kind === "node") {
            if (value.data !== undefined && (!value.data || typeof value.data !== "object" || Array.isArray(value.data))) invalid("节点数据无效");
            if (value.type === "canvasGroup") value.data = { ...value.data, handles: [], outputs: {} };
            else {
              if (typeof value.type !== "string") invalid("节点类型无效");
              const revision = value.data?.executionRevision;
              if (revision !== undefined && typeof revision !== "string") invalid("节点执行版本无效");
              const loaded = await loadNodeExecution(value.type.startsWith("remote-") ? value.type.slice(7) : value.type, revision);
              value.data = { ...structuredClone(loaded.definition.defaultData), ...value.data,
                handles: structuredClone(loaded.definition.handles), executionRevision: loaded.revision, stateVersion: loaded.definition.stateVersion };
            }
          }
          items.push(value as Edge);
        }
        else {
          const value = structuredClone(change.value) as Item;
          const previous = items[index] as Item;
          if (change.kind === "node") {
            if (value.type !== previous.type) invalid("节点类型不能通过普通图修改替换");
            if (value.data !== undefined && (!value.data || typeof value.data !== "object" || Array.isArray(value.data))) invalid("节点数据无效");
            value.data = { ...value.data, outputs: previous.data?.outputs ?? {}, handles: previous.data?.handles,
              executionRevision: previous.data?.executionRevision, stateVersion: previous.data?.stateVersion };
            // ACT: 移动、分组和改名不改变端口契约，旧界面节点仍可整理；业务数据与新连接必须经过后端校验。
            const withoutLabel = (data: Item["data"]) => Object.fromEntries(Object.entries(data ?? {}).filter(([key]) => key !== "label"));
            if (requestDigest(withoutLabel(value.data)) !== requestDigest(withoutLabel({ ...previous.data, outputs: previous.data?.outputs ?? {} }))) connectionNodes.add(value.id);
          }
          items[index] = value as Edge;
        }
        versions[change.id] = current + 1;
        if (change.kind === "node" && index < 0) connectionNodes.add(change.id);
      }
    }
    await validateGraph(graph,
      new Set(changes.flatMap(change => change.kind === "node" ? [change.id] : [])),
      connectionNodes,
      new Set(changes.flatMap(change => change.kind === "edge" ? [change.id] : [])), changes);
    meta.revision++;
    meta.receipts[operationId] = { digest, revision: meta.revision };
    const receiptIds = Object.keys(meta.receipts);
    for (const id of receiptIds.slice(0, Math.max(0, receiptIds.length - receiptLimit))) delete meta.receipts[id];
    await persistGraph(path, workspaceDirectory, operationId, digest, content, graph);
    return graph;
  } finally { release(); }
  });
}

export async function recoverGraphWrites() {
  for (const write of listIncompleteGraphWrites()) {
    const path = resolve(write.directory, write.path);
    try {
      await serializeGraph(path, async () => {
        const release = lockWorkspaceFiles([path]);
        try { await recoverGraphWrite(write); }
        finally { release(); }
      });
    } catch (error) {
      // 原文件已变化时保留意图供核对，不重放图修改或节点生命周期。
      console.error("画布写入恢复需要核对", error);
    }
  }
}
