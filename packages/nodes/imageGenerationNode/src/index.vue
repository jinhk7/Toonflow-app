<template>
  <nodeSkeleton
    v-bind="nodeProps"
    v-model:bottomVisible="node.selected"
    :topVisible="node.selected"
    topWidth="max-content"
    :downloadUrl="previewUrl"
    :downloadName="outputFile?.url.split(/[\\/]/).at(-1)"
    @fullscreen="previewVisible = true"
    :bottomWidth="660"
    :style="{ width: previewUrl && imageWidth ? `${imageWidth + 18}px` : undefined }">
    <template #topActions>
      <mediaHistory mediaType="image" :current="outputFile" :disabled="generating || controlsBlocked || uploading" @select="selectOutput" />
      <el-button :icon="IconTransfer" :loading="uploading" :disabled="generating || controlsBlocked" text title="替换图片" aria-label="替换图片" @click.stop="fileInput?.click()" />
      <input ref="fileInput" type="file" accept="image/*" hidden aria-label="选择替换图片" :disabled="generating || controlsBlocked || uploading" @change="replaceOutput($event).catch(error => showNodeError(error, '替换失败'))" />
    </template>
    <div v-loading="generating || uploading" class="imageContent nopan" :aria-busy="generating || uploading">
      <img
        v-if="previewUrl"
        class="imagePreview"
        :src="previewUrl"
        draggable="false"
        alt="生成图片"
        @load="resizeImage"
        @error="showNodeError('无法预览该图片', '图片预览失败')" />
      <div v-else class="imageEmpty" role="img" aria-label="暂无生成图片">
        <icon-photo-ai :size="48" stroke="1.25" aria-hidden="true" />
      </div>
    </div>
    <template #bottom>
      <el-card class="promptCard" shadow="never" :bodyStyle="{ padding: '14px 16px 12px' }">
        <referenceItem
          v-if="refList.length"
          v-model="refList"
          @preview="setReferencePreview"
          @remove="removeReference" />
        <promptInput v-model="data.promptModel" v-model:text="data.prompt" :references="referenceMentions" />
        <div v-if="controlError" class="controlError" role="status">
          <span>{{ controlError }}<template v-if="controlDrafts.size">；未提交的设置已保留</template></span>
          <el-button @click="retryControls">保存保留的设置</el-button>
        </div>
        <div class="promptFooter">
          <el-select
            v-model="data.model"
            class="modelSelect"
            filterable
            :loading="modelsLoading"
            :disabled="generating || controlsBlocked"
            placeholder="选择模型"
            aria-label="生成模型"
            noDataText="请先在设置中添加图片模型"
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
            v-model:size="data.size"
            v-model:ratio="data.ratio"
            :sizes="sizeOptions"
            :ratios="ratioChoices"
            :disabled="generating || controlsBlocked || !selectedModel" />
          <el-button
            class="sendButton"
            :icon="generating ? IconPlayerStop : IconArrowUp"
            :disabled="uploading || (generating && !canCancelObservation) || (!generating && !pendingJob && (!generationPrompt || !selectedModel))"
            :title="generating ? cancelLabel : '生成图片'"
            :aria-label="generating ? cancelLabel : '生成图片'"
            @click="generating ? cancelGeneration() : startFromButton().catch((error) => showNodeError(error, '图片生成失败'))" />
        </div>
      </el-card>
    </template>
  </nodeSkeleton>
  <el-image-viewer
    v-if="previewVisible && previewUrl"
    :urlList="[previewUrl]"
    teleported
    @close="previewVisible = false" />
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, onScopeDispose, reactive, ref, watch } from "vue";
import { ElButton, ElCard, ElSelect, ElOption, ElOptionGroup, ElMessageBox, ElLoading, ElImageViewer } from "element-plus";
import { IconPhotoAi, IconSparkles, IconArrowUp, IconPlayerStop, IconTransfer } from "@tabler/icons-vue";
import { groupNodeModels, nodeSkeleton, useNodeError, useNode, useNodeReferences, type NodeMediaModel, type NodeMediaJobView, type NodeMediaValue } from "@toonflow/nodes-scaffold/runtime";
import promptInput from "@toonflow/nodes-scaffold/promptInput";

import referenceItem from "@toonflow/nodes-scaffold/referenceItem";
import mediaHistory from "@toonflow/nodes-scaffold/mediaHistory";
import generationSettings from "./components/generationSettings.vue";

type PromptModel = NonNullable<InstanceType<typeof promptInput>["$props"]["modelValue"]>;
const showNodeError = useNodeError();
type ConfigState = { config: { providerId: string; modelId: string; size?: string; ratio: string; }; models: NodeMediaModel[] };
type GenerationState = { status: string; jobId?: string; mediaJob?: NodeMediaJobView; error?: string; controlsBlocked: boolean; canCancelObservation: boolean };
defineOptions({ inheritAttrs: false, icon: IconPhotoAi });
const vLoading = ElLoading.directive;
const { node, nodeProps, outputs, files, execution, updateNodeInternals } = useNode({ label: "图片生成" });
const nodeData = computed(() => node.data as typeof node.data & Record<string, unknown>);
const { refList, referenceMentions, setReferencePreview, removeReference } = useNodeReferences();
const data = reactive({
  prompt: typeof nodeData.value.prompt === "string" ? nodeData.value.prompt : "",
  promptModel: Array.isArray(nodeData.value.promptModel) ? JSON.parse(JSON.stringify(nodeData.value.promptModel)) as PromptModel : [],
  model: typeof nodeData.value.model === "string" ? nodeData.value.model : "",
  size: typeof nodeData.value.size === "string" ? nodeData.value.size : "",
  ratio: typeof nodeData.value.ratio === "string" ? nodeData.value.ratio : "",
});
const models = ref<NodeMediaModel[]>([]);

const modelsLoading = ref(false);
const uploading = ref(false);
const fileInput = ref<HTMLInputElement>();
const previewVisible = ref(false);
const imageWidth = ref(0);

const generating = ref(false);
const pendingJob = computed(() => !!nodeData.value.pendingMediaJob);
const controlsBlocked = ref(pendingJob.value);
const canCancelObservation = ref(false);
const cancelLabel = computed(() => canCancelObservation.value ? "取消本地等待" : "供应商任务仍在运行");
const selectedModel = computed(() => models.value.find(item => JSON.stringify([item.providerId, item.modelId]) === data.model));

const sizeOptions = computed(() => selectedModel.value?.imageSizes ?? []);
const ratioChoices = computed(() => selectedModel.value?.imageRatios ?? []);
const modelGroups = computed(() => groupNodeModels(models.value));
const generationPrompt = computed(() => data.prompt.trim() || refList.value.some(item => item.dataType === "STRING" && typeof item.value === "string" && item.value.trim()));
const outputFile = computed(() => outputs.value.image?.dataType === "IMAGE" ? outputs.value.image.value : undefined);
const previewUrl = files.useFileUrl(outputFile, error => showNodeError(error, "图片读取失败"));
let applying = false;
let disposed = false;
let controlsSaving = Promise.resolve();
const controlDrafts = reactive(new Map<string, number>());
const controlError = ref("");
let draftVersion = 0;
let configRequest: Promise<void> | undefined;
let configRefreshPending = false;
function markDrafts(fields: string[]) {
  const version = ++draftVersion;
  for (const field of fields) controlDrafts.set(field, version);
}
function syncPrompt() {
  if (controlDrafts.has("prompt") || promptTimer) return;
  applying = true;
  data.prompt = typeof nodeData.value.prompt === "string" ? nodeData.value.prompt : "";
  data.promptModel = Array.isArray(nodeData.value.promptModel) ? JSON.parse(JSON.stringify(nodeData.value.promptModel)) as PromptModel : [];
  applying = false;
}
let promptTimer: ReturnType<typeof setTimeout> | undefined;
let pollTimer: ReturnType<typeof setTimeout> | undefined;
let statusError = "";
watch(pendingJob, value => { if (value) controlsBlocked.value = true; }, { flush: "sync" });

function applyConfig(state: ConfigState) {
  applying = true;
  models.value = state.models;
  const config = state.config;
  const values: Partial<typeof data> = { model: config.modelId ? JSON.stringify([config.providerId, config.modelId]) : typeof nodeData.value.model === "string" ? nodeData.value.model : "", size: config.size ?? "", ratio: config.ratio, };
  for (const [field, value] of Object.entries(values)) if (!controlDrafts.has(field)) Reflect.set(data, field, value);
  applying = false;
}
function queueControl(name: string, args: Record<string, unknown>) {
  const fields = name === "setPrompt" ? ["prompt", "promptModel"] : Object.keys(args).filter(field => field in data);
  if (name === "setConfig" && (args.providerId || args.modelId)) fields.push("model");
  const versions = new Map(fields.map(field => [field, controlDrafts.get(field)]));
  const pending = controlsSaving.catch(() => {}).then(() => execution.call(name, args));
  controlsSaving = pending.then(async () => {
    for (const [field, version] of versions) if (controlDrafts.get(field) === version) controlDrafts.delete(field);
    syncPrompt();
    await loadModels();
    if (!controlDrafts.size) controlError.value = "";
  });
  void controlsSaving.catch(error => {
    controlError.value = error instanceof Error ? error.message : "节点设置保存失败";
    if (!disposed) showNodeError(error, "节点设置保存失败");
  });
  return controlsSaving;
}
function savePrompt() {
  clearTimeout(promptTimer);
  promptTimer = undefined;
  if (!controlDrafts.has("prompt") && data.prompt === nodeData.value.prompt) return controlsSaving;
  return queueControl("setPrompt", { prompt: data.prompt });
}
watch(() => [data.prompt, data.promptModel], () => {
  if (applying) return;
  markDrafts(["prompt", "promptModel"]);
  clearTimeout(promptTimer);
  promptTimer = setTimeout(() => { void savePrompt(); }, 400);
}, { deep: true, flush: "sync" });
watch(() => data.model, value => {
  if (applying) return;
  const choice = models.value.find(item => JSON.stringify([item.providerId, item.modelId]) === value);
  if (choice) { markDrafts(["model"]); void queueControl("setConfig", { providerId: choice.providerId, modelId: choice.modelId }); }
}, { flush: "sync" });
watch(() => [data.size, data.ratio], ([size, ratio], previous) => {
  if (applying) return;
  const args: Record<string, unknown> = {};
  if (size && size !== previous[0]) args.size = size;
  if (ratio && ratio !== previous[1]) args.ratio = ratio;
  if (Object.keys(args).length) { markDrafts(Object.keys(args)); void queueControl("setConfig", args); }
}, { flush: "sync" });
watch(() => [nodeData.value.prompt, nodeData.value.promptModel, nodeData.value.model, nodeData.value.size, nodeData.value.ratio], () => {
  syncPrompt();
  void loadModels().catch(error => { controlError.value = error instanceof Error ? error.message : "远端配置读取失败"; });
}, { deep: true });
function loadModels(): Promise<void> {
  configRefreshPending = true;
  if (configRequest) return configRequest;
  modelsLoading.value = true;
  configRequest = (async () => {
    do {
      configRefreshPending = false;
      const target = execution.getTarget();
      const state = await execution.call<ConfigState>("getConfig");
      if (disposed) return;
      const current = execution.getTarget();
      if (target.directory !== current.directory || target.canvasPath !== current.canvasPath) throw new Error("节点画布已切换");
      if (target.version !== current.version || configRefreshPending) { configRefreshPending = true; continue; }
      applyConfig(state);
    } while (configRefreshPending && !disposed);
  })().finally(() => { configRequest = undefined; modelsLoading.value = false; });
  return configRequest;
}
async function retryControls() {
  const args: Record<string, unknown> = {};
  if (controlDrafts.has("model")) {
    const choice = selectedModel.value;
    if (!choice) return void showNodeError("保留的模型已不可用，请重新选择", "设置草稿保存失败");
    args.providerId = choice.providerId; args.modelId = choice.modelId;
  }
  for (const field of ["size", "ratio"]) {
    if (!controlDrafts.has(field)) continue;
    const value = Reflect.get(data, field);
    if (value !== undefined && value !== "") args[field] = value;
  }
  try {
    if (Object.keys(args).length) await queueControl("setConfig", args);
    await savePrompt();
    await loadModels();
    if (!controlDrafts.size) controlError.value = "";
  } catch (error) { controlError.value = error instanceof Error ? error.message : "节点设置保存失败"; }
}
async function selectOutput(value: NodeMediaValue) {
  try { await execution.call("setImage", { path: value.url, mimeType: value.mimeType }); }
  catch (error) { showNodeError(error, "选择历史图片失败"); }
}
async function replaceOutput(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = "";
  if (!file || generating.value || uploading.value) return;
  if (!file.type.startsWith("image/")) return void showNodeError("请选择图片文件", "图片替换失败");
  if (!file.size || file.size > 100 * 1024 * 1024) return void showNodeError("图片不能为空且不能超过 100 MB", "图片替换失败");
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
    await execution.call("uploadImage", { stagedPath, name: file.name, mimeType: file.type });
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
  await loadModels();
  if (controlDrafts.size) throw new Error("仍有未提交的设置草稿，请保存后再生成");
  const target = execution.getTarget();
  await execution.call("generateImage", {}, { expectedVersion: target.version });
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
    showNodeError(state.error, "图片生成失败");
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
async function resizeImage(event: Event) {
  const image = event.currentTarget as HTMLImageElement;
  if (!image.naturalWidth || !image.naturalHeight) return;
  imageWidth.value = 240 * image.naturalWidth / image.naturalHeight;
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
.imageContent {
  position: relative;
  display: grid;
  place-items: center;
  min-height: 144px;
  overflow: hidden;
  border-radius: var(--el-border-radius-base);

  .imageEmpty {
    display: grid;
    place-items: center;
    min-height: 144px;
    color: var(--el-text-color-placeholder);
  }

  :deep(.el-loading-mask) {
    pointer-events: none;
  }

  .imagePreview {
    display: block;
    width: 100%;
    max-height: 240px;
    object-fit: contain;
    border-radius: var(--el-border-radius-base);
  }

}

.promptCard {
  .controlError { display: flex; flex-wrap: wrap; gap: 8px; margin: 8px 0; color: var(--el-color-warning); overflow-wrap: anywhere; }
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
