import { onScopeDispose } from "vue";
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

function requireBackendAction(): never {
  throw new Error("旧客户端执行入口已停用，请使用节点后端注册动作");
}

export function useNodeMediaPersistence(_nodeId: string, getData: () => Record<string, unknown>) {
  function readPending() { return getData().pendingMediaJob as PendingMediaJobState | undefined; }
  return {
    prepare: async (_outputSlot: string): Promise<{ idempotencyKey: string; binding: PrepareMediaJobResult }> => requireBackendAction(),
    clearPending: async (_outputSlot: string): Promise<void> => requireBackendAction(),
    releaseFailed: async (_outputSlot: string, _error: unknown): Promise<void> => requireBackendAction(),
    readPending, hasGraphPersistence: false,
  };
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
  const result = await response.json() as { code: number; message?: string; data: T };
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

  async function generateMedia<T extends "image" | "video">(_mediaType: T, _input: NodeImageRequest | NodeVideoRequest, _signal?: AbortSignal): Promise<{ path: string; mimeType: string; mediaType: T }[]> {
    return requireBackendAction();
  }

  function generateImage(input: NodeImageRequest, signal?: AbortSignal) {
    return generateMedia("image", input, signal);
  }

  function generateVideo(input: NodeVideoRequest, signal?: AbortSignal) {
    return generateMedia("video", input, signal);
  }

  async function generate(_input: NodeAiRequest): Promise<NodeAiResult> {
    return requireBackendAction();
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
