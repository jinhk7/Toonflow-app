import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { isBuiltinCanvasTool } from "@/utils/plugins/tools";

export type ToolExecutionMode = "server" | "canvas" | "unregistered";

const executionModes = new WeakMap<ToolDefinition["execute"], ToolExecutionMode>();
const readOnlyExecutions = new WeakSet<ToolDefinition["execute"]>();

// ACT: 安装的工具本来就是可信服务端代码；执行位置依据加载函数，不按名称限制扩展。
export function registerServerTool<T extends ToolDefinition>(tool: T, mode?: ToolExecutionMode, readOnly = false): T {
  executionModes.set(tool.execute, mode ?? (isBuiltinCanvasTool(tool) ? "canvas" : "server"));
  if (readOnly) readOnlyExecutions.add(tool.execute);
  return tool;
}

export function isReadOnlyServerTool(tool: Pick<ToolDefinition, "execute">) {
  return readOnlyExecutions.has(tool.execute);
}

export function classifyToolExecutionMode(tool: Pick<ToolDefinition, "execute">): ToolExecutionMode {
  return executionModes.get(tool.execute) ?? "unregistered";
}

export function assertBackgroundToolAllowed(tool: ToolDefinition | undefined, options: { canvasAttached: boolean }) {
  if (!tool) throw Object.assign(new Error("工具未在当前后台运行注册"), { code: "AGENT_TOOL_NOT_REGISTERED", status: 409 });
  const mode = classifyToolExecutionMode(tool);
  if (mode === "server" || mode === "canvas" && options.canvasAttached) return;
  const message = mode === "canvas" ? "当前运行缺少后端画布上下文" : "工具未在当前后台运行注册";
  throw Object.assign(new Error(message), { code: "AGENT_TOOL_NOT_REGISTERED", status: 409 });
}
