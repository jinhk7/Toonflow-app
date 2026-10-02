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
      <mediaHistory mediaType="image" :current="outputFile" :disabled="generating || pendingJob || uploading" @select="selectOutput" />
      <el-button :icon="IconTransfer" :loading="uploading" :disabled="generating || pendingJob" text title="替换图片" aria-label="替换图片" @click.stop="fileInput?.click()" />
      <input ref="fileInput" type="file" accept="image/*" hidden aria-label="选择替换图片" :disabled="generating || pendingJob || uploading" @change="replaceOutput($event).catch(error => showNodeError(error, '替换失败'))" />
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
        <div class="promptFooter">
          <el-select
            v-model="data.model"
            class="modelSelect"
            filterable
            :loading="modelsLoading"
            :disabled="generating || pendingJob"
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
            :disabled="generating || pendingJob || !selectedModel" />
          <el-button
            class="sendButton"
            :icon="generating ? IconPlayerStop : IconArrowUp"
            :disabled="uploading || (!generating && !pendingJob && (!generationPrompt || !selectedModel))"
            :title="generating ? '停止生成' : '生成图片'"
            :aria-label="generating ? '停止生成' : '生成图片'"
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
import { groupNodeModels, nodeSkeleton, showNodeError, useNode, useNodeReferences, type NodeMediaModel, type NodeMediaJobView, type NodeMediaValue } from "@toonflow/nodes-scaffold/runtime";
import promptInput from "@toonflow/nodes-scaffold/promptInput";

import referenceItem from "@toonflow/nodes-scaffold/referenceItem";
import mediaHistory from "@toonflow/nodes-scaffold/mediaHistory";
import generationSettings from "./components/generationSettings.vue";

type PromptModel = NonNullable<InstanceType<typeof promptInput>["$props"]["modelValue"]>;
type ConfigState = { config: { providerId: string; modelId: string; size?: string; ratio: string; }; models: NodeMediaModel[] };
type GenerationState = { status: string; jobId?: string; mediaJob?: NodeMediaJobView; error?: string };
defineOptions({ inheritAttrs: false, icon: IconPhotoAi });
const vLoading = ElLoading.directive;
const { node, nodeProps, outputs, files, execution, updateNodeInternals } = useNode({ label: "图片生成" });
const nodeData = computed(() => node.data as typeof node.data & Record<string, unknown>);
const { refList, referenceMentions, setReferencePreview, removeReference } = useNodeReferences();
const data = reactive({
  prompt: typeof nodeData.value.prompt === "string" ? nodeData.value.prompt : "",
  promptModel: Array.isArray(nodeData.value.promptModel) ? nodeData.value.promptModel as PromptModel : [],
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
let promptTimer: ReturnType<typeof setTimeout> | undefined;
let pollTimer: ReturnType<typeof setTimeout> | undefined;
let statusError = "";

function applyConfig(state: ConfigState) {
  applying = true;
  models.value = state.models;

  const config = state.config;
  data.model = config.modelId ? JSON.stringify([config.providerId, config.modelId]) : typeof nodeData.value.model === "string" ? nodeData.value.model : "";
  data.size = config.size ?? "";
  data.ratio = config.ratio;
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
watch(() => [data.size, data.ratio], ([size, ratio], previous) => {
  if (applying) return;
  const args: Record<string, unknown> = {};
  if (size && size !== previous[0]) args.size = size;
  if (ratio && ratio !== previous[1]) args.ratio = ratio;
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
  await execution.call("generateImage");
  generating.value = true;
}
async function cancelGeneration() {
  try { await execution.call("cancelGeneration"); }
  catch (error) { showNodeError(error, "停止生成失败"); }
}
async function poll() {
  try {
    if (!document.hidden) {
      const id = nodeData.value.generationJobId;
      const job = typeof id === "string" ? await execution.getJob(id) : undefined;
      if (!job && pendingJob.value) {
        const state = await execution.call<GenerationState>("getGenerationStatus");
        generating.value = ["accepted", "running"].includes(state.status);
      } else generating.value = !!job && ["accepted", "running"].includes(job.status);
      if (job?.errorMessage && job.errorMessage !== statusError) { statusError = job.errorMessage; showNodeError(job.errorMessage, "图片生成失败"); }
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
