import type { AgentToolResult, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { CanvasContext } from "@toonflow/tools-scaffold/runtime";
import type { AgentRunControl } from "@/agent/runtime/types";
import {
  getToolCallRecord,
  getToolCallInput,
  isSideEffectTool,
  requiresToolAuthorization,
  recordToolCallFinish,
  recordToolCallStart,
  requireSideEffectAuthorization,
} from "@/agent/runtime/store";
import { assertBackgroundToolAllowed, classifyToolExecutionMode } from "@/agent/runtime/toolExecution";
import { readGraph } from "@/utils/workspace/graph";
import { resolveWorkspacePath } from "@/utils/workspace/files";
import { isBuiltinCanvasTool } from "@/utils/plugins/tools";

export type ToolGuardContext = {
  runId: string;
  runControl?: AgentRunControl;
  canvasAttached: boolean;
  cwd?: string;
  canvasPath?: string;
  canvas?: CanvasContext;
  builtinCanvasTool?: boolean;
};

function parseStoredResult(resultJson: string | null): AgentToolResult<unknown> {
  if (!resultJson) return { content: [{ type: "text", text: "" }], details: undefined };
  try {
    const parsed = JSON.parse(resultJson) as unknown;
    if (parsed && typeof parsed === "object" && "content" in parsed) {
      const value = parsed as AgentToolResult<unknown>;
      return { content: value.content, details: value.details };
    }
    return {
      content: [{ type: "text", text: typeof parsed === "string" ? parsed : JSON.stringify(parsed) }],
      details: undefined,
    };
  } catch {
    return { content: [{ type: "text", text: resultJson }], details: undefined };
  }
}
async function nodeToolContext(toolName: string, args: unknown, context: ToolGuardContext, signal?: AbortSignal): Promise<ToolGuardContext & { nodeRevision?: string }> {
  if (toolName !== "nodeTools") return context;
  if (!context.canvas || !args || typeof args !== "object" || Array.isArray(args) || !("nodeId" in args) || typeof args.nodeId !== "string") return context;
  const name = toolName === "nodeTools" && "name" in args ? args.name : toolName;
  if (typeof name !== "string") return context;
  const result = await context.canvas.call({ name: "getNodeTools", args: { nodeIds: [args.nodeId], names: [name] } }, signal);
  if (!result || typeof result !== "object" || !("nodeTools" in result) || !Array.isArray(result.nodeTools)) return context;
  const tools = result.nodeTools.filter(tool => tool && typeof tool === "object" && tool.nodeId === args.nodeId && tool.name === name);
  return { ...context, nodeRevision: tools.length === 1 && typeof tools[0].nodeRevision === "string" ? tools[0].nodeRevision : undefined };
}

async function scopedInput(toolName: string, args: unknown, context: ToolGuardContext, needsAuthorization: boolean, nodeRevision?: string) {
  if (classifyToolExecutionMode(toolName) !== "canvas" || !needsAuthorization) return args;
  if (!context.cwd || !context.canvasPath) throw Object.assign(new Error("缺少画布版本上下文，不能授权操作"), { status: 409 });
  const { path } = await resolveWorkspacePath(context.cwd, context.canvasPath);
  const graph = await readGraph(path);
  const input = args && typeof args === "object" ? args as Record<string, unknown> : {};
  const nodes = new Set<string>();
  const edges = new Set<string>();
  if (typeof input.nodeId === "string") nodes.add(input.nodeId);
  if (Array.isArray(input.nodeIds)) for (const id of input.nodeIds) if (typeof id === "string") nodes.add(id);
  for (const key of ["moves", "renames", "connections"] as const) {
    const items = input[key];
    if (!Array.isArray(items)) continue;
    for (const item of items) {
      if (!item || typeof item !== "object") continue;
      for (const field of ["nodeId", "source", "target"]) {
        const id = (item as Record<string, unknown>)[field];
        if (typeof id === "string") nodes.add(id);
      }
    }
  }
  if (Array.isArray(input.edgeIds)) for (const id of input.edgeIds) if (typeof id === "string") edges.add(id);
  if (toolName === "arrangeCanvas") for (const node of graph.nodes) nodes.add(node.id);
  const outputs: Record<string, number> = {};
  if (toolName === "nodeTools" && typeof input.nodeId === "string") {
    if (!graph.nodes.some(node => node.id === input.nodeId)) throw Object.assign(new Error("节点已改变，不能授权"), { status: 409 });
    for (const edge of graph.edges) {
      if (edge.target !== input.nodeId) continue;
      nodes.add(edge.source);
      edges.add(edge.id);
      if (edge.sourceHandle) {
        const key = JSON.stringify([edge.source, edge.sourceHandle]);
        outputs[key] = graph.toonflowGraph!.outputs[key] ?? 0;
      }
    }
  }
  return { args, canvasId: graph.toonflowGraph!.id, canvasPath: context.canvasPath, ...(nodeRevision ? { nodeRevision } : {}),
    nodes: Object.fromEntries([...nodes].map(id => [id, graph.toonflowGraph!.nodes[id] ?? 0])),
    edges: Object.fromEntries([...edges].map(id => [id, graph.toonflowGraph!.edges[id] ?? 0])), outputs };
}
const activeToolCalls = new Set<string>();

export function wrapToolWithRunGuards(tool: ToolDefinition, ctx: ToolGuardContext): ToolDefinition {
  const execute = tool.execute;
  if (!execute) return tool;
  return {
    ...tool,
    execute: async (toolCallId, params, signal, onUpdate, extensionCtx) => {
      if (ctx.runControl?.shouldTerminate()) {
        throw Object.assign(new Error("本次流程已终止"), { status: 409 });
      }
      if (ctx.runControl?.shouldPauseBeforeStep()) {
        throw Object.assign(new Error("运行已暂停"), { code: "AGENT_PAUSED", status: 409 });
      }
      const toolContext = { ...ctx, builtinCanvasTool: isBuiltinCanvasTool({ execute }) };
      const sideEffect = isSideEffectTool(tool.name, toolContext);
      const key = ctx.runId + ":" + toolCallId;
      if (activeToolCalls.has(key)) throw Object.assign(new Error("工具调用仍在执行，不能重入"), { status: 409 });

      const previous = getToolCallRecord(toolCallId);
      if (previous?.runId !== undefined) {
        const stored = JSON.parse(previous.argsJson ?? "null") as Record<string, unknown> | null;
        const original = getToolCallInput(stored);
        if (previous.runId !== ctx.runId || previous.name !== tool.name || JSON.stringify(original ?? null) !== JSON.stringify(params ?? null))
          throw Object.assign(new Error("工具调用 ID 对应的输入已变化"), { status: 409 });
      }
      if (previous?.status === "completed") return parseStoredResult(previous.resultJson);
      if (previous?.status === "started" && (previous.sideEffect || sideEffect)) {
        recordToolCallFinish(toolCallId, "needsReview");
        throw Object.assign(new Error("副作用结果未知，需人工核对，不会重播"), { code: "AGENT_NO_REPLAY", status: 409 });
      }
      if (previous?.status === "needsReview" || previous?.status === "skipped")
        throw Object.assign(new Error("该副作用步骤已核对，不会重新执行"), { code: "AGENT_NO_REPLAY", status: 409 });
      assertBackgroundToolAllowed(tool.name, { canvasAttached: ctx.canvasAttached });
      activeToolCalls.add(key);
      let started = false;
      try {
        const context = await nodeToolContext(tool.name, params, toolContext, signal);
        const needsAuthorization = requiresToolAuthorization(tool.name, params, context);
        const authorizationInput = await scopedInput(tool.name, params, ctx, needsAuthorization, context.nodeRevision);
        recordToolCallStart(ctx.runId, toolCallId, tool.name, authorizationInput, sideEffect, needsAuthorization ? "pendingAuthorization" : "started");
        if (needsAuthorization) requireSideEffectAuthorization(ctx.runId, tool.name, authorizationInput, toolCallId, context);
        started = true;
        const input = tool.name === "nodeTools" && context.nodeRevision && params && typeof params === "object" && !Array.isArray(params)
          ? { ...params, expectedNodeRevision: context.nodeRevision } : params;
        const result = await execute(toolCallId, input, signal, onUpdate, extensionCtx);
        recordToolCallFinish(toolCallId, "completed", result);
        if (["addCanvas", "switchCanvas", "renameCanvas"].includes(tool.name)) {
          const details = result.details;
          ctx.canvasPath = details && typeof details === "object" && "id" in details && typeof details.id === "string" ? details.id : undefined;
        }
        return result;
      } catch (error) {
        if (started) recordToolCallFinish(toolCallId, sideEffect ? "needsReview" : "error", error instanceof Error ? error.message : String(error));
        throw error;
      } finally { activeToolCalls.delete(key); }
    },
  };
}

export function guardAgentTools(tools: ToolDefinition[], ctx?: ToolGuardContext) {
  if (!ctx?.runId) return tools;
  return tools.map(tool => wrapToolWithRunGuards(tool, ctx));
}
