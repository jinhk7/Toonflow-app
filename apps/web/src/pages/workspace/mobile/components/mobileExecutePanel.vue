<template>
  <el-card class="mobileExecutePanel" shadow="never">
    <template #header>执行与任务</template>
    <p class="note">媒体生成需手动提交；Agent 运行与待确认由项目账本读取。</p>

    <template v-if="isMediaNode && node && graph && canvasPath">
      <el-alert v-if="pendingJob" type="warning" :closable="false" showIcon title="节点有未完成任务">
        <p>幂等键：{{ pendingJob.idempotencyKey }}</p>
        <p>状态：{{ pendingStatus || "未知（可查询）" }}</p>
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
        <el-button :loading="mediaLoading" :disabled="!directory || !queryKey" @click="queryMediaJob">查询媒体任务</el-button>
        <el-button :loading="listLoading" :disabled="!directory" @click="listMediaJobs">列出工作区媒体任务</el-button>
      </div>
      <p v-if="submitHint" class="hint">{{ submitHint }}</p>
    </template>

    <el-form v-else labelPosition="top" size="small" class="genericForm">
      <el-form-item label="媒体任务幂等键（可选，查询用）">
        <el-input v-model="idempotencyKey" placeholder="节点 pendingMediaJob 或手动输入" />
      </el-form-item>
      <el-button :loading="mediaLoading" :disabled="!directory || !idempotencyKey" @click="queryMediaJob">查询媒体任务</el-button>
      <el-button :loading="listLoading" :disabled="!directory" @click="listMediaJobs">列出工作区媒体任务</el-button>
    </el-form>

    <mobileAgentPanel :directory="directory" />

    <el-alert v-if="mediaResult" class="result" type="info" :closable="false" :title="mediaTitle">
      <pre class="json">{{ mediaResult }}</pre>
    </el-alert>
  </el-card>
</template>

<script setup lang="ts">
import { computed, ref, watch } from "vue";
import axios from "axios";
import { ElMessage } from "element-plus";
import type { WorkspaceGraph, GraphChange } from "@/lib/workspaceFiles";
import mobileAgentPanel from "./mobileAgentPanel.vue";
import type { CanvasNode } from "../lib/mobileGraphModel";
import type { PendingMediaJobState } from "@toonflow/nodes-scaffold/nodeAi";

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

const queryKey = computed(() => idempotencyKey.value || pendingJob.value?.idempotencyKey || "");

watch(pendingJob, (pending) => {
  if (pending?.idempotencyKey) idempotencyKey.value = pending.idempotencyKey;
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

const canSubmitMedia = computed(() => isMediaNode.value && !submitHint.value && !pendingJob.value && !!props.directory);

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
  await props.persistNode([{ kind: "node", id: props.node.id, expectedVersion, value }]);
  idempotencyKey.value = key;
  return expectedVersion + 1;
}

async function submitMediaGeneration() {
  if (!canSubmitMedia.value || !props.node || !parsedModel.value) return;
  submitLoading.value = true;
  mediaResult.value = "";
  try {
    const key = crypto.randomUUID();
    const expectedNodeVersion = await persistPendingJob(key);
    const { images, videos, audios } = buildReferencePayload();
    const body: Record<string, unknown> = {
      directory: props.directory,
      mediaType: mediaType.value,
      idempotencyKey: key,
      wait: false,
      providerId: parsedModel.value.providerId,
      modelId: parsedModel.value.modelId,
      prompt: buildGenerationPrompt(),
      outputDirectory: `assets/${props.node.id}`,
      canvasPath: props.canvasPath,
      nodeId: props.node.id,
      outputSlot: outputSlot.value,
      expectedNodeVersion,
    };
    if (isImageNode.value) {
      Object.assign(body, {
        size: nodeData.value.size,
        ratio: nodeData.value.ratio,
        images,
      });
    } else {
      const modeRaw = nodeData.value.mode;
      let mode: unknown;
      if (typeof modeRaw === "string" && modeRaw) {
        try { mode = JSON.parse(modeRaw); } catch { mode = modeRaw; }
      }
      Object.assign(body, {
        mode,
        duration: nodeData.value.duration,
        resolution: nodeData.value.resolution || undefined,
        ratio: nodeData.value.ratio,
        generateAudio: nodeData.value.generateAudio,
        images,
        videos,
        audios,
      });
    }
    const { data } = await axios.post<{ code: number; data?: unknown; message?: string }>("/api/ai/media/generate", body, {
      headers: { "x-toonflow-workspace": "1" },
    });
    if (data.code !== 200 && data.code !== 202) throw new Error(data.message || "提交失败");
    mediaTitle.value = "已提交媒体任务";
    mediaResult.value = JSON.stringify(data.data, null, 2);
    pendingStatus.value = "submitted";
    ElMessage.success("已提交，可用查询按钮跟踪进度");
  } catch (err) {
    mediaTitle.value = "提交失败";
    mediaResult.value = err instanceof Error ? err.message : String(err);
    ElMessage.error(mediaResult.value);
  } finally {
    submitLoading.value = false;
  }
}

async function queryMediaJob() {
  if (!props.directory || !queryKey.value) return;
  mediaLoading.value = true;
  mediaResult.value = "";
  try {
    const { data } = await axios.get<{ code: number; data?: { status?: string }; message?: string }>("/api/ai/media/getJob", {
      params: { directory: props.directory, idempotencyKey: queryKey.value },
      headers: { "x-toonflow-workspace": "1" },
    });
    if (data.code !== 200) throw new Error(data.message || "查询失败");
    pendingStatus.value = String(data.data?.status ?? "");
    mediaTitle.value = "媒体任务";
    mediaResult.value = JSON.stringify(data.data, null, 2);
  } catch (err) {
    mediaTitle.value = "查询失败";
    mediaResult.value = err instanceof Error ? err.message : String(err);
  } finally {
    mediaLoading.value = false;
  }
}

async function listMediaJobs() {
  if (!props.directory) return;
  listLoading.value = true;
  mediaResult.value = "";
  try {
    const { data } = await axios.get<{ code: number; data?: unknown; message?: string }>("/api/ai/media/list", {
      params: { directory: props.directory },
      headers: { "x-toonflow-workspace": "1" },
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
