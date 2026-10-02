import { graphlib, layout } from "@dagrejs/dagre";
import type { NodeExecutionDescriptor } from "@toonflow/nodes-scaffold/execution";
import type { readGraph } from "@/utils/workspace/graph";

export async function arrangeGraph(canvas: Awaited<ReturnType<typeof readGraph>>, descriptors: NodeExecutionDescriptor[]) {
  const nodes = canvas.nodes.filter(node => !node.parentNode);
  if (!nodes.length) return [];
  const graph = new graphlib.Graph();
  graph.setGraph({ rankdir: "LR", rankalign: "top", nodesep: 120, ranksep: 240, edgesep: 32 });
  graph.setDefaultEdgeLabel(() => ({}));
  for (const node of nodes) {
    if (node.draggable === false) throw Object.assign(new Error(`节点 ${node.id} 不允许移动`), { status: 409 });
    const descriptor = descriptors.find(item => item.name === node.type?.replace(/^remote-/, ""));
    const size = descriptor?.layoutSize ?? { width: 480, height: 320 };
    graph.setNode(node.id, size);
  }
  function root(id: string) {
    const seen = new Set<string>();
    let node = canvas.nodes.find(item => item.id === id);
    while (node?.parentNode) {
      if (seen.has(node.id)) throw Object.assign(new Error("分组归属形成循环"), { status: 409 });
      seen.add(node.id);
      node = canvas.nodes.find(item => item.id === node!.parentNode);
    }
    return node?.id;
  }
  for (const edge of canvas.edges) {
    const source = root(edge.source);
    const target = root(edge.target);
    if (source && target && source !== target) graph.setEdge(source, target);
  }
  const groups = graphlib.alg.components(graph).map(ids => {
    const members = new Set(ids);
    const group = graph.filterNodes(id => members.has(id));
    group.setGraph({ ...graph.graph() });
    layout(group);
    return { ids, graph: group, width: group.graph().width!, height: group.graph().height! };
  });
  const gap = 360;
  const area = groups.reduce((sum, group) => sum + (group.width + gap) * (group.height + gap), 0);
  const rowWidth = Math.max(...groups.map(group => group.width), Math.sqrt(area * 1.6));
  let x = 0;
  let y = 0;
  let rowHeight = 0;
  return groups.flatMap(group => {
    if (x > 0 && x + group.width > rowWidth) { x = 0; y += rowHeight + gap; rowHeight = 0; }
    const result = group.ids.map(nodeId => { const node = group.graph.node(nodeId); return { nodeId, position: { x: x + node.x - node.width / 2, y: y + node.y - node.height / 2 } }; });
    x += group.width + gap;
    rowHeight = Math.max(rowHeight, group.height);
    return result;
  });
}
