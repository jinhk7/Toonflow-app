import type { Edge, Node } from "@vue-flow/core";
import type { WorkspaceGraph } from "@/lib/workspaceFiles";

export type CanvasNode = Node & { parentNode?: string };
export type CanvasEdge = Edge;

export type GroupTreeItem = {
  group: CanvasNode | null;
  nodes: CanvasNode[];
  children: GroupTreeItem[];
};

export type NodeRefLink = {
  edgeId: string;
  direction: "in" | "out";
  peerId: string;
  peerLabel: string;
  sourceHandle?: string;
  targetHandle?: string;
};

export function nodesById(nodes: CanvasNode[]) {
  return new Map(nodes.map(node => [node.id, node]));
}

export function nodeLabel(node: CanvasNode) {
  const label = node.data?.label;
  return typeof label === "string" && label.trim() ? label.trim() : node.id.slice(0, 8);
}

export function absolutePosition(node: CanvasNode, byId: Map<string, CanvasNode>) {
  let x = node.position?.x ?? 0;
  let y = node.position?.y ?? 0;
  const seen = new Set<string>([node.id]);
  let parentId = node.parentNode;
  while (parentId) {
    if (seen.has(parentId)) break;
    seen.add(parentId);
    const parent = byId.get(parentId);
    if (!parent) break;
    x += parent.position?.x ?? 0;
    y += parent.position?.y ?? 0;
    parentId = parent.parentNode;
  }
  return { x, y };
}

export function groupPath(nodeId: string, nodes: CanvasNode[]) {
  const byId = nodesById(nodes);
  const parts: string[] = [];
  const seen = new Set<string>();
  let current = byId.get(nodeId);
  while (current?.parentNode) {
    if (seen.has(current.parentNode)) break;
    seen.add(current.parentNode);
    const group = byId.get(current.parentNode);
    if (!group || group.type !== "canvasGroup") break;
    parts.unshift(nodeLabel(group));
    current = group;
  }
  return parts;
}

export function buildGroupTree(nodes: CanvasNode[]): GroupTreeItem {
  const byId = nodesById(nodes);
  const childrenOf = new Map<string | null, CanvasNode[]>();
  for (const node of nodes) {
    if (node.type === "canvasGroup") continue;
    const parent = node.parentNode && byId.get(node.parentNode)?.type === "canvasGroup" ? node.parentNode : null;
    const list = childrenOf.get(parent) ?? [];
    list.push(node);
    childrenOf.set(parent, list);
  }
  const groupsOf = new Map<string | null, CanvasNode[]>();
  for (const node of nodes) {
    if (node.type !== "canvasGroup") continue;
    const parent = node.parentNode && byId.get(node.parentNode)?.type === "canvasGroup" ? node.parentNode : null;
    const list = groupsOf.get(parent) ?? [];
    list.push(node);
    groupsOf.set(parent, list);
  }
  function build(parentId: string | null): GroupTreeItem[] {
    const groupNodes = (groupsOf.get(parentId) ?? []).sort((a, b) => nodeLabel(a).localeCompare(nodeLabel(b), "zh-CN"));
    const loose = (childrenOf.get(parentId) ?? []).sort((a, b) => nodeLabel(a).localeCompare(nodeLabel(b), "zh-CN"));
    const items: GroupTreeItem[] = [];
    if (parentId === null && loose.length) items.push({ group: null, nodes: loose, children: [] });
    for (const group of groupNodes) {
      items.push({
        group,
        nodes: (childrenOf.get(group.id) ?? []).sort((a, b) => nodeLabel(a).localeCompare(nodeLabel(b), "zh-CN")),
        children: build(group.id),
      });
    }
    return items;
  }
  return { group: null, nodes: [], children: build(null) };
}

export function flattenTreeForSearch(tree: GroupTreeItem): { node: CanvasNode; path: string[] }[] {
  const result: { node: CanvasNode; path: string[] }[] = [];
  function walk(item: GroupTreeItem, path: string[]) {
    for (const node of item.nodes) result.push({ node, path });
    for (const child of item.children) {
      const next = child.group ? [...path, nodeLabel(child.group)] : path;
      walk(child, next);
    }
  }
  walk(tree, []);
  return result;
}

export function nodeReferences(nodeId: string, graph: Pick<WorkspaceGraph, "nodes" | "edges">): NodeRefLink[] {
  const byId = nodesById(graph.nodes as CanvasNode[]);
  const links: NodeRefLink[] = [];
  for (const edge of graph.edges as CanvasEdge[]) {
    if (edge.source === nodeId) {
      const peer = byId.get(edge.target);
      links.push({
        edgeId: edge.id,
        direction: "out",
        peerId: edge.target,
        peerLabel: peer ? nodeLabel(peer) : edge.target,
        sourceHandle: edge.sourceHandle ?? undefined,
        targetHandle: edge.targetHandle ?? undefined,
      });
    }
    if (edge.target === nodeId) {
      const peer = byId.get(edge.source);
      links.push({
        edgeId: edge.id,
        direction: "in",
        peerId: edge.source,
        peerLabel: peer ? nodeLabel(peer) : edge.source,
        sourceHandle: edge.sourceHandle ?? undefined,
        targetHandle: edge.targetHandle ?? undefined,
      });
    }
  }
  return links;
}

export function listGroups(nodes: CanvasNode[]) {
  return nodes.filter(node => node.type === "canvasGroup").map(node => ({ id: node.id, label: nodeLabel(node) }));
}
