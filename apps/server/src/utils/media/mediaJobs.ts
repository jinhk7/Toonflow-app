import { realpath, rm } from "node:fs/promises";
import type { GeneratedMedia, MediaGenerationRequest } from "@toonflow/tools-scaffold/runtime";
import {
  findMediaJobById,
  findMediaJobByIdempotency,
  insertMediaJob,
  listResumableMediaJobs,
  markInterruptedSubmittingAsUnknown,
  type MediaJobRow,
  type MediaJobStatus,
} from "@/utils/media/jobLedger";
import { digestMediaRequest } from "@/utils/media/jobDigest";
import { runMediaJob, scheduleMediaJobRun } from "@/utils/media/jobRunner";
import { mediaInputDirectory, snapshotMediaRequest } from "@/utils/media/generation";
import { getMediaProvider } from "@/utils/media/provider";
import { readGraph } from "@/utils/workspace/graph";
import { resolveWorkspacePath } from "@/utils/workspace/files";
import { loadNodeExecution } from "@/utils/plugins/nodeExecution";
import { isTypeCompatible } from "@toonflow/nodes-scaffold/connection";

export type MediaJobView = {
  jobId: string;
  workspaceDirectory: string;
  idempotencyKey: string;
  status: MediaJobStatus;
  mediaType: MediaJobRow["mediaType"];
  providerRevision: string;
  canvasId: string | null;
  canvasPath: string | null;
  nodeId: string | null;
  outputSlot: string | null;
  linkStatus: MediaJobRow["linkStatus"];
  recoveryMode: MediaJobRow["recoveryMode"];
  remoteTaskId: string | null;
  errorMessage: string | null;
  files: GeneratedMedia[] | null;
  createdAt: number;
  updatedAt: number;
  syncRecoveryLimited: boolean;
};

let initialized = false;

export function ensureMediaJobsReady() {
  if (initialized) return;
  markInterruptedSubmittingAsUnknown();
  for (const job of listResumableMediaJobs()) scheduleMediaJobRun(job.jobId);
  initialized = true;
}

export function toMediaJobView(row: MediaJobRow): MediaJobView {
  const files = row.resultJson ? JSON.parse(row.resultJson) as GeneratedMedia[] : null;
  return {
    workspaceDirectory: row.workspaceDirectory,
    jobId: row.jobId,
    idempotencyKey: row.idempotencyKey,
    status: row.status,
    mediaType: row.mediaType,
    providerRevision: row.providerRevision,
    canvasId: row.canvasId,
    canvasPath: row.canvasPath,
    nodeId: row.nodeId,
    outputSlot: row.outputSlot,
    linkStatus: row.linkStatus,
    recoveryMode: row.recoveryMode,
    remoteTaskId: row.remoteTaskId,
    errorMessage: row.errorMessage,
    files,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    syncRecoveryLimited: row.recoveryMode === "sync" && row.status === "unknown",
  };
}

export type AcceptMediaJobInput = {
  cwd: string;
  mediaType: MediaJobRow["mediaType"];
  request: MediaGenerationRequest;
  idempotencyKey: string;
  binding?: { canvasPath: string; nodeId: string; outputSlot: string; expectedNodeVersion: number };
  snapshot?: { directory: string; request: MediaGenerationRequest };
};

export type AcceptMediaJobResult =
  | { kind: "accepted"; job: MediaJobView }
  | { kind: "conflict"; existing: MediaJobView };

export async function acceptMediaJob(input: AcceptMediaJobInput): Promise<AcceptMediaJobResult> {
  ensureMediaJobsReady();
  const directory = await realpath(input.cwd);
  const requestDigest = digestMediaRequest(input.mediaType, input.request, input.binding);
  const existing = findMediaJobByIdempotency(directory, input.idempotencyKey);
  if (existing) {
    if (existing.requestDigest !== requestDigest) {
      return { kind: "conflict", existing: toMediaJobView(existing) };
    }
    scheduleMediaJobRun(existing.jobId);
    return { kind: "accepted", job: toMediaJobView(findMediaJobById(existing.jobId)!) };
  }
  const provider = await getMediaProvider(input.request.providerId);
  if (!provider.models.some(model => model.id === input.request.modelId && model.type === input.mediaType))
    throw Object.assign(new Error("媒体模型不存在或类型不匹配"), { status: 400 });
  let binding: NonNullable<Parameters<typeof insertMediaJob>[0]["binding"]> | undefined;
  if (input.binding) {
    const { canvasPath, nodeId, outputSlot, expectedNodeVersion } = input.binding;
    const { path } = await resolveWorkspacePath(directory, canvasPath);
    const graph = await readGraph(path, directory);
    const node = graph.nodes.find(item => item.id === nodeId);
    const definition = node ? (await loadNodeExecution((node.type ?? "").replace(/^remote-/, ""))).definition : undefined;
    const handle = definition?.handles.find(item => item.type === "source" && item.id === outputSlot);
    const pending = node?.data?.pendingMediaJob as { idempotencyKey?: unknown; outputSlot?: unknown } | undefined;
    if (!node || !handle || !isTypeCompatible(input.mediaType.toUpperCase(), handle.dataType) || graph.toonflowGraph!.nodes[nodeId] !== expectedNodeVersion
      || pending?.idempotencyKey !== input.idempotencyKey || pending.outputSlot !== outputSlot)
      throw Object.assign(new Error("节点已变化或不再等待此任务，请刷新后重新确认生成"), { status: 409 });
    binding = { canvasId: graph.toonflowGraph!.id, canvasPath, nodeId, nodeVersion: expectedNodeVersion,
      outputSlot, outputVersion: graph.toonflowGraph!.outputs[JSON.stringify([nodeId, outputSlot])] ?? 0 };
  }
  const jobId = crypto.randomUUID();
  const snapshot = await snapshotMediaRequest(input.snapshot?.directory ?? directory, jobId, input.snapshot?.request ?? input.request);
  let row: MediaJobRow;
  try {
    row = insertMediaJob({
      jobId,
      idempotencyKey: input.idempotencyKey,
      requestDigest,
      workspaceDirectory: directory,
      mediaType: input.mediaType,
      requestJson: JSON.stringify(snapshot),
      providerId: input.request.providerId,
      modelId: input.request.modelId,
      providerRevision: provider.revision,
      binding,
    });
  } catch (error) {
    await rm(mediaInputDirectory(jobId), { recursive: true, force: true });
    const concurrent = findMediaJobByIdempotency(directory, input.idempotencyKey);
    if (!concurrent) throw error;
    if (concurrent.requestDigest !== requestDigest) return { kind: "conflict", existing: toMediaJobView(concurrent) };
    scheduleMediaJobRun(concurrent.jobId);
    return { kind: "accepted", job: toMediaJobView(concurrent) };
  }
  scheduleMediaJobRun(jobId);
  return { kind: "accepted", job: toMediaJobView(row) };
}

export function getMediaJob(jobId: string) {
  ensureMediaJobsReady();
  const row = findMediaJobById(jobId);
  return row ? toMediaJobView(row) : undefined;
}

export function getMediaJobByIdempotency(workspaceDirectory: string, idempotencyKey: string) {
  ensureMediaJobsReady();
  const row = findMediaJobByIdempotency(workspaceDirectory, idempotencyKey);
  return row ? toMediaJobView(row) : undefined;
}


export async function waitForMediaJob(jobId: string, options: { signal?: AbortSignal; pollMs?: number } = {}) {
  ensureMediaJobsReady();
  const pollMs = options.pollMs ?? 500;
  while (true) {
    options.signal?.throwIfAborted();
    const job = getMediaJob(jobId);
    if (!job) throw Object.assign(new Error("媒体任务不存在"), { status: 404 });
    if (job.status === "completed") {
      if (!job.files?.length) throw new Error("任务已完成但没有结果文件");
      return job.files;
    }
    if (job.status === "failed") throw new Error(job.errorMessage ?? "媒体生成失败");
    if (job.status === "unknown") {
      throw Object.assign(new Error(job.errorMessage ?? "提交状态未知，需人工核对"), { status: 409, job });
    }
    if (job.status === "collectionFailed") throw Object.assign(new Error(job.errorMessage ?? "收取媒体失败，可重试收取"), { status: 409, job });
    await new Promise(resolve => setTimeout(resolve, pollMs));
  }
}

export type GenerateMediaOptions = {
  signal?: AbortSignal;
  idempotencyKey?: string;
};

export async function submitAndWaitMediaJob(
  cwd: string,
  mediaType: MediaJobRow["mediaType"],
  request: MediaGenerationRequest,
  options: GenerateMediaOptions = {},
) {
  const idempotencyKey = options.idempotencyKey ?? crypto.randomUUID();
  const accepted = await acceptMediaJob({ cwd, mediaType, request, idempotencyKey });
  if (accepted.kind === "conflict") {
    throw Object.assign(new Error("相同幂等键的请求摘要不一致"), { status: 409, job: accepted.existing });
  }
  return waitForMediaJob(accepted.job.jobId, { signal: options.signal });
}

export async function retryMediaJobCollection(jobId: string, workspaceDirectory: string) {
  ensureMediaJobsReady();
  const row = findMediaJobById(jobId);
  if (!row || row.workspaceDirectory !== workspaceDirectory) throw Object.assign(new Error("媒体任务不存在"), { status: 404 });
  if (row.status !== "collectionFailed") {
    throw Object.assign(new Error("只有收取失败的任务可以重试下载"), { status: 400 });
  }
  if (!row.pendingAssetsJson && !row.remoteTaskId) {
    throw Object.assign(new Error("没有结果快照或远端任务 ID，请在供应商侧核对原结果；不会重新生成"), { status: 400 });
  }
  scheduleMediaJobRun(jobId, { collectionOnly: true });
  return toMediaJobView(findMediaJobById(jobId)!);
}

export { runMediaJob };
