import type { MediaGenerationRequest } from "@toonflow/tools-scaffold/runtime";
import type { CollectedMedia, LoadedMediaProvider } from "@/utils/media/generation";
import {
  findMediaJobById,
  updateMediaJob,
  type MediaJobRow,
} from "@/utils/media/jobLedger";
import { parsePendingAssets, providerAsyncCapability } from "@/utils/media/jobCapabilities";
import {
  buildProviderMediaRequest,
  generateProviderAssets,
  mediaInputDirectory,
  loadMediaGenerationProvider,
  persistProviderAssets,
} from "@/utils/media/generation";
import { readGraph, modifyGraph } from "@/utils/workspace/graph";
import { resolveWorkspacePath } from "@/utils/workspace/files";

const activeRuns = new Map<string, Promise<void>>();

function sleep(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(signal.reason ?? new Error("aborted"));
    }, { once: true });
  });
}

async function failJob(jobId: string, message: string) {
  updateMediaJob(jobId, { status: "failed", errorMessage: message });
}
async function linkCompletedMedia(job: MediaJobRow) {
  if (job.linkStatus !== "pending" || !job.canvasId || !job.canvasPath || !job.nodeId || !job.outputSlot || job.outputVersion === null || !job.resultJson) return;
  try {
    const { path } = await resolveWorkspacePath(job.workspaceDirectory, job.canvasPath);
    const graph = await readGraph(path);
    const files = JSON.parse(job.resultJson) as { path: string; mimeType: string }[];
    if (!files[0]) throw new Error("任务没有可关联的文件");
    const value = { dataType: job.mediaType.toUpperCase(), value: { url: files[0].path, mimeType: files[0].mimeType } };
    const node = graph.nodes.find(item => item.id === job.nodeId);
    if (graph.toonflowGraph?.receipts[job.jobId]
      || (graph.toonflowGraph?.id === job.canvasId && JSON.stringify(node?.data?.outputs?.[job.outputSlot]) === JSON.stringify(value))) {
      updateMediaJob(job.jobId, { linkStatus: "linked", errorMessage: null });
      return;
    }
    // 按节点上的待接收任务键关联：用户在生成期间改提示词、移动节点不影响结果写回；节点被删除重建或已放弃该任务则不写。
    if (graph.toonflowGraph?.id !== job.canvasId || (node?.data?.pendingMediaJob as { idempotencyKey?: unknown } | undefined)?.idempotencyKey !== job.idempotencyKey) {
      updateMediaJob(job.jobId, { linkStatus: "unlinked", errorMessage: "原节点已删除或不再等待该任务；成果保留在项目任务列表" });
      return;
    }
    await modifyGraph(path, job.jobId, [{ kind: "output", nodeId: job.nodeId, slot: job.outputSlot,
      expectedVersion: job.outputVersion, pendingJobKey: job.idempotencyKey, value }]);
    updateMediaJob(job.jobId, { linkStatus: "linked", errorMessage: null });
  } catch (error) {
    const status = (error as { status?: number }).status;
    const code = (error as NodeJS.ErrnoException).code;
    if ((status === 409 && code !== "EBUSY") || code === "ENOENT")
      updateMediaJob(job.jobId, { linkStatus: "unlinked", errorMessage: "结果关联冲突或画布已移动；成果保留在项目任务列表" });
    else {
      updateMediaJob(job.jobId, { errorMessage: error instanceof Error ? error.message : "关联结果失败" });
      setTimeout(() => scheduleMediaJobRun(job.jobId), 3000);
    }
  }
}

async function collectAssets(job: MediaJobRow, assets: MediaAsset[]) {
  // Uint8Array 的 JSON 结果不是二进制；落账前转成可重启恢复的 base64 快照。
  assets = assets.map(asset => asset.type === "binary"
    ? { type: "base64", mediaType: asset.mediaType, mimeType: asset.mimeType, data: Buffer.from(asset.data).toString("base64") }
    : asset);
  updateMediaJob(job.jobId, {
    status: "collecting",
    pendingAssetsJson: JSON.stringify(assets),
    errorMessage: null,
  });
  const request = JSON.parse(job.requestJson) as MediaGenerationRequest;
  try {
    const files = await persistProviderAssets(job.workspaceDirectory, job.mediaType, job.jobId, request, assets, undefined, {
      files: job.collectedFilesJson ? JSON.parse(job.collectedFilesJson) as CollectedMedia[] : [],
      save: files => updateMediaJob(job.jobId, { collectedFilesJson: JSON.stringify(files) }),
    });
    updateMediaJob(job.jobId, {
      status: "completed",
      resultJson: JSON.stringify(files),
      pendingAssetsJson: null,
      errorMessage: null,
    });
    await linkCompletedMedia(findMediaJobById(job.jobId)!);
  } catch (err) {
    const message = err instanceof Error ? err.message : "保存生成结果失败";
    updateMediaJob(job.jobId, {
      status: "collectionFailed",
      pendingAssetsJson: JSON.stringify(assets),
      errorMessage: message,
    });
  }
}

async function pollRemoteTask(job: MediaJobRow, provider: LoadedMediaProvider) {
  const capability = providerAsyncCapability(provider, job.mediaType);
  if (!capability.query) {
    await failJob(job.jobId, "供应商不支持按任务 ID 续查");
    return;
  }
  while (true) {
    const current = findMediaJobById(job.jobId);
    if (!current || current.status === "failed" || current.status === "unknown") return;
    const taskId = current.remoteTaskId;
    if (!taskId) {
      await failJob(job.jobId, "缺少远端任务 ID");
      return;
    }
    let queryResult;
    try {
      if (job.mediaType === "image") {
        if (typeof provider.queryImageTask !== "function") throw new Error("供应商不支持图片任务续查");
        queryResult = await provider.queryImageTask(taskId);
      } else if (job.mediaType === "video") {
        if (typeof provider.queryVideoTask !== "function") throw new Error("供应商不支持视频任务续查");
        queryResult = await provider.queryVideoTask(taskId);
      } else {
        if (typeof provider.queryAudioTask !== "function") throw new Error("供应商不支持音频任务续查");
        queryResult = await provider.queryAudioTask(taskId);
      }
    } catch (err) {
      const message = Error.isError(err) ? err.message : String(err);
      const status = (err as { status?: unknown } | null)?.status;
      if (typeof status === "number" && [401, 403, 404, 410].includes(status)) {
        // 查询被拒绝不代表生成失败：保留远端 ID 和节点占用，停止确定无效的自动轮询。
        updateMediaJob(job.jobId, { status: "unknown", errorMessage: `${message}；已暂停查询，远端任务 ID 已保留，请核对供应商权限与任务状态；不会重新提交生成` });
        return;
      }
      updateMediaJob(job.jobId, { errorMessage: message });
      await sleep(3000);
      continue;
    }
    if (queryResult.status === "pending") {
      await sleep(3000);
      continue;
    }
    if (queryResult.status === "failed") {
      await failJob(job.jobId, queryResult.errorMessage ?? "远端生成失败");
      return;
    }
    if (!queryResult.assets?.length) {
      await failJob(job.jobId, "远端已完成但没有可收取的媒体");
      return;
    }
    await collectAssets(job, queryResult.assets);
    return;
  }
}

async function runAsyncProvider(job: MediaJobRow, provider: LoadedMediaProvider, request: MediaGenerationRequest) {
  const capability = providerAsyncCapability(provider, job.mediaType);
  if (typeof capability.submit !== "function" || typeof capability.query !== "function") {
    updateMediaJob(job.jobId, { recoveryMode: "sync" });
    await runSyncProvider(job, provider, request);
    return;
  }
  let providerRequest;
  try { providerRequest = await buildProviderMediaRequest(job.workspaceDirectory, job.mediaType, request, provider, undefined, mediaInputDirectory(job.jobId)); }
  catch (err) { await failJob(job.jobId, err instanceof Error ? err.message : "媒体输入无效"); return; }
  updateMediaJob(job.jobId, { status: "submitting", recoveryMode: "async", errorMessage: null });
  let taskId = job.remoteTaskId ?? undefined;
  if (!taskId) {
    try {
      const submitted = job.mediaType === "image"
        ? await provider.submitImage!(providerRequest as never)
        : job.mediaType === "video"
        ? await provider.submitVideo!(providerRequest as never)
        : await provider.submitAudio!(providerRequest as never);
      if (typeof submitted.taskId !== "string" || !submitted.taskId.trim()) throw new Error("供应商未返回有效任务 ID；需人工核对原提交");
      taskId = submitted.taskId;
      updateMediaJob(job.jobId, { remoteTaskId: taskId, status: "tracking" });
    } catch (err) {
      updateMediaJob(job.jobId, { status: provider.requestStarted ? "unknown" : "failed", errorMessage: Error.isError(err) ? err.message : String(err) });
      return;
    }
  } else {
    updateMediaJob(job.jobId, { status: "tracking" });
  }
  await pollRemoteTask(findMediaJobById(job.jobId)!, provider);
}

async function runSyncProvider(job: MediaJobRow, provider: LoadedMediaProvider, request: MediaGenerationRequest) {
  let providerRequest;
  try { providerRequest = await buildProviderMediaRequest(job.workspaceDirectory, job.mediaType, request, provider, undefined, mediaInputDirectory(job.jobId)); }
  catch (err) { await failJob(job.jobId, err instanceof Error ? err.message : "媒体输入无效"); return; }
  updateMediaJob(job.jobId, { status: "submitting", recoveryMode: "sync", errorMessage: null });
  try {
    const assets = await generateProviderAssets(job.workspaceDirectory, job.mediaType, request, provider, undefined, providerRequest);
    await collectAssets(job, assets);
  } catch (err) {
    updateMediaJob(job.jobId, { status: provider.requestStarted ? "unknown" : "failed", errorMessage: Error.isError(err) ? err.message : String(err) });
  }
}

async function executeMediaJob(jobId: string, options: { collectionOnly?: boolean } = {}) {
  let job = findMediaJobById(jobId);
  if (!job) return;
  if (job.status === "completed") {
    await linkCompletedMedia(job);
    return;
  }
  if (job.status === "failed" || job.status === "unknown") return;

  if (job.status === "submitting" && job.remoteTaskId) {
    updateMediaJob(jobId, { status: "tracking" });
    job = findMediaJobById(jobId)!;
  }

  if (options.collectionOnly) {
    const assets = parsePendingAssets(job.pendingAssetsJson);
    if (!assets?.length) return;
    await collectAssets(job, assets);
    return;
  }

  if (job.status === "tracking") {
    const request = JSON.parse(job.requestJson) as MediaGenerationRequest;
    let provider: LoadedMediaProvider;
    try { provider = await loadMediaGenerationProvider(job.workspaceDirectory, job.mediaType, request, undefined, job.providerRevision); }
    catch (error) {
      updateMediaJob(job.jobId, { status: "unknown", errorMessage: Error.isError(error) ? error.message : String(error) });
      return;
    }
    await pollRemoteTask(job, provider);
    return;
  }

  if (job.status === "collecting") {
    const assets = parsePendingAssets(job.pendingAssetsJson);
    if (assets?.length) await collectAssets(job, assets);
    return;
  }

  if (job.status === "collectionFailed") return;

  if (job.status === "submitting") {
    updateMediaJob(jobId, { status: "unknown", errorMessage: "提交结果未知，需人工核对；不会自动重新生成" });
    return;
  }
  if (job.status !== "prepared") return;

  const request = JSON.parse(job.requestJson) as MediaGenerationRequest;
  let provider: LoadedMediaProvider;
  try {
    provider = await loadMediaGenerationProvider(job.workspaceDirectory, job.mediaType, request, undefined, job.providerRevision);
  } catch (err) {
    await failJob(jobId, Error.isError(err) ? err.message : String(err));
    return;
  }

  const capability = providerAsyncCapability(provider, job.mediaType);
  const canAsync = typeof capability.submit === "function" && typeof capability.query === "function";
  if (canAsync) await runAsyncProvider(job, provider, request);
  else await runSyncProvider(job, provider, request);
}

export function runMediaJob(jobId: string, options: { collectionOnly?: boolean } = {}) {
  const active = activeRuns.get(jobId);
  if (active) return active;
  const task = executeMediaJob(jobId, options).catch(error => {
    const job = findMediaJobById(jobId);
    if (job) updateMediaJob(jobId, {
      ...(job.status === "submitting" && !job.remoteTaskId ? { status: "unknown" as const } : {}),
      ...(job.status === "collecting" ? { status: "collectionFailed" as const } : {}),
      errorMessage: Error.isError(error) ? error.message : String(error),
    });
    throw error;
  }).finally(() => { activeRuns.delete(jobId); });
  activeRuns.set(jobId, task);
  return task;
}

export function scheduleMediaJobRun(jobId: string, options: { collectionOnly?: boolean } = {}) {
  // 后台错误已落账；不能因无人 await 的拒绝导致整个服务退出。
  void runMediaJob(jobId, options).catch(error => console.error("媒体任务执行失败", jobId, error));
}
