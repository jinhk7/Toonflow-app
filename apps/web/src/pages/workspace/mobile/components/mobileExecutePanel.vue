<template>
  <el-card class="mobileExecutePanel" shadow="never">
    <template #header>执行与任务</template>
    <p class="note">媒体生成需手动提交；Agent 运行与待确认由项目账本读取。</p>

    <template v-if="isMediaNode && node && graph && canvasPath">
      <el-alert v-if="pendingJob" type="warning" :closable="false" showIcon :title="pendingStatus === 'unknown' ? '任务结果未知，节点仍被占用' : '节点有未完成任务'">
        <p>幂等键：{{ pendingJob.idempotencyKey }}</p>
        <p>状态：{{ pendingStatus || "未知（可查询）" }}</p>
        <p v-if="pendingError">原因：{{ pendingError }}</p>
        <p v-if="pendingStatus === 'unknown'">服务可能仍在生成或已计费；核对服务端后可放弃该任务，再重新提交。</p>
        <p v-if="pendingStatus === 'missing'">未找到任务记录；请核对服务端，确认放弃这次提交后可解除占用。</p>
      </el-alert>
      <el-descriptions :column="1" size="small" border class="summary">
        <el-descriptions-item label="节点类型">{{ mediaTypeLabel }}</el-descriptions-item>
        <el-descriptions-item label="模型">{{ modelSummary }}</el-descriptions-item>
        <el-descriptions-item label="提示词">{{ promptPreview || "（空）" }}</el-descriptions-item>
        <el-descriptions-item label="参考素材">{{ referenceSummary }}</el-descriptions-item>
      </el-descriptions>
      <div class="actions">
        <el-button type="primary" :loading="submitLoading" :disabled="!canSubmitMedia" @click="submitMediaGeneration">
          提交{{ mediaTypeLabel }}生成
        </el-button>
        <el-button :loading="mediaLoading" :disabled="!directory || !queryKey" @click="queryMediaJob()">查询媒体任务</el-button>
        <el-button v-if="pendingJob && ['unknown', 'missing'].includes(pendingStatus)" type="danger" plain :loading="abandonLoading" :disabled="submitLoading" @click="abandonUnknownJob">
          放弃该任务并解锁
        </el-button>
        <el-button :loading="listLoading" :disabled="!directory" @click="listMediaJobs">列出工作区媒体任务</el-button>
      </div>
      <p v-if="submitHint" class="hint">{{ submitHint }}</p>
    </template>

    <el-form v-else labelPosition="top" size="small" class="genericForm">
      <el-form-item label="媒体任务幂等键（可选，查询用）">
        <el-input v-model="idempotencyKey" placeholder="节点 pendingMediaJob 或手动输入" />
      </el-form-item>
      <el-button :loading="mediaLoading" :disabled="!directory || !idempotencyKey" @click="queryMediaJob()">查询媒体任务</el-button>
      <el-button :loading="listLoading" :disabled="!directory" @click="listMediaJobs">列出工作区媒体任务</el-button>
    </el-form>

    <mobileAgentPanel :directory="directory" />

    <el-alert v-if="mediaResult" class="result" type="info" :closable="false" :title="mediaTitle">
      <pre class="json">{{ mediaResult }}</pre>
    </el-alert>
  </el-card>
</template>

<script setup lang="ts">
import { computed, onScopeDispose, ref, watch } from "vue";
import axios from "axios";
import { ElMessage, ElMessageBox } from "element-plus";
import type { WorkspaceGraph, GraphChange } from "@/lib/workspaceFiles";
import mobileAgentPanel from "./mobileAgentPanel.vue";
import type { CanvasNode } from "../lib/mobileGraphModel";
import { changeForNode } from "../lib/mobileGraphOps";
import type { PendingMediaJobState } from "@toonflow/nodes-scaffold/nodeAi";
import useWorkspaceFiles from "@/lib/workspaceFiles";
import type { NodeMediaModel } from "@toonflow/nodes-scaffold/nodeAi";

const props = defineProps<{
  directory: string;
  canvasPath?: string;
  node?: CanvasNode | null;
  graph?: WorkspaceGraph | null;
  persistNode?: (changes: GraphChange[]) => Promise<unknown>;
}>();

const idempotencyKey = ref("");
const mediaLoading = ref(false);
const listLoading = ref(false);
const submitLoading = ref(false);
const mediaResult = ref("");
const mediaTitle = ref("");
const pendingStatus = ref("");
const pendingError = ref("");
const abandonLoading = ref(false);
let queryRevision = 0;
let queryTimer: ReturnType<typeof setTimeout> | undefined;
let disposed = false;
onScopeDispose(() => { disposed = true; queryRevision++; clearTimeout(queryTimer); });

const isImageNode = computed(() => props.node?.type === "remote-imageGenerationNode");
const isVideoNode = computed(() => props.node?.type === "remote-videoGenerationNode");
const isMediaNode = computed(() => isImageNode.value || isVideoNode.value);
const mediaType = computed(() => (isVideoNode.value ? "video" : "image"));
const mediaTypeLabel = computed(() => (isVideoNode.value ? "视频" : "图片"));
const outputSlot = computed(() => (isVideoNode.value ? "video" : "image"));

const nodeData = computed(() => (props.node?.data ?? {}) as Record<string, unknown>);
const pendingJob = computed(() => {
  const pending = nodeData.value.pendingMediaJob;
  if (!pending || typeof pending !== "object") return undefined;
  const state = pending as Partial<PendingMediaJobState>;
  if (typeof state.idempotencyKey !== "string") return undefined;
  return state as PendingMediaJobState;
});

type MediaJobSummary = { status?: string; linkStatus?: string; idempotencyKey: string; canvasId: string | null; nodeId: string | null; outputSlot: string | null; errorMessage?: string | null };

const queryKey = computed(() => idempotencyKey.value || pendingJob.value?.idempotencyKey || "");

watch([() => props.directory, () => props.canvasPath, () => props.node?.id, () => pendingJob.value?.idempotencyKey], () => {
  clearTimeout(queryTimer);
  queryRevision++;
  mediaLoading.value = false;
  pendingStatus.value = "";
  pendingError.value = "";
  idempotencyKey.value = pendingJob.value?.idempotencyKey ?? "";
  if (idempotencyKey.value) void queryMediaJob();
}, { immediate: true });

const promptPreview = computed(() => {
  const prompt = nodeData.value.prompt;
  return typeof prompt === "string" ? prompt.trim() : "";
});

const parsedModel = computed(() => {
  const raw = nodeData.value.model;
  if (typeof raw !== "string" || !raw) return undefined;
  try {
    const [providerId, modelId] = JSON.parse(raw) as [string, string];
    if (!providerId || !modelId) return undefined;
    return { providerId, modelId };
  } catch {
    return undefined;
  }
});

const modelSummary = computed(() => parsedModel.value ? `${parsedModel.value.providerId} / ${parsedModel.value.modelId}` : "未选择");

type RefOutput = { dataType?: string; value?: unknown };

function incomingReferences() {
  if (!props.graph || !props.node) return [] as { edgeId: string; output?: RefOutput }[];
  const byId = new Map(props.graph.nodes.map(item => [item.id, item]));
  const refs: { edgeId: string; output?: RefOutput }[] = [];
  for (const edge of props.graph.edges) {
    if (edge.target !== props.node.id || edge.targetHandle !== "in") continue;
    const peer = byId.get(edge.source);
    const output = peer?.data?.outputs?.[edge.sourceHandle ?? ""] as RefOutput | undefined;
    refs.push({ edgeId: edge.id, output });
  }
  return refs;
}

const referenceSummary = computed(() => {
  const refs = incomingReferences();
  if (!refs.length) return "无连接引用";
  const missing = refs.filter(item => item.output?.value === undefined).length;
  const images = refs.filter(item => item.output?.dataType === "IMAGE" && item.output.value).length;
  const videos = refs.filter(item => item.output?.dataType === "VIDEO" && item.output.value).length;
  const audios = refs.filter(item => item.output?.dataType === "AUDIO" && item.output.value).length;
  const texts = refs.filter(item => item.output?.dataType === "STRING" && typeof item.output.value === "string" && item.output.value.trim()).length;
  return `共 ${refs.length} 条入边；图片 ${images}、视频 ${videos}、音频 ${audios}、文本 ${texts}${missing ? `；缺失 ${missing} 项` : ""}`;
});

const submitHint = computed(() => {
  if (!isMediaNode.value) return "";
  if (!parsedModel.value) return "请先在上方生成设置中选择并保存有效模型。";
  if (!promptPreview.value) return "请填写提示词后再提交。";
  if (incomingReferences().some(item => item.output?.value === undefined)) return "存在未就绪的引用素材，请补充上游节点输出。";
  if (!props.canvasPath || !props.persistNode) return "缺少画布路径或保存能力，无法写入 pendingMediaJob。";
  return "";
});

const canSubmitMedia = computed(() => isMediaNode.value && !submitHint.value && !pendingJob.value && !submitLoading.value && !!props.directory);

function buildGenerationPrompt() {
  const refs = incomingReferences();
  const strings = refs.flatMap((item, index) => {
    const value = item.output;
    if (value?.dataType === "STRING" && typeof value.value === "string" && value.value.trim()) {
      return [`参考 ${index + 1}：\n${value.value.trim()}`];
    }
    return [];
  });
  return [promptPreview.value, ...strings].filter(Boolean).join("\n\n");
}

function buildReferencePayload() {
  const refs = incomingReferences();
  const images = refs.flatMap(item => item.output?.dataType === "IMAGE" && item.output.value && typeof item.output.value === "object"
    ? [{ path: (item.output.value as { url: string; mimeType: string }).url, mimeType: (item.output.value as { url: string; mimeType: string }).mimeType }]
    : []);
  const videos = refs.flatMap(item => item.output?.dataType === "VIDEO" && item.output.value && typeof item.output.value === "object"
    ? [{ path: (item.output.value as { url: string; mimeType: string }).url, mimeType: (item.output.value as { url: string; mimeType: string }).mimeType }]
    : []);
  const audios = refs.flatMap(item => item.output?.dataType === "AUDIO" && item.output.value && typeof item.output.value === "object"
    ? [{ path: (item.output.value as { url: string; mimeType: string }).url, mimeType: (item.output.value as { url: string; mimeType: string }).mimeType }]
    : []);
  return { images, videos, audios };
}

async function persistPendingJob(key: string) {
  if (!props.node || !props.graph || !props.canvasPath || !props.persistNode) throw new Error("无法保存节点状态");
  const directory = props.directory;
  const canvasPath = props.canvasPath;
  const nodeId = props.node.id;
  const expectedVersion = props.graph.toonflowGraph.nodes[props.node.id] ?? 0;
  const pendingMediaJob: PendingMediaJobState = {
    idempotencyKey: key,
    outputSlot: outputSlot.value,
    canvasPath: props.canvasPath,
    expectedNodeVersion: expectedVersion + 1,
    startedAt: Date.now(),
  };
  const value = {
    ...props.node,
    data: {
      ...props.node.data,
      pendingMediaJob,
    },
  };
  await props.persistNode([changeForNode(props.graph, value, props.node.id)]);
  if (!disposed && props.directory === directory && props.canvasPath === canvasPath && props.node?.id === nodeId) idempotencyKey.value = key;
  return expectedVersion + 1;
}

async function submitMediaGeneration() {
  if (!canSubmitMedia.value || !props.node || !parsedModel.value) return;
  const directory = props.directory;
  const canvasPath = props.canvasPath;
  const nodeId = props.node.id;
  const model = parsedModel.value;
  const image = isImageNode.value;
  const nodeDataSnapshot = { ...nodeData.value };
  const { images, videos, audios } = buildReferencePayload();
  const prompt = buildGenerationPrompt();
  const current = () => !disposed && props.directory === directory && props.canvasPath === canvasPath && props.node?.id === nodeId;
  submitLoading.value = true;
  mediaResult.value = "";
  const key = crypto.randomUUID();
  try {
    const body: Record<string, unknown> = {
      directory, mediaType: image ? "image" : "video", idempotencyKey: key, wait: false,
      providerId: model.providerId, modelId: model.modelId, prompt,
      outputDirectory: `assets/${nodeId}`, canvasPath, nodeId, outputSlot: image ? "image" : "video",
    };
    if (image) {
      const { data } = await axios.get<{ code: number; data: NodeMediaModel[]; message?: string }>("/api/ai/media/models");
      if (data.code !== 200) throw new Error(data.message || "读取模型失败");
      const choice = data.data.find(item => item.providerId === model.providerId && item.modelId === model.modelId && item.type === "image");
      if (!choice) throw new Error("所选图片模型已变化，请重新选择");
      // 未声明的选项不替供应商猜默认值，也不沿用旧模型的比例或尺寸。
      Object.assign(body, {
        size: choice.imageSizes?.includes(String(nodeDataSnapshot.size)) ? nodeDataSnapshot.size : undefined,
        ratio: choice.imageRatios?.includes(String(nodeDataSnapshot.ratio)) ? nodeDataSnapshot.ratio : undefined,
        images,
      });
    } else {
      const modeRaw = nodeDataSnapshot.mode;
      let mode: unknown;
      if (typeof modeRaw === "string" && modeRaw) {
        try { mode = JSON.parse(modeRaw); } catch { mode = modeRaw; }
      }
      Object.assign(body, { mode, duration: nodeDataSnapshot.duration,
        resolution: nodeDataSnapshot.resolution || undefined, ratio: nodeDataSnapshot.ratio,
        generateAudio: nodeDataSnapshot.generateAudio, images, videos, audios });
    }
    if (!current()) return;
    body.expectedNodeVersion = await persistPendingJob(key);
    const { data } = await axios.post<{ code: number; data?: MediaJobSummary; message?: string }>("/api/ai/media/generate", body, {
    });
    if (!current()) return;
    if (data.code !== 200 && data.code !== 202) throw new Error(data.message || "提交失败");
    mediaTitle.value = "已提交媒体任务";
    mediaResult.value = JSON.stringify(data.data, null, 2);
    pendingStatus.value = data.data?.status ?? "prepared";
    ElMessage.success("已提交，正在跟踪任务进度");
    await queryMediaJob();
  } catch (err) {
    if (!current()) return;
    const message = axios.isAxiosError(err) ? err.response?.data?.message || err.message : err instanceof Error ? err.message : String(err);
    mediaTitle.value = "提交失败";
    mediaResult.value = message;
    ElMessage.error(message);
    if (axios.isAxiosError(err) && err.response && pendingJob.value?.idempotencyKey === key) await queryMediaJob(message);
  } finally {
    submitLoading.value = false;
  }
}

async function queryMediaJob(rejection?: string) {
  const directory = props.directory;
  const canvasPath = props.canvasPath;
  const nodeId = props.node?.id;
  const key = queryKey.value;
  if (!directory || !key) return;
  clearTimeout(queryTimer);
  const revision = ++queryRevision;
  let continueQuery = false;
  const current = () => revision === queryRevision && props.directory === directory && props.canvasPath === canvasPath && props.node?.id === nodeId;
  mediaLoading.value = true;
  mediaResult.value = "";
  try {
    const { data } = await axios.get<{ code: number; data?: MediaJobSummary; message?: string }>("/api/ai/media/getJob", {
      params: { directory, idempotencyKey: key },
    });
    if (!current()) return;
    if (data.code !== 200) throw new Error(data.message || "查询失败");
    const job = data.data;
    continueQuery = !!job && (["prepared", "submitting", "tracking", "collecting"].includes(job.status ?? "") || (job.status === "completed" && job.linkStatus === "pending"));
    pendingStatus.value = job?.status ?? "missing";
    pendingError.value = job?.errorMessage ?? "";
    mediaTitle.value = "媒体任务";
    mediaResult.value = job ? JSON.stringify(job, null, 2) : rejection ?? "未找到媒体任务";
    // 服务端在建任务前拒绝的提交没有记录；只有确认已完成、已失败或被拒绝才解除占用，结果由服务端写回节点。
    const released = job
      ? ((job.status === "completed" && job.linkStatus !== "pending") || job.status === "failed") && job.idempotencyKey === key && job.canvasId === props.graph?.toonflowGraph.id
        && job.nodeId === props.node?.id && job.outputSlot === pendingJob.value?.outputSlot
      : rejection !== undefined;
    if (released && await clearPendingMarker(key) && props.directory === directory && props.canvasPath === canvasPath && props.node?.id === nodeId) {
      mediaTitle.value = !job ? "提交被拒绝且未创建任务，已解除占用；可修正后重新提交"
        : job.status === "completed" ? "媒体任务已完成，已解除占用" : "媒体任务已失败，已解除占用；可手动重新提交";
    }
  } catch (err) {
    if (!current()) return;
    mediaTitle.value = "查询或更新节点失败";
    mediaResult.value = err instanceof Error ? err.message : String(err);
  } finally {
    if (current()) {
      mediaLoading.value = false;
      if (pendingJob.value?.idempotencyKey === key && continueQuery) {
        queryTimer = setTimeout(() => { void queryMediaJob(); }, 3000);
      }
    }
  }
}

async function clearPendingMarker(key: string) {
  const directory = props.directory;
  const canvasPath = props.canvasPath;
  const nodeId = props.node?.id;
  if (pendingJob.value?.idempotencyKey !== key || !props.graph || !nodeId || !canvasPath || !props.persistNode) return false;
  const graph = await useWorkspaceFiles(directory).readGraph(canvasPath);
  if (props.directory !== directory || props.canvasPath !== canvasPath || props.node?.id !== nodeId || graph.toonflowGraph.id !== props.graph?.toonflowGraph.id) return false;
  const node = graph.nodes.find(item => item.id === nodeId);
  if (!node || (node.data?.pendingMediaJob as PendingMediaJobState | undefined)?.idempotencyKey !== key) return false;
  const value = { ...node, data: { ...node.data } };
  delete value.data.pendingMediaJob;
  await props.persistNode([changeForNode(graph, value, nodeId)]);
  return true;
}

// 结果未知的任务不会再写回节点；只有用户确认后才解除占用，账本保留 unknown 记录供核对。
async function abandonUnknownJob() {
  const directory = props.directory;
  const key = pendingJob.value?.idempotencyKey;
  const canvasPath = props.canvasPath;
  const canvasId = props.graph?.toonflowGraph.id;
  const nodeId = props.node?.id;
  const slot = pendingJob.value?.outputSlot;
  const current = () => !disposed && props.directory === directory && props.canvasPath === canvasPath && props.node?.id === nodeId && pendingJob.value?.idempotencyKey === key;
  if (!directory || !key || submitLoading.value || abandonLoading.value) return;
  try {
    await ElMessageBox.confirm(
      "原任务结果未知，服务可能仍在生成或已计费。请先在服务端核对；放弃后原任务的结果不会写回节点，重新提交会产生新的生成请求。",
      "放弃该任务？",
      { type: "warning", confirmButtonText: "放弃并解锁", cancelButtonText: "取消" },
    );
  } catch { return; }
  if (!current()) return;
  abandonLoading.value = true;
  try {
    const { data } = await axios.get<{ code: number; data?: MediaJobSummary; message?: string }>("/api/ai/media/getJob", {
      params: { directory, idempotencyKey: key },
    });
    if (!current()) return;
    if (data.code !== 200) throw new Error(data.message || "查询失败");
    if (data.data && (data.data.status !== "unknown" || data.data.idempotencyKey !== key || data.data.canvasId !== canvasId || data.data.nodeId !== nodeId || data.data.outputSlot !== slot)) throw new Error("任务状态已变化，请重新查询后再操作");
    if (!await clearPendingMarker(key)) throw new Error("节点已变化，请刷新后重试");
    mediaTitle.value = "已解除原任务占用；可重新提交";
    mediaResult.value = `原任务幂等键：${key}（${data.data ? "账本记录保留" : "未找到任务记录"}）`;
    ElMessage.success("已解除占用");
  } catch (err) {
    ElMessage.error(axios.isAxiosError(err) ? err.response?.data?.message || err.message : err instanceof Error ? err.message : String(err));
  } finally {
    abandonLoading.value = false;
  }
}

async function listMediaJobs() {
  if (!props.directory) return;
  listLoading.value = true;
  mediaResult.value = "";
  try {
    const { data } = await axios.get<{ code: number; data?: unknown; message?: string }>("/api/ai/media/list", {
      params: { directory: props.directory },
    });
    if (data.code !== 200) throw new Error(data.message || "列表查询失败");
    mediaTitle.value = "媒体任务列表";
    mediaResult.value = JSON.stringify(data.data, null, 2);
  } catch (err) {
    const message = axios.isAxiosError(err) && err.response?.status === 404
      ? "媒体任务列表接口尚未就绪（服务端待实现）"
      : err instanceof Error ? err.message : String(err);
    mediaTitle.value = "列表查询失败";
    mediaResult.value = message;
  } finally {
    listLoading.value = false;
  }
}

</script>

<style lang="scss" scoped>
.mobileExecutePanel {
  margin-top: 12px;

  .note {
    margin: 0 0 12px;
    font-size: 12px;
    color: var(--el-text-color-secondary);
  }

  .summary {
    margin-bottom: 12px;
  }

  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    margin-bottom: 8px;
  }

  .hint {
    margin: 0 0 12px;
    font-size: 12px;
    color: var(--el-color-warning);
  }

  .genericForm,
  .result {
    margin-top: 12px;
  }

  .json {
    margin: 0;
    white-space: pre-wrap;
    word-break: break-word;
    font-size: 12px;
  }
}
</style>
