import type { Connection } from "@vue-flow/core";
import type { GraphChange, WorkspaceGraph } from "@/lib/workspaceFiles";
import { absolutePosition, type CanvasNode } from "./mobileGraphModel";
import { canConnect } from "./validateConnection";

function nodeVersion(graph: WorkspaceGraph, id: string) {
  return graph.toonflowGraph.nodes[id] ?? 0;
}

function edgeVersion(graph: WorkspaceGraph, id: string) {
  return graph.toonflowGraph.edges[id] ?? 0;
}

function cloneNode(node: CanvasNode): CanvasNode {
  return JSON.parse(JSON.stringify(node)) as CanvasNode;
}

export function changeForNode(graph: WorkspaceGraph, node: CanvasNode | null, id: string): GraphChange {
  const previous = (graph.nodes as CanvasNode[]).find(item => item.id === id);
  const ids = [previous?.parentNode, node?.parentNode].filter((value): value is string => !!value);
  const dependencies = Object.fromEntries(ids.map(parentId => [parentId, nodeVersion(graph, parentId)]));
  return { kind: "node", id, expectedVersion: nodeVersion(graph, id), dependencies, value: node };
}

export function changeForEdge(graph: WorkspaceGraph, edge: WorkspaceGraph["edges"][number] | null, id: string): GraphChange {
  const current = edge ?? graph.edges.find(item => item.id === id);
  const dependencies = current ? { [current.source]: nodeVersion(graph, current.source), [current.target]: nodeVersion(graph, current.target) } : {};
  return { kind: "edge", id, expectedVersion: edgeVersion(graph, id), dependencies, value: edge };
}

export function createNodePayload(type: string, label: string, index: number): CanvasNode {
  const col = index % 4;
  const row = Math.floor(index / 4);
  return {
    id: crypto.randomUUID(),
    type,
    position: { x: 80 + col * 220, y: 80 + row * 140 },
    data: { label },
  };
}

export function updateNodeLabel(node: CanvasNode, label: string): CanvasNode {
  const next = cloneNode(node);
  next.data = { ...next.data, label };
  return next;
}

export function setNodeParent(graph: WorkspaceGraph, nodeId: string, parentGroupId: string | null): GraphChange[] {
  const nodes = graph.nodes as CanvasNode[];
  const byId = new Map(nodes.map(n => [n.id, n]));
  const node = byId.get(nodeId);
  if (!node || node.type === "canvasGroup") throw new Error("节点不存在或不能移动分组节点");
  if (parentGroupId) {
    const group = byId.get(parentGroupId);
    if (!group || group.type !== "canvasGroup") throw new Error("目标分组无效");
  }
  const abs = absolutePosition(node, byId);
  const parentAbs = parentGroupId ? absolutePosition(byId.get(parentGroupId)!, byId) : { x: 0, y: 0 };
  const next = cloneNode(node);
  next.parentNode = parentGroupId ?? undefined;
  next.position = { x: abs.x - parentAbs.x, y: abs.y - parentAbs.y };
  return [changeForNode(graph, next, nodeId)];
}

export function createGroupAroundNodes(graph: WorkspaceGraph, nodeIds: string[], label = "分组"): GraphChange[] {
  const nodes = graph.nodes as CanvasNode[];
  const byId = new Map(nodes.map(n => [n.id, n]));
  const selected = nodeIds.map(id => byId.get(id)).filter((n): n is CanvasNode => !!n && n.type !== "canvasGroup");
  if (!selected.length) throw new Error("请选择至少一个节点");
  const parentNode = selected.every(n => n.parentNode === selected[0]!.parentNode) ? selected[0]!.parentNode : undefined;
  const positions = selected.map(n => absolutePosition(n, byId));
  const minX = Math.min(...positions.map(p => p.x));
  const minY = Math.min(...positions.map(p => p.y));
  const maxX = Math.max(...positions.map(p => p.x + 200));
  const maxY = Math.max(...positions.map(p => p.y + 120));
  const groupId = crypto.randomUUID();
  const parentAbs = parentNode && byId.get(parentNode) ? absolutePosition(byId.get(parentNode)!, byId) : { x: 0, y: 0 };
  const groupPos = { x: minX - 24 - parentAbs.x, y: minY - 40 - parentAbs.y };
  const group: CanvasNode = {
    id: groupId,
    type: "canvasGroup",
    parentNode,
    position: groupPos,
    style: { width: `${maxX - minX + 48}px`, height: `${maxY - minY + 64}px` },
    connectable: false,
    data: { label },
  };
  const changes: GraphChange[] = [changeForNode(graph, group, groupId)];
  for (const node of selected) {
    const abs = absolutePosition(node, byId);
    const next = cloneNode(node);
    next.parentNode = groupId;
    next.position = { x: abs.x - (minX - 24), y: abs.y - (minY - 40) };
    changes.push(changeForNode(graph, next, node.id));
  }
  return changes;
}

export function createConnection(graph: WorkspaceGraph, connection: Connection) {
  const nodes = graph.nodes as CanvasNode[];
  const byId = new Map(nodes.map(n => [n.id, n]));
  const sourceNode = byId.get(connection.source);
  const targetNode = byId.get(connection.target);
  if (!sourceNode || !targetNode) throw new Error("连接端点不存在");
  const check = canConnect(connection, sourceNode, targetNode);
  if (!check.ok) throw new Error(check.reason);
  const duplicate = graph.edges.find(edge => edge.source === connection.source && edge.target === connection.target
    && edge.sourceHandle === connection.sourceHandle && edge.targetHandle === connection.targetHandle);
  if (duplicate) throw new Error("相同连接已存在");
  const id = crypto.randomUUID();
  const edge = {
    id,
    type: "default",
    source: connection.source,
    target: connection.target,
    sourceHandle: connection.sourceHandle,
    targetHandle: connection.targetHandle,
    data: {},
  };
  return changeForEdge(graph, edge, id);
}

export function removeEdgeChange(graph: WorkspaceGraph, edgeId: string): GraphChange {
  return changeForEdge(graph, null, edgeId);
}
