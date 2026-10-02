<template>
  <nodeSkeleton
    v-bind="nodeProps"
    v-model:bottomVisible="node.selected"
    :topVisible="node.selected"
    topWidth="max-content"
    :downloadUrl="previewUrl"
    :downloadName="outputFile?.url.split(/[\\/]/).at(-1)"
    @fullscreen="player?.enterFullscreen()"
    :bottomWidth="660"
    :style="{ width: previewUrl && videoWidth ? `${videoWidth + 18}px` : undefined }">
    <template #topActions>
      <mediaHistory mediaType="video" :current="outputFile" :disabled="generating || controlsBlocked || uploading" @select="selectOutput" />
      <el-button :icon="IconTransfer" :loading="uploading" :disabled="generating || controlsBlocked" text title="替换视频" aria-label="替换视频" @click.stop="fileInput?.click()" />
      <input ref="fileInput" type="file" accept="video/*" hidden aria-label="选择替换视频" :disabled="generating || controlsBlocked || uploading" @change="replaceOutput($event).catch(error => showNodeError(error, '替换失败'))" />
    </template>
    <div v-loading="generating || uploading" class="videoContent nopan" :aria-busy="generating || uploading">
      <videoPlayer
        v-if="previewUrl"
        ref="player"
        :src="previewUrl"
        label="生成视频"
        @loadedmetadata="resizeVideo" />
      <div v-else class="videoEmpty" role="img" aria-label="暂无生成视频">
        <icon-camera-ai :size="48" stroke="1.25" aria-hidden="true" />
      </div>
    </div>
    <template #bottom>
      <el-card class="promptCard" shadow="never" :bodyStyle="{ padding: '14px 16px 12px' }">
        <referenceItem
          v-if="refList.length"
          v-model="refList"
          @preview="setReferencePreview"
          @remove="removeReference" />
        <div v-if="frameMode" class="referenceHint">
          {{ selectedMode === "startFrameOptional" ? "仅一张图片时作为尾帧；两张图片按顺序作为首帧、尾帧" : "图片引用按顺序作为首帧、尾帧" }}
        </div>
        <promptInput v-model="data.promptModel" v-model:text="data.prompt" :references="referenceMentions" />
        <div class="promptFooter">
          <el-select
            v-model="data.model"
            class="modelSelect"
            filterable
            :loading="modelsLoading"
            :disabled="generating || controlsBlocked"
            placeholder="选择模型"
            aria-label="生成模型"
            noDataText="请先在设置中添加视频模型"
            placement="top-start"
            @visible-change="(visible) => visible && loadModels().catch((error) => showNodeError(error, '模型读取失败'))">
            <template #prefix><icon-sparkles :size="17" /></template>
            <el-option-group v-for="provider in modelGroups" :key="provider.id" :label="provider.label">
              <el-option
                v-for="item in provider.models"
                :key="item.modelId"
                :label="item.label"
                :value="JSON.stringify([item.providerId, item.modelId])" />
            </el-option-group>
          </el-select>
          <generationSettings
            v-model:duration="data.duration"
            v-model:resolution="data.resolution"
            v-model:ratio="data.ratio"
            v-model:mode="data.mode"
            v-model:generateAudio="data.generateAudio"
            :ratios="ratioOptions"
            :model="settingsModel"
            :disabled="generating || controlsBlocked || !selectedModel" />
          <el-button
            class="sendButton"
            :icon="generating ? IconPlayerStop : IconArrowUp"
            :disabled="uploading || (generating && !canCancelObservation) || (!generating && !pendingJob && (!generationPrompt || !selectedModel))"
            :title="generating ? cancelLabel : '生成视频'"
            :aria-label="generating ? cancelLabel : '生成视频'"
            @click="generating ? cancelGeneration() : startFromButton().catch((error) => showNodeError(error, '视频生成失败'))" />
        </div>
      </el-card>
    </template>
  </nodeSkeleton>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, onScopeDispose, reactive, ref, watch } from "vue";
import { ElButton, ElCard, ElSelect, ElOption, ElOptionGroup, ElMessageBox, ElLoading } from "element-plus";
import { IconCameraAi, IconSparkles, IconArrowUp, IconPlayerStop, IconTransfer } from "@tabler/icons-vue";
import { groupNodeModels, nodeSkeleton, useNodeError, useNode, useNodeReferences, type NodeMediaModel, type NodeMediaJobView, type NodeMediaValue } from "@toonflow/nodes-scaffold/runtime";
import promptInput from "@toonflow/nodes-scaffold/promptInput";
import videoPlayer from "@toonflow/nodes-scaffold/videoPlayer";
import referenceItem from "@toonflow/nodes-scaffold/referenceItem";
import mediaHistory from "@toonflow/nodes-scaffold/mediaHistory";
import generationSettings from "./components/generationSettings.vue";

type PromptModel = NonNullable<InstanceType<typeof promptInput>["$props"]["modelValue"]>;
const showNodeError = useNodeError();
type ConfigState = { config: { providerId: string; modelId: string; size?: string; ratio: string; duration?: number; resolution?: string; mode?: string | string[]; generateAudio?: boolean }; models: NodeMediaModel[]; matchingModes?: (string | string[])[]; ratios?: string[] };
type GenerationState = { status: string; jobId?: string; mediaJob?: NodeMediaJobView; error?: string; controlsBlocked: boolean; canCancelObservation: boolean };
defineOptions({ inheritAttrs: false, icon: IconCameraAi });
const vLoading = ElLoading.directive;
const { node, nodeProps, outputs, files, execution, updateNodeInternals } = useNode({ label: "视频生成" });
const nodeData = computed(() => node.data as typeof node.data & Record<string, unknown>);
const { refList, referenceMentions, setReferencePreview, removeReference } = useNodeReferences();
const data = reactive({
  prompt: typeof nodeData.value.prompt === "string" ? nodeData.value.prompt : "",
  promptModel: Array.isArray(nodeData.value.promptModel) ? nodeData.value.promptModel as PromptModel : [],
  model: typeof nodeData.value.model === "string" ? nodeData.value.model : "",
  ratio: typeof nodeData.value.ratio === "string" ? nodeData.value.ratio : "9:16",
  duration: typeof nodeData.value.duration === "number" ? nodeData.value.duration : undefined,
  resolution: typeof nodeData.value.resolution === "string" ? nodeData.value.resolution : "",
  mode: typeof nodeData.value.mode === "string" ? nodeData.value.mode : "",
  generateAudio: nodeData.value.generateAudio !== false,
});
const models = ref<NodeMediaModel[]>([]);
const matchingModes = ref<(string | string[])[]>([]);
const ratioOptions = ref<string[]>(["16:9", "9:16", "1:1", "4:3", "3:4"]);
const modelsLoading = ref(false);
const uploading = ref(false);
const fileInput = ref<HTMLInputElement>();

const videoWidth = ref(0);
const player = ref<InstanceType<typeof videoPlayer>>();
const generating = ref(false);
const pendingJob = computed(() => !!nodeData.value.pendingMediaJob);
const controlsBlocked = ref(pendingJob.value);
const canCancelObservation = ref(false);
const cancelLabel = computed(() => canCancelObservation.value ? "取消本地等待" : "供应商任务仍在运行");
const selectedModel = computed(() => models.value.find(item => JSON.stringify([item.providerId, item.modelId]) === data.model));
const settingsModel = computed(() => selectedModel.value ? { ...selectedModel.value, mode: matchingModes.value } : undefined);
const selectedMode = computed(() => { try { return JSON.parse(data.mode) as string | string[]; } catch { return undefined; } });
const frameMode = computed(() => ["startEndRequired", "endFrameOptional", "startFrameOptional"].includes(String(selectedMode.value)));

const modelGroups = computed(() => groupNodeModels(models.value));
const generationPrompt = computed(() => data.prompt.trim() || refList.value.some(item => item.dataType === "STRING" && typeof item.value === "string" && item.value.trim()));
const outputFile = computed(() => outputs.value.video?.dataType === "VIDEO" ? outputs.value.video.value : undefined);
const previewUrl = files.useFileUrl(outputFile, error => showNodeError(error, "视频读取失败"));
let applying = false;
let disposed = false;
let controlsSaving = Promise.resolve();
let promptTimer: ReturnType<typeof setTimeout> | undefined;
let pollTimer: ReturnType<typeof setTimeout> | undefined;
let statusError = "";
watch(pendingJob, value => { if (value) controlsBlocked.value = true; }, { flush: "sync" });

function applyConfig(state: ConfigState) {
  applying = true;
  models.value = state.models;
  matchingModes.value = state.matchingModes ?? [];
  if (state.ratios) ratioOptions.value = state.ratios;
  const config = state.config;
  data.model = config.modelId ? JSON.stringify([config.providerId, config.modelId]) : typeof nodeData.value.model === "string" ? nodeData.value.model : "";
  data.ratio = config.ratio;
  data.duration = config.duration;
  data.resolution = config.resolution ?? "";
  data.mode = config.mode === undefined ? "" : JSON.stringify(config.mode);
  data.generateAudio = config.generateAudio !== false;
  applying = false;
}
function queueControl(name: string, args: Record<string, unknown>) {
  const pending = controlsSaving.catch(() => {}).then(() => execution.call<ConfigState>(name, args));
  controlsSaving = pending.then(state => { if (name === "setConfig") applyConfig(state); });
  void controlsSaving.catch(error => { if (!disposed) showNodeError(error, "节点设置保存失败"); });
  return controlsSaving;
}
function savePrompt() {
  clearTimeout(promptTimer);
  promptTimer = undefined;
  return queueControl("setPrompt", { prompt: data.prompt });
}
watch(() => [data.prompt, data.promptModel], () => {
  if (applying) return;
  clearTimeout(promptTimer);
  promptTimer = setTimeout(() => { void savePrompt(); }, 400);
}, { deep: true, flush: "sync" });
watch(() => data.model, value => {
  if (applying) return;
  const choice = models.value.find(item => JSON.stringify([item.providerId, item.modelId]) === value);
  if (choice) void queueControl("setConfig", { providerId: choice.providerId, modelId: choice.modelId });
}, { flush: "sync" });
watch(() => [data.duration, data.resolution, data.ratio, data.mode, data.generateAudio] as const, (values, previous) => {
  if (applying) return;
  const args: Record<string, unknown> = {};
  if (values[0] !== undefined && values[0] !== previous[0]) args.duration = values[0];
  if (values[1] && values[1] !== previous[1]) args.resolution = values[1];
  if (values[2] && values[2] !== previous[2]) args.ratio = values[2];
  if (values[3] && values[3] !== previous[3]) args.mode = JSON.parse(values[3]);
  if (values[4] !== previous[4]) args.generateAudio = values[4];
  if (Object.keys(args).length) void queueControl("setConfig", args);
}, { flush: "sync" });
watch(() => [nodeData.value.prompt, nodeData.value.promptModel], () => {
  if (promptTimer) return;
  applying = true;
  data.prompt = typeof nodeData.value.prompt === "string" ? nodeData.value.prompt : "";
  data.promptModel = Array.isArray(nodeData.value.promptModel) ? nodeData.value.promptModel as PromptModel : [];
  applying = false;
});
async function loadModels() {
  if (modelsLoading.value) return;
  modelsLoading.value = true;
  try { applyConfig(await execution.call<ConfigState>("getConfig")); }
  finally { modelsLoading.value = false; }
}
async function selectOutput(value: NodeMediaValue) {
  try { await execution.call("setVideo", { path: value.url, mimeType: value.mimeType }); }
  catch (error) { showNodeError(error, "选择历史视频失败"); }
}
async function replaceOutput(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = "";
  if (!file || generating.value || uploading.value) return;
  if (!file.type.startsWith("video/")) return void showNodeError("请选择视频文件", "视频替换失败");
  if (!file.size || file.size > 100 * 1024 * 1024) return void showNodeError("视频不能为空且不能超过 100 MB", "视频替换失败");
  uploading.value = true;
  try {
    const workspaceFiles = files.getWorkspaceFiles();
    const stagedPath = `assets/uploads/${crypto.randomUUID()}`;
    for (const path of ["assets", "assets/uploads"]) {
      await workspaceFiles.mkdir(path).catch((error: { response?: { data?: { data?: { code?: string } } } }) => {
        if (error.response?.data?.data?.code !== "EEXIST") throw error;
      });
    }
    await workspaceFiles.write(stagedPath, file, true);
    await execution.call("uploadVideo", { stagedPath, name: file.name, mimeType: file.type });
  } finally { uploading.value = false; }
}
async function startFromButton() {
  await controlsSaving;
  const state = await execution.call<GenerationState>("getGenerationStatus");
  applyGenerationState(state);
  if (state.mediaJob?.status === "collectionFailed") {
    await execution.call("retryCollection");
    return;
  }
  if (pendingJob.value && (!state.mediaJob || state.mediaJob.status === "unknown")) {
    try {
      await ElMessageBox.confirm("上次任务结果未知，服务可能仍在生成或已计费。请先在服务端核对；放弃后原任务的结果不会写回节点，本次会产生新的生成请求。", "放弃上次任务？", { type: "warning", confirmButtonText: "放弃并重新生成", cancelButtonText: "取消" });
    } catch { return; }
    await execution.call("abandonUnknownGeneration", { confirmed: true });
  }
  if (["accepted", "running"].includes(state.status) || state.mediaJob && ["prepared", "submitting", "tracking", "collecting"].includes(state.mediaJob.status)) return;
  await savePrompt();
  await execution.call("generateVideo");
  generating.value = true;
  controlsBlocked.value = true;
  canCancelObservation.value = true;
  statusError = "";
}
function applyGenerationState(state: GenerationState) {
  generating.value = ["accepted", "running"].includes(state.status);
  controlsBlocked.value = state.controlsBlocked;
  canCancelObservation.value = state.canCancelObservation;
  if (state.error && state.error !== statusError) {
    statusError = state.error;
    showNodeError(state.error, "视频生成失败");
  }
}

async function cancelGeneration() {
  try { applyGenerationState(await execution.call<GenerationState>("cancelGeneration")); }
  catch (error) { showNodeError(error, "取消本地等待失败"); }
}
async function poll() {
  try {
    if (!document.hidden) {
      const id = nodeData.value.generationJobId;
      const job = !pendingJob.value && typeof id === "string" ? await execution.getJob(id) : undefined;
      if (pendingJob.value || job && ["cancelled", "failed", "needsReview"].includes(job.status)) {
        applyGenerationState(await execution.call<GenerationState>("getGenerationStatus"));
      } else {
        generating.value = !!job && ["accepted", "running"].includes(job.status);
        controlsBlocked.value = generating.value;
        canCancelObservation.value = generating.value;
      }
    }
  } catch (error) { if (!disposed) showNodeError(error, "任务状态读取失败"); }
  finally { if (!disposed) pollTimer = setTimeout(() => { void poll(); }, 2000); }
}
async function resizeVideo(event: Event) {
  const video = event.currentTarget as HTMLVideoElement;
  if (!video.videoWidth || !video.videoHeight) return;
  videoWidth.value = Math.max(180, 240 * video.videoWidth / video.videoHeight);
  await nextTick();
  updateNodeInternals();
}
onMounted(async () => {
  try { await loadModels(); }
  catch (error) { showNodeError(error, "模型读取失败"); }
  void poll();
});
onScopeDispose(() => { disposed = true; clearTimeout(promptTimer); clearTimeout(pollTimer); });
</script>

<style scoped lang="scss">
.videoContent {
  position: relative;
  display: grid;
  place-items: center;
  min-height: 144px;
  overflow: hidden;
  border-radius: var(--el-border-radius-base);

  .videoEmpty {
    display: grid;
    place-items: center;
    min-height: 144px;
    color: var(--el-text-color-placeholder);
  }

  :deep(.el-loading-mask) {
    pointer-events: none;
  }

}

.promptCard {
  .referenceHint {
    margin: 8px 0;
    color: var(--el-text-color-secondary);
    font-size: 12px;
  }

  .promptFooter {
    display: flex;
    align-items: center;
    justify-content: flex-start;
    gap: 12px;

    .modelSelect {
      width: 190px;
      min-width: 0;

      &:deep(.el-select__wrapper) {
        gap: 6px;
        padding: 0;
        box-shadow: none;
        background: transparent;
      }
    }

    .sendButton {
      width: 32px;
      height: 32px;
      margin-left: auto;
      padding: 0;
      --el-button-bg-color: var(--el-text-color-primary);
      --el-button-border-color: transparent;
      --el-button-text-color: var(--el-bg-color);
      --el-button-hover-bg-color: var(--el-text-color-regular);
      --el-button-hover-border-color: transparent;
      --el-button-hover-text-color: var(--el-bg-color);
    }
  }
}
</style>
