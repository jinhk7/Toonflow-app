import { fetchNodeCatalog, isExecutableNode, type NodeCatalogEntry } from "@toonflow/nodes-scaffold/runtime";

export type MobileNodeType = NodeCatalogEntry & { type: string; label: string };

export async function fetchEnabledNodeTypes(): Promise<MobileNodeType[]> {
  return (await fetchNodeCatalog()).filter(node => node.enabled !== false && isExecutableNode(node))
    .map(node => ({ ...node, type: `remote-${node.name}`, label: node.displayName }))
    .sort((left, right) => left.label.localeCompare(right.label, "zh-CN"));
}

export function loadNodeHandles(node: MobileNodeType) {
  if (!isExecutableNode(node)) throw new Error("节点缺少后端描述，请迁移插件");
  return structuredClone(node.handles);
}
