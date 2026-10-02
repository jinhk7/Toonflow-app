import type { AgentToolResult, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
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
import { assertBackgroundToolAllowed, classifyToolExecutionMode, isReadOnlyServerTool, registerServerTool } from "@/agent/runtime/toolExecution";
import { readGraph } from "@/utils/workspace/graph";
import { resolveWorkspacePath } from "@/utils/workspace/files";
import { isBuiltinCanvasTool } from "@/utils/plugins/tools";
import { discardNodeInputs, type NodeInputSnapshot } from "@/utils/canvas/inputs";
import { requestDigest } from "@/utils/canvas/store";

export type ToolGuardContext = {
  runId: string;
  runControl?: AgentRunControl;
  canvasAttached: boolean;
  cwd?: string;
  canvasPath?: string;
  canvas?: CanvasContext;
  builtinCanvasTool?: boolean;
  toolScope?: string;
  builtinReadOnlyTool?: boolean;
};

type SnapshotCanvasContext = CanvasContext & {
  captureNodeToolSnapshot(nodeId: string, name: string, expectedNodeRevision?: string, signal?: AbortSignal): Promise<NodeInputSnapshot>;
  executeWithNodeToolSnapshot<T>(commandId: string, snapshot: NodeInputSnapshot, callback: () => Promise<T>): Promise<T>;
};

async function captureAuthorizedNodeInput(toolName: string, args: unknown, context: ToolGuardContext & { nodeRevision?: string }, signal?: AbortSignal) {
  if (toolName !== "nodeTools" || !context.builtinCanvasTool) return;
  if (!args || typeof args !== "object" || Array.isArray(args) || !("nodeId" in args) || typeof args.nodeId !== "string"
    || !("name" in args) || typeof args.name !== "string") return;
  const canvas = context.canvas as SnapshotCanvasContext | undefined;
  if (typeof canvas?.captureNodeToolSnapshot !== "function" || typeof canvas.executeWithNodeToolSnapshot !== "function")
    throw Object.assign(new Error("缺少服务端输入快照，无法审批节点动作"), { status: 409 });
  return canvas.captureNodeToolSnapshot(args.nodeId, args.name, context.nodeRevision, signal);
}

async function nodeInputDigest(snapshot: NodeInputSnapshot) {
  const files = Object.fromEntries(await Promise.all(Object.entries(snapshot.files).map(async ([path, name]) =>
    [path, createHash("sha256").update(await readFile(join(snapshot.directory, name))).digest("hex")],
  )));
  const { directory, ...input } = snapshot;
  return requestDigest({ ...input, files });
}

export function getExecutionToolCallId(runId: string, scope: string, modelToolCallId: string) {
  const hash = createHash("sha256").update(JSON.stringify([runId, scope, modelToolCallId])).digest("hex");
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}

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
  if (toolName !== "nodeTools" || !context.builtinCanvasTool) return context;
  if (!context.canvas || !args || typeof args !== "object" || Array.isArray(args) || !("nodeId" in args) || typeof args.nodeId !== "string") return context;
  const name = toolName === "nodeTools" && "name" in args ? args.name : toolName;
  if (typeof name !== "string") return context;
  const result = await context.canvas.call({ name: "getNodeTools", args: { nodeIds: [args.nodeId], names: [name], expectedCanvasId: context.canvasPath } }, signal);
  if (!result || typeof result !== "object" || !("nodeTools" in result) || !Array.isArray(result.nodeTools)) return context;
  const tools = result.nodeTools.filter(tool => tool && typeof tool === "object" && tool.nodeId === args.nodeId && tool.name === name);
  return { ...context, nodeRevision: tools.length === 1 && typeof tools[0].nodeRevision === "string" ? tools[0].nodeRevision : undefined };
}

async function scopedInput(toolName: string, args: unknown, context: ToolGuardContext, needsAuthorization: boolean, nodeRevision?: string, inputSnapshot?: NodeInputSnapshot) {
  if (!context.builtinCanvasTool || !needsAuthorization) return args;
  if (!context.cwd || !context.canvasPath) throw Object.assign(new Error("缺少画布版本上下文，不能授权操作"), { status: 409 });
  const { path } = await resolveWorkspacePath(context.cwd, context.canvasPath);
  const graph = await readGraph(path, context.cwd);
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
    ...(inputSnapshot ? { inputSnapshotDigest: await nodeInputDigest(inputSnapshot) } : {}),
    nodes: Object.fromEntries([...nodes].map(id => [id, graph.toonflowGraph!.nodes[id] ?? 0])),
    edges: Object.fromEntries([...edges].map(id => [id, graph.toonflowGraph!.edges[id] ?? 0])), outputs };
}
const activeToolCalls = new Set<string>();
const originalTools = new WeakMap<ToolDefinition["execute"], ToolDefinition>();

export function wrapToolWithRunGuards(tool: ToolDefinition, ctx: ToolGuardContext): ToolDefinition {
  tool = originalTools.get(tool.execute) ?? tool;
  const execute = tool.execute;
  if (!execute) return tool;
  const mode = classifyToolExecutionMode(tool);
  const wrapped: ToolDefinition = {
    ...tool,
    execute: async (modelToolCallId, params, signal, onUpdate, extensionCtx) => {
      const toolCallId = ctx.toolScope ? getExecutionToolCallId(ctx.runId, ctx.toolScope, modelToolCallId) : modelToolCallId;
      if (ctx.runControl?.shouldTerminate()) {
        throw Object.assign(new Error("本次流程已终止"), { status: 409 });
      }
      if (ctx.runControl?.shouldPauseBeforeStep()) {
        throw Object.assign(new Error("运行已暂停"), { code: "AGENT_PAUSED", status: 409 });
      }
      if (ctx.canvas) ctx.canvasPath = ctx.canvas.id;
      const toolContext = { ...ctx, builtinCanvasTool: isBuiltinCanvasTool({ name: tool.name, execute }), builtinReadOnlyTool: isReadOnlyServerTool(tool) };
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
      assertBackgroundToolAllowed(tool, { canvasAttached: ctx.canvasAttached });
      activeToolCalls.add(key);
      let started = false;
      let inputSnapshot: NodeInputSnapshot | undefined;
      try {
        const context = await nodeToolContext(tool.name, params, toolContext, signal);
        const needsAuthorization = requiresToolAuthorization(tool.name, params, context);
        inputSnapshot = needsAuthorization ? await captureAuthorizedNodeInput(tool.name, params, context, signal) : undefined;
        const authorizationInput = await scopedInput(tool.name, params, context, needsAuthorization, context.nodeRevision, inputSnapshot);
        if (mode === "canvas" && ctx.canvas?.id !== context.canvasPath) {
          throw Object.assign(new Error("画布已切换，请重新执行操作"), { status: 409 });
        }
        recordToolCallStart(ctx.runId, toolCallId, tool.name, authorizationInput, sideEffect, needsAuthorization ? "pendingAuthorization" : "started");
        if (needsAuthorization) requireSideEffectAuthorization(ctx.runId, tool.name, authorizationInput, toolCallId, context);
        started = true;
        const input = context.builtinCanvasTool && tool.name === "nodeTools" && params && typeof params === "object" && !Array.isArray(params)
          ? { ...params, expectedCanvasId: context.canvasPath, ...(context.nodeRevision ? { expectedNodeRevision: context.nodeRevision } : {}) } : params;
        const executeTool = () => execute(toolCallId, input, signal, onUpdate, extensionCtx);
        const result = inputSnapshot
          ? await (context.canvas as SnapshotCanvasContext).executeWithNodeToolSnapshot(toolCallId, inputSnapshot, executeTool)
          : await executeTool();
        recordToolCallFinish(toolCallId, "completed", result);
        if (context.builtinCanvasTool && ["addCanvas", "switchCanvas", "renameCanvas"].includes(tool.name)) {
          const details = result.details;
          ctx.canvasPath = details && typeof details === "object" && "id" in details && typeof details.id === "string" ? details.id : undefined;
        }
        return result;
      } catch (error) {
        if (started) recordToolCallFinish(toolCallId, sideEffect ? "needsReview" : "error", error instanceof Error ? error.message : String(error));
        throw error;
      } finally { activeToolCalls.delete(key); await discardNodeInputs(inputSnapshot); }
    },
  };
  originalTools.set(wrapped.execute, tool);
  return registerServerTool(wrapped, mode, isReadOnlyServerTool(tool));
}

export function guardAgentTools(tools: ToolDefinition[], ctx?: ToolGuardContext) {
  if (!ctx?.runId) return tools;
  return tools.map(tool => wrapToolWithRunGuards(tool, ctx));
}
