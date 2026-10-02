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
    const graph = await readGraph(path, job.workspaceDirectory);
    const files = JSON.parse(job.resultJson) as { path: string; mimeType: string }[];
    if (!files[0]) throw new Error("任务没有可关联的文件");
    const value = { dataType: job.mediaType.toUpperCase(), value: { url: files[0].path, mimeType: files[0].mimeType } };
    const node = graph.nodes.find(item => item.id === job.nodeId);
    const pendingJobKey = (node?.data?.pendingMediaJob as { idempotencyKey?: unknown } | undefined)?.idempotencyKey;
    if (graph.toonflowGraph?.id === job.canvasId && pendingJobKey !== job.idempotencyKey
      && JSON.stringify(node?.data?.outputs?.[job.outputSlot]) === JSON.stringify(value)) {
      updateMediaJob(job.jobId, { linkStatus: "linked", errorMessage: null });
      return;
    }
    // 按节点上的待接收任务键关联：用户在生成期间改提示词、移动节点不影响结果写回；节点被删除重建或已放弃该任务则不写。
    if (graph.toonflowGraph?.id !== job.canvasId || (node?.data?.pendingMediaJob as { idempotencyKey?: unknown } | undefined)?.idempotencyKey !== job.idempotencyKey) {
      updateMediaJob(job.jobId, { linkStatus: "unlinked", errorMessage: "原节点已删除或不再等待该任务；成果保留在项目任务列表" });
      return;
    }
    // 旧版已写输出回执却未清等待标记，使用固定的补办操作，仍由输出版本和任务键共同校验。
    const operationId = graph.toonflowGraph.receipts[job.jobId] ? `${job.jobId}:clearPending` : job.jobId;
    await modifyGraph(path, operationId, [{ kind: "output", nodeId: job.nodeId, slot: job.outputSlot,
      expectedVersion: job.outputVersion, pendingJobKey: job.idempotencyKey, value }], job.workspaceDirectory);
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

async function collectAssets(job: MediaJobRow, assets: unknown) {
  // 已拿到供应商结果后，任何校验/转换错误都属于收取失败，而不是提交结果未知。
  updateMediaJob(job.jobId, { status: "collecting", errorMessage: null });
  let snapshot: string | null = null;
  try {
    if (!Array.isArray(assets) || !assets.length) throw new Error("供应商没有返回可收取的媒体数组");
    const normalized = assets.map<MediaAsset>(asset => {
      if (!asset || typeof asset !== "object" || Array.isArray(asset) || asset.mediaType !== job.mediaType)
        throw new Error("供应商返回的媒体类型或内容无效");
      if (asset.mimeType !== undefined && typeof asset.mimeType !== "string") throw new Error("媒体 MIME 类型无效");
      const common = { mediaType: job.mediaType, mimeType: asset.mimeType ?? "" };
      if (asset.type === "binary") {
        if (!ArrayBuffer.isView(asset.data) || !("BYTES_PER_ELEMENT" in asset.data) || asset.data.BYTES_PER_ELEMENT !== 1
          || !asset.data.byteLength || asset.data.byteLength > 100 * 1024 * 1024) throw new Error("二进制媒体不是有效字节数组或超过 100 MB");
        return { ...common, type: "base64", data: Buffer.from(asset.data.buffer, asset.data.byteOffset, asset.data.byteLength).toString("base64") };
      }
      if (asset.type === "base64" && typeof asset.data === "string" && asset.data.length <= Math.ceil(100 * 1024 * 1024 / 3) * 4 + 1024)
        return { ...common, type: "base64", data: asset.data };
      if (asset.type === "url" && typeof asset.url === "string" && /^https?:\/\//i.test(asset.url))
        return { ...common, type: "url", url: asset.url };
      throw new Error("供应商返回的媒体快照无效");
    });
    // 只持久化已校验字段，不序列化供应商原对象（可能含循环引用、getter 或无效 binary）。
    snapshot = JSON.stringify(normalized);
    updateMediaJob(job.jobId, { pendingAssetsJson: snapshot });
    const request = JSON.parse(job.requestJson) as MediaGenerationRequest;
    const files = await persistProviderAssets(job.workspaceDirectory, job.mediaType, job.jobId, request, normalized, undefined, {
      files: job.collectedFilesJson ? JSON.parse(job.collectedFilesJson) as CollectedMedia[] : [],
      save: files => updateMediaJob(job.jobId, { collectedFilesJson: JSON.stringify(files) }),
    });
    updateMediaJob(job.jobId, { status: "completed", resultJson: JSON.stringify(files), pendingAssetsJson: null, errorMessage: null });
    await linkCompletedMedia(findMediaJobById(job.jobId)!);
  } catch (err) {
    const message = Error.isError(err) ? err.message : "保存生成结果失败";
    updateMediaJob(job.jobId, { status: "collectionFailed", pendingAssetsJson: snapshot,
      errorMessage: snapshot ? message : `${message}；没有可恢复的结果快照，${job.remoteTaskId ? "可手动重试查询原任务收取" : "请在供应商侧核对原结果，不会重新生成"}` });
  }
}

async function pollRemoteTask(job: MediaJobRow, provider: LoadedMediaProvider) {
  const capability = providerAsyncCapability(provider, job.mediaType);
  if (!capability.query) {
    updateMediaJob(job.jobId, { status: "unknown", errorMessage: "供应商不支持按任务 ID 续查，请人工核对原任务" });
    return;
  }
  while (true) {
    const current = findMediaJobById(job.jobId);
    if (!current || current.status === "failed" || current.status === "unknown") return;
    const taskId = current.remoteTaskId;
    if (!taskId) {
      updateMediaJob(job.jobId, { status: "unknown", errorMessage: "缺少远端任务 ID，请人工核对原提交" });
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
      if (!queryResult || typeof queryResult !== "object" || !["pending", "completed", "failed"].includes(queryResult.status))
        throw Object.assign(new Error("供应商查询状态无效，请人工核对原任务"), { retryable: false });
    } catch (err) {
      const message = Error.isError(err) ? err.message : String(err);
      const status = (err as { status?: unknown } | null)?.status;
      // 4xx 默认需要人工处理；仅 408（超时）、425（Too Early）、429（限流）允许原查询重试。
      // 409 需要解决请求与任务状态的冲突；没有供应商明确约定时，不能假定重复同一请求会恢复。
      if ((err as { retryable?: unknown } | null)?.retryable === false
        || (typeof status === "number" && status >= 400 && status < 500 && ![408, 425, 429].includes(status))) {
        // 查询被拒绝不代表生成失败：保留远端 ID 和节点占用，不重新提交生成。
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
    if (!Array.isArray(queryResult.assets) || !queryResult.assets.length) {
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

  if (options.collectionOnly || job.status === "collecting") {
    let assets: MediaAsset[] | undefined;
    try { assets = parsePendingAssets(job.pendingAssetsJson); }
    catch { /* 无法还原的历史快照只允许手动续查原任务，不能重提生成。 */ }
    if (assets?.length) {
      await collectAssets(job, assets);
      return;
    }
    if (options.collectionOnly && job.remoteTaskId) {
      updateMediaJob(jobId, { status: "tracking", pendingAssetsJson: null, errorMessage: null });
      job = findMediaJobById(jobId)!;
    } else {
      updateMediaJob(jobId, { status: "collectionFailed", pendingAssetsJson: null, errorMessage: "没有有效的结果快照，请核对原任务；不会重新生成" });
      return;
    }
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
      ...(job.status === "prepared" ? { status: "failed" as const } : {}),
      ...(job.status === "collecting" ? { status: "collectionFailed" as const } : {}),
      ...(job.status === "tracking" ? { status: "unknown" as const } : {}),
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
