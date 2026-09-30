import { canvasOperations } from "@toonflow/tool-canvas/runtime";

export type ToolExecutionMode = "server" | "canvas" | "page";

const canvasTools = new Set<string>(canvasOperations.map(operation => operation.name));
const serverBuiltinTools = new Set([
  "read",
  "write",
  "edit",
  "ls",
  "writeFile",
  "memory",
  "report",
  "subAgent",
  "question",
  "generateImage",
  "generateVideo",
  "generateAudio",
  "skill",
]);

export function classifyToolExecutionMode(toolName: string): ToolExecutionMode {
  if (canvasTools.has(toolName) || toolName.startsWith("node:")) return "canvas";
  if (serverBuiltinTools.has(toolName)) return "server";
  return "page";
}

export function describeToolExecutionBoundary(toolName: string) {
  const mode = classifyToolExecutionMode(toolName);
  if (mode === "server") return { mode, background: true, hint: "可在服务端后台执行" };
  if (mode === "canvas") return { mode, background: false, hint: "需要画布页面在线并回传结果" };
  return { mode, background: false, hint: "第三方或未适配工具需页面在线，后台不会自动执行" };
}

export function assertBackgroundToolAllowed(toolName: string, options: { canvasAttached: boolean }) {
  const mode = classifyToolExecutionMode(toolName);
  if (mode === "server") return;
  if (mode === "canvas" && options.canvasAttached) return;
  const { hint } = describeToolExecutionBoundary(toolName);
  throw Object.assign(new Error(hint), { code: "AGENT_TOOL_NEEDS_PAGE", status: 409 });
}
