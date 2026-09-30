import { inject, onScopeDispose } from "vue";
import { runAgentLoop, type AgentTool, type AgentToolResult } from "@earendil-works/pi-agent-core";
import { createAssistantMessageEventStream, type AssistantMessage, type Context, type Message, type Model } from "@earendil-works/pi-ai";
import { EventSourceParserStream } from "eventsource-parser/stream";
import type { MediaGenerationRequest, MediaModel } from "@toonflow/tools-scaffold/runtime";
import type { NodeOutput } from "./values";

export type NodeAiModel = {
  providerId: string;
  providerLabel: string;
  modelId: string;
  label: string;
  protocol: "openai-completions" | "openai-responses" | "anthropic-messages";
  contextWindow?: number;
  maxOutputTokens?: number;
};
export type NodeMediaModel = Omit<MediaModel, "mode"> & {
  mode?: (string | string[])[];
};
export type MediaJobCanvasBinding = {
  canvasPath?: string;
  nodeId?: string;
  outputSlot?: string;
  expectedNodeVersion?: number;
};
export type PrepareMediaJobResult = {
  canvasPath: string;
  nodeId: string;
  outputSlot: string;
  expectedNodeVersion: number;
};
export type PendingMediaJobState = {
  idempotencyKey: string;
  outputSlot: string;
  canvasPath: string;
  expectedNodeVersion: number;
  startedAt: number;
};
export type NodeMediaJobView = {
  jobId: string;
  idempotencyKey: string;
  status: string;
  linkStatus?: string;
  mediaType?: string;
  files?: { path: string; mimeType: string; mediaType: "image" | "video" }[];
  errorMessage?: string | null;
};
export type PrepareMediaJobFn = (nodeId: string, outputSlot: string) => Promise<PrepareMediaJobResult>;
export type PersistNodeGraphFn = (nodeId: string, expectedVersion: number) => Promise<number>;


export type NodeImageRequest = MediaJobCanvasBinding & {
  directory: string;
  idempotencyKey?: string;
  providerId: string;
  modelId: string;
  prompt: string;
  outputDirectory: string;
  images?: { path: string; mimeType: string }[];
  ratio?: string;
  size?: string;
};
export type NodeImageResult = { path: string; mimeType: string; mediaType: "image" };
export type NodeVideoRequest = Omit<MediaGenerationRequest, "size"> & MediaJobCanvasBinding & { directory: string; outputDirectory: string; idempotencyKey?: string };
export type NodeVideoResult = { path: string; mimeType: string; mediaType: "video" };
export type NodeAiRequest = {
  providerId: string;
  modelId: string;
  prompt: string;
  systemPrompt?: string;
  directory?: string;
  references?: Extract<NodeOutput, { dataType: "STRING" | "IMAGE" | "VIDEO" }>[];
  tools?: NodeAiTool[];
  onEvent?: (event: NodeAiEvent) => void;
  signal?: AbortSignal;
};
export type NodeAiResult = {
  text: string;
  reasoning?: string;
};
export type NodeAiEvent = { type: "text" | "reasoning"; delta: string }
  | { type: "toolStart"; id: string; name: string; args: unknown }
  | { type: "toolEnd"; id: string; name: string; result: unknown; isError: boolean };
export type NodeAiTool = {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute(args: Record<string, unknown>, signal?: AbortSignal): unknown | Promise<unknown>;
};

export function useNodeMediaPersistence(nodeId: string, getData: () => Record<string, unknown>) {
  const prepareMediaJob = inject<PrepareMediaJobFn | undefined>("prepareMediaJob", undefined);
  const persistNodeGraph = inject<PersistNodeGraphFn | undefined>("persistNodeGraph", undefined);
  let preparing = false;
  async function prepare(outputSlot: string) {
    if (preparing || readPending()) throw new Error("已有未决媒体任务，请先核对原任务，不能使用新键重复提交");
    if (!prepareMediaJob || !persistNodeGraph) throw new Error("画布未提供持久任务入口，不能提交媒体生成");
    preparing = true;
    try {
      const idempotencyKey = crypto.randomUUID();
      const binding = await prepareMediaJob(nodeId, outputSlot);
      const data = getData();
      data.pendingMediaJob = {
        idempotencyKey,
        outputSlot,
        canvasPath: binding.canvasPath,
        expectedNodeVersion: binding.expectedNodeVersion + 1,
        startedAt: Date.now(),
      } satisfies PendingMediaJobState;
      try {
        binding.expectedNodeVersion = await persistNodeGraph(nodeId, binding.expectedNodeVersion);
      } catch (error) {
        if ((getData().pendingMediaJob as PendingMediaJobState | undefined)?.idempotencyKey === idempotencyKey) delete getData().pendingMediaJob;
        throw error;
      }
      return { idempotencyKey, binding };
    } finally {
      preparing = false;
    }
  }

  async function clearPending(outputSlot: string) {
    const pending = readPending();
    if (!pending) return;
    const binding = prepareMediaJob ? await prepareMediaJob(nodeId, outputSlot) : undefined;
    const data = getData();
    if (readPending()?.idempotencyKey !== pending.idempotencyKey) throw new Error("节点任务已变化，不能清除占用");
    delete data.pendingMediaJob;
    try {
      if (persistNodeGraph) await persistNodeGraph(nodeId, binding?.expectedNodeVersion ?? 0);
    } catch (error) {
      if (!data.pendingMediaJob) data.pendingMediaJob = pending;
      throw error;
    }
  }

  // 仅任务已失败或提交被服务端拒绝（未建任务）时解锁；未知或待收取状态继续占用，避免重复计费。
  async function releaseFailed(outputSlot: string, error: unknown) {
    if (typeof error === "object" && error && "definitive" in error) await clearPending(outputSlot);
  }

  function readPending(): PendingMediaJobState | undefined {
    const pending = getData().pendingMediaJob;
    if (!pending || typeof pending !== "object") return undefined;
    const state = pending as Partial<PendingMediaJobState>;
    if (typeof state.idempotencyKey !== "string" || typeof state.outputSlot !== "string") return undefined;
    return state as PendingMediaJobState;
  }

  return { prepare, clearPending, releaseFailed, readPending, hasGraphPersistence: !!prepareMediaJob && !!persistNodeGraph };
}

async function readMediaJobPayload(response: Response) {
  const payload = await response.json() as { code: number; data?: NodeMediaJobView; message?: string };
  if (!response.ok || payload.code !== 200) throw new Error(payload.message || "查询媒体任务失败");
  return payload.data ?? null;
}

export async function fetchMediaJob(directory: string, idempotencyKey: string, signal?: AbortSignal) {
  const query = new URLSearchParams({ directory, idempotencyKey });
  const response = await fetch(`/api/ai/media/getJob?${query}`, {
    signal,
  });
  return readMediaJobPayload(response);
}

export async function retryMediaCollection(directory: string, jobId: string, signal?: AbortSignal) {
  const response = await fetch("/api/ai/media/retryCollection", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ directory, jobId }), signal,
  });
  return readMediaJobPayload(response);
}

export async function listMediaJobs(directory: string, signal?: AbortSignal) {
  const query = new URLSearchParams({ directory });
  const response = await fetch(`/api/ai/media/list?${query}`, {
    signal,
  });
  if (response.status === 404) throw new Error("媒体任务列表接口尚未就绪");
  const payload = await response.json() as { code: number; data?: NodeMediaJobView[]; message?: string };
  if (!response.ok || payload.code !== 200) throw new Error(payload.message || "查询媒体任务列表失败");
  return payload.data ?? [];
}

export async function pollMediaJobUntilDone(directory: string, idempotencyKey: string, signal: AbortSignal) {
  while (true) {
    signal.throwIfAborted();
    const job = await fetchMediaJob(directory, idempotencyKey, signal);
    if (!job) throw new Error("未找到任务记录，需核对原提交；不会自动重新生成");
    if (job.status === "completed" && job.linkStatus !== "pending") {
      if (!job.files?.length) throw new Error("任务已完成但没有结果文件");
      return job.files;
    }
    if (job.status === "failed") throw Object.assign(new Error(job.errorMessage || "媒体生成失败"), { definitive: true });
    if (job.status === "unknown") throw new Error(`${job.errorMessage || "提交状态未知"}；结果未知，需人工核对，点击生成可确认放弃后重新提交`);
    if (job.status === "collectionFailed") throw new Error(job.errorMessage || "媒体已生成但下载归档失败，请重试收取，不要重新生成");
    await new Promise(resolve => setTimeout(resolve, 500));
  }
}

export function groupNodeModels<T extends Pick<NodeAiModel, "providerId" | "providerLabel">>(models: readonly T[]) {
  return [...Map.groupBy(models, item => item.providerId)].map(([id, items]) => ({
    id, label: items[0]!.providerLabel, models: items,
  })).sort((left, right) => Number(right.id === "tfRouter") - Number(left.id === "tfRouter"));
}

async function readResult<T>(response: Response): Promise<T> {
  const result = await response.json();
  if (!response.ok || result.code !== 200) throw new Error(result.message || `AI 请求失败（HTTP ${response.status}）`);
  return result.data;
}

// ACT: 独立 UMD 各有模块作用域，共用宿主缓存；模型设置保存后失效，不按节点重复请求。
const modelCacheKey = Symbol.for("toonflow.nodeModels");
const modelCacheHost = globalThis as typeof globalThis & { [modelCacheKey]?: Map<string, Promise<unknown[]>> };
const modelCache = modelCacheHost[modelCacheKey] ??= new Map<string, Promise<unknown[]>>();

export function invalidateNodeModels(type: "language" | "media") {
  modelCache.delete(type === "language" ? "/api/ai/models" : "/api/ai/media/models");
}

async function readModels<T>(url: string, signal: AbortSignal): Promise<T[]> {
  signal.throwIfAborted();
  let pending = modelCache.get(url);
  if (!pending) {
    const request = fetch(url, { cache: "no-store" }).then(readResult<unknown[]>).catch(error => {
      if (modelCache.get(url) === request) modelCache.delete(url);
      throw error;
    });
    pending = request;
    modelCache.set(url, request);
  }
  // 单个节点关闭只取消自己的等待，不能中断其他节点共用的请求。
  let cancel = () => {};
  try {
    const models = await Promise.race([
      pending,
      new Promise<never>((_resolve, reject) => {
        cancel = () => reject(signal.reason);
        signal.addEventListener("abort", cancel, { once: true });
      }),
    ]);
    signal.throwIfAborted();
    return modelCache.get(url) === pending ? models as T[] : readModels<T>(url, signal);
  } finally {
    signal.removeEventListener("abort", cancel);
  }
}

async function requestModel(input: NodeAiRequest, context: Context, model: Model<NodeAiModel["protocol"]>, signal: AbortSignal) {
  const { providerId, modelId, references, directory, onEvent } = input;
  const stream = createAssistantMessageEventStream();
  try {
    signal.throwIfAborted();
    const response = await fetch("/api/ai/generate", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ providerId, modelId, context, directory, references }), signal,
    });
    if (!response.ok) await readResult(response);
    if (!response.body || !response.headers.get("content-type")?.includes("text/event-stream")) throw new Error("AI 未返回 SSE 数据流");
    const reader = response.body.pipeThrough(new TextDecoderStream()).pipeThrough(new EventSourceParserStream()).getReader();
    try {
      while (true) {
        const { value, done } = await reader.read();
        signal.throwIfAborted();
        if (done) throw new Error("AI 数据流提前结束，请重试");
        const event = JSON.parse(value.data);
        if (event.type === "error") throw new Error(event.message || "AI 生成失败");
        if (event.type === "text" || event.type === "reasoning") onEvent?.(event);
        if (event.type !== "done") continue;
        const message = event.message as AssistantMessage;
        if (message?.role !== "assistant" || !Array.isArray(message.content)) throw new Error("AI 返回消息不完整，请确认服务端已更新");
        if (message.stopReason === "deferred" || message.stopReason === "pending") throw new Error("AI 返回了未完成的任务");
        if (message.stopReason === "error" || message.stopReason === "aborted") throw new Error(message.errorMessage || "AI 请求失败");
        // ACT: 增量直接通知 UI；SDK 只消费完整单轮消息，避免每个 token 传输全量快照。
        stream.push({ type: "start", partial: { ...message, content: [], stopReason: "pending" } });
        stream.push({ type: "done", reason: message.stopReason, message });
        break;
      }
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  } catch (error) {
    const reason = signal.aborted ? "aborted" : "error";
    stream.push({ type: "error", reason, error: {
      role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(),
      stopReason: reason, errorMessage: error instanceof Error ? error.message : "AI 请求失败",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    } });
  }
  return stream;
}

export function useNodeAi() {
  const controller = new AbortController();
  onScopeDispose(() => controller.abort());
  const requestSignal = (signal?: AbortSignal) => signal ? AbortSignal.any([controller.signal, signal]) : controller.signal;

  async function getModels(signal?: AbortSignal) {
    return readModels<NodeAiModel>("/api/ai/models", requestSignal(signal));
  }

  async function getMediaModels(signal?: AbortSignal) {
    return readModels<NodeMediaModel>("/api/ai/media/models", requestSignal(signal));
  }

  async function generateMedia<T extends "image" | "video">(mediaType: T, input: NodeImageRequest | NodeVideoRequest, signal?: AbortSignal) {
    const idempotencyKey = input.idempotencyKey || crypto.randomUUID();
    const activeSignal = requestSignal(signal);
    const body = { ...input, mediaType, idempotencyKey, wait: false };
    try {
      const response = await fetch("/api/ai/media/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: activeSignal,
      });
      if (!response.ok && response.status < 500) {
        const payload = await response.json() as { message?: string };
        throw Object.assign(new Error(payload.message || "媒体任务提交失败"), { definitive: true });
      }
      if (response.ok) {
        try { await response.json(); } catch { /* 按 key 核对原任务。 */ }
      }
      return await pollMediaJobUntilDone(input.directory, idempotencyKey, activeSignal) as { path: string; mimeType: string; mediaType: T }[];
    } catch (err) {
      if (activeSignal.aborted) throw err;
      if (typeof err === "object" && err && "definitive" in err) throw err;
      return pollMediaJobUntilDone(input.directory, idempotencyKey, activeSignal) as Promise<{ path: string; mimeType: string; mediaType: T }[]>;
    }
  }

  function generateImage(input: NodeImageRequest, signal?: AbortSignal) {
    return generateMedia("image", input, signal);
  }

  function generateVideo(input: NodeVideoRequest, signal?: AbortSignal) {
    return generateMedia("video", input, signal);
  }

  async function generate(input: NodeAiRequest): Promise<NodeAiResult> {
    const signal = requestSignal(input.signal);
    const callSignal = input.tools?.length ? AbortSignal.any([signal, AbortSignal.timeout(600000)]) : signal;
    const { providerId, modelId, prompt, systemPrompt, onEvent } = input;
    if (!prompt.trim()) throw new Error("请输入提示词");
    const definitions = input.tools ?? [];
    if (new Set(definitions.map(tool => tool.name)).size !== definitions.length) throw new Error("工具名称不能重复");
    const selected = (await getModels(callSignal)).find(model => model.providerId === providerId && model.modelId === modelId);
    if (!selected) throw new Error("所选模型不存在，请重新选择");
    const model: Model<NodeAiModel["protocol"]> = {
      id: modelId, name: selected.label, provider: providerId, api: selected.protocol, baseUrl: "",
      reasoning: false, input: ["text", "image"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: selected.contextWindow ?? 262144, maxTokens: selected.maxOutputTokens ?? 32768,
    };
    const tools: AgentTool[] = definitions.map(tool => ({
      name: tool.name, label: tool.name, description: tool.description, parameters: tool.parameters,
      async execute(_id, args, toolSignal) {
        callSignal.throwIfAborted();
        if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error("工具参数必须是对象");
        const result = await tool.execute(args as Record<string, unknown>, toolSignal) ?? null;
        callSignal.throwIfAborted();
        return { content: [{ type: "text", text: JSON.stringify(result) ?? "null" }], details: undefined };
      },
    }));
    let turns = 0;
    const messages = await runAgentLoop([{ role: "user", content: prompt, timestamp: Date.now() }], {
      systemPrompt: systemPrompt ?? "", messages: [], tools,
    }, {
      model, convertToLlm: messages => messages as Message[], toolExecution: "sequential",
      shouldStopAfterTurn: ({ message }) => ++turns >= 40 || message.stopReason === "length",
    }, event => {
      callSignal.throwIfAborted();
      if (event.type === "tool_execution_start") onEvent?.({ type: "toolStart", id: event.toolCallId, name: event.toolName, args: event.args });
      if (event.type === "tool_execution_end" && onEvent) {
        const text = (event.result as AgentToolResult<unknown>).content.filter(part => part.type === "text").map(part => part.text).join("\n");
        onEvent({ type: "toolEnd", id: event.toolCallId, name: event.toolName, result: event.isError ? text : JSON.parse(text), isError: event.isError });
      }
    }, callSignal, (_model, context) => requestModel(input, context, model, callSignal));
    callSignal.throwIfAborted();
    const message = messages.findLast((message): message is AssistantMessage => message.role === "assistant");
    if (!message) throw new Error("AI 未返回结果");
    if (message.stopReason === "error" || message.stopReason === "aborted") throw new Error(message.errorMessage || "AI 请求失败");
    if (definitions.length && message.stopReason === "length") throw new Error("模型输出达到上限，请精简任务后重试");
    if (message.content.some(part => part.type === "toolCall")) throw new Error("AI 已达到 40 轮调用上限，请缩小任务后重试");
    const text = message.content.filter(part => part.type === "text").map(part => part.text).join("");
    const reasoning = message.content.filter(part => part.type === "thinking").map(part => part.thinking).join("");
    return { text, ...(reasoning ? { reasoning } : {}) };

  }

  return {
    getModels,
    getMediaModels,
    generateImage,
    generateVideo,
    generate,
    fetchMediaJob: (directory: string, jobKey: string, pollSignal?: AbortSignal) => fetchMediaJob(directory, jobKey, requestSignal(pollSignal)),
    retryMediaCollection: (directory: string, jobId: string, signal?: AbortSignal) => retryMediaCollection(directory, jobId, requestSignal(signal)),
    listMediaJobs: (directory: string, pollSignal?: AbortSignal) => listMediaJobs(directory, requestSignal(pollSignal)),
    pollMediaJob: (directory: string, jobKey: string, pollSignal: AbortSignal) => pollMediaJobUntilDone(directory, jobKey, requestSignal(pollSignal)),
  };
}
