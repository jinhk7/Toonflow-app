import type { NodeHandle } from "./connection";
import { isTypeCompatible } from "./connection";
import { isNodeOutput, type NodeInputValue, type NodeOutput } from "./values";

type InputNode = { id: string; data?: { handles?: NodeHandle[]; outputs?: Record<string, unknown>; [key: string]: unknown } };
type InputEdge = { source: string; target: string; sourceHandle?: string | null; targetHandle?: string | null };
type Nodes = InputNode[] | ReadonlyMap<string, InputNode>;

function findNode(nodes: Nodes, id: string) { return Array.isArray(nodes) ? nodes.find(node => node.id === id) : nodes.get(id); }

export function getTargetSources(targetId: string, targetHandleId: string, nodes: Nodes, edges: InputEdge[]) {
  const target = findNode(nodes, targetId)?.data?.handles?.find(handle => handle.type === "target" && handle.id === targetHandleId);
  if (!target) return [];
  return edges.filter(edge => edge.target === targetId && edge.targetHandle === targetHandleId).flatMap(edge => {
    const node = findNode(nodes, edge.source);
    const handle = node?.data?.handles?.find(item => item.type === "source" && item.id === edge.sourceHandle);
    return node && handle && isTypeCompatible(handle.dataType, target.dataType) ? [{ node, handle }] : [];
  });
}

export function getSourceValue(sourceId: string, sourceHandleId: string, nodes: Nodes): NodeOutput | undefined {
  const node = findNode(nodes, sourceId);
  const handle = node?.data?.handles?.find(item => item.type === "source" && item.id === sourceHandleId);
  const output = node?.data?.outputs?.[sourceHandleId];
  if (!handle || output === undefined) return;
  if (!isNodeOutput(output) || !isTypeCompatible(output.dataType, handle.dataType)) throw new Error(`节点 ${sourceId} 的输出值不符合端口声明`);
  return output;
}

export function getTargetValues(targetId: string, targetHandleId: string, nodes: Nodes, edges: InputEdge[]): NodeInputValue[] {
  const values = getTargetSources(targetId, targetHandleId, nodes, edges).map(({ node, handle }) => {
    const output = getSourceValue(node.id, handle.id, nodes);
    return output ? { ...output, source: node.id, sourceHandle: handle.id } : { source: node.id, sourceHandle: handle.id, dataType: handle.dataType, value: undefined };
  });
  const orders = findNode(nodes, targetId)?.data?.referenceOrder as Record<string, unknown> | undefined;
  const order = orders?.[targetHandleId];
  if (!Array.isArray(order)) return values;
  const positions = new Map(order.filter((key): key is string => typeof key === "string").map((key, index) => [key, index]));
  return values.sort((left, right) => (positions.get(encodeURIComponent(JSON.stringify([left.source, left.sourceHandle]))) ?? Infinity) - (positions.get(encodeURIComponent(JSON.stringify([right.source, right.sourceHandle]))) ?? Infinity));
}
