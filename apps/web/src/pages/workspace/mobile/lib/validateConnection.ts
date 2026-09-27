import type { Connection } from "@vue-flow/core";
import { isTypeCompatible } from "@toonflow/nodes-scaffold/connection";
import type { CanvasNode } from "./mobileGraphModel";

type Handle = { id: string; type: "source" | "target"; dataType: string | string[] };

function handles(node: CanvasNode, type: "source" | "target") {
  const list = node.data?.handles;
  return Array.isArray(list) ? list.filter((h): h is Handle => !!h && h.type === type) : [];
}

export function canConnect(connection: Connection, sourceNode: CanvasNode, targetNode: CanvasNode) {
  if (connection.source === connection.target) return { ok: false, reason: "不能连接到自身" };
  const source = handles(sourceNode, "source").find(h => h.id === connection.sourceHandle);
  const target = handles(targetNode, "target").find(h => h.id === connection.targetHandle);
  if (!source || !target) return { ok: false, reason: "端口不存在或方向错误" };
  if (!isTypeCompatible(source.dataType, target.dataType)) return { ok: false, reason: "端口类型不兼容" };
  return { ok: true as const };
}

export function connectionRequiresBrowserRule(targetNode: CanvasNode) {
  return typeof (targetNode as { isValidTargetPos?: unknown }).isValidTargetPos === "function";
}
