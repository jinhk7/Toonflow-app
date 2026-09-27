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
      <el-button :icon="IconTransfer" :loading="uploading" :disabled="generating || deleting" text title="替换图片" aria-label="替换图片" @click.stop="fileInput?.click()" />
      <input ref="fileInput" type="file" accept="image/*" hidden aria-label="选择替换图片" :disabled="generating || deleting || uploading" @change="replaceOutput" />
    </template>
    <div v-loading="generating || uploading" class="imageContent nopan" :aria-busy="generating || uploading">
      <img
        v-if="previewUrl"
        class="imagePreview"
        :src="previewUrl"
        draggable="false"
        alt="生成图片"
        @load="resizeImage"
        @error="ElMessage.error('无法预览该图片')" />
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
            :disabled="generating || deleting"
            placeholder="选择模型"
            aria-label="生成模型"
            noDataText="请先在设置中添加图片模型"
            placement="top-start"
            @visible-change="(visible) => visible && loadModels().catch((error) => showError(error, '模型读取失败'))">
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
            :ratios="ratioOptions"
            :disabled="generating || deleting || !selectedModel" />
          <el-button
            class="sendButton"
            :icon="generating ? IconPlayerStop : IconArrowUp"
            :disabled="deleting || uploading || (!generating && (!generationPrompt || !selectedModel))"
            :title="generating ? '停止生成' : '生成图片'"
            :aria-label="generating ? '停止生成' : '生成图片'"
            @click="generating ? generationController?.abort() : startFromButton().catch((error) => showError(error, '图片生成失败'))" />
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
import { computed, nextTick, onMounted, onScopeDispose, ref, watch } from "vue";
import { ElButton, ElCard, ElSelect, ElOption, ElOptionGroup, ElMessage, ElMessageBox, ElLoading, ElImageViewer } from "element-plus";
import { IconPhotoAi, IconSparkles, IconArrowUp, IconPlayerStop, IconTransfer } from "@tabler/icons-vue";
import { groupNodeModels, nodeSkeleton, nodeTools, useNode, useNodeGeneration, useNodeMediaPersistence, useNodeReferences, z, type NodeMediaModel, type NodeHandle, type PrepareMediaJobResult } from "@toonflow/nodes-scaffold/runtime";
import promptInput from "@toonflow/nodes-scaffold/promptInput";
import referenceItem from "@toonflow/nodes-scaffold/referenceItem";
import generationSettings from "./components/generationSettings.vue";

defineOptions({
  inheritAttrs: false,
  icon: IconPhotoAi,
  handles: [
    { id: "in", type: "target", dataType: ["IMAGE", "STRING"], label: "图片、文本输入" },
    { id: "image", type: "source", dataType: "IMAGE", label: "图片输出" },
  ] satisfies NodeHandle[],
});
const vLoading = ElLoading.directive;
const { id, node, nodeProps, nodeEvent, outputs, files, ai, updateNodeInternals } = useNode({
  label: "图片生成",
});
type PromptModel = NonNullable<InstanceType<typeof promptInput>["$props"]["modelValue"]>;
const data = computed(() => node.data as { prompt: string; promptModel: PromptModel; model: string; size: string; ratio: string });
data.value.prompt ??= "";
data.value.promptModel ??= [];
data.value.model ??= "";
data.value.size ??= "";
data.value.ratio ??= "";
const { refList, referenceMentions, setReferencePreview, removeReference } = useNodeReferences();
const mediaPersistence = useNodeMediaPersistence(id, () => data.value as Record<string, unknown>);
const outputSlot = "image";
const models = ref<NodeMediaModel[]>([]);
const modelsLoading = ref(false);
const uploading = ref(false);
const fileInput = ref<HTMLInputElement>();
let disposed = false;
const deleting = ref(false);
const previewVisible = ref(false);
const imageWidth = ref(0);
let generationController: AbortController | undefined;
const generationState = useNodeGeneration(outputs, () => generationController?.abort());
const { generating } = generationState;
let generation: Promise<void> | undefined;
let modelsRequest: Promise<void> | undefined;
const selectedModel = computed(() => models.value.find((item) => JSON.stringify([item.providerId, item.modelId]) === data.value.model));
const sizeOptions = computed(() => selectedModel.value?.imageSizes ?? []);
const ratioOptions = computed(() => selectedModel.value?.imageRatios ?? []);
watch(
  selectedModel,
  (choice) => {
    if (!choice) return;
    // ACT: 现有分辨率使用 K 单位；出现其他单位时再统一换算，未知名称排在数值选项之后。
    if (!sizeOptions.value.includes(data.value.size)) data.value.size = sizeOptions.value.toSorted((left, right) =>
      (Number.parseFloat(left) || Infinity) - (Number.parseFloat(right) || Infinity)
    )[0] ?? "";
    if (!ratioOptions.value.includes(data.value.ratio)) data.value.ratio = ratioOptions.value.includes("16:9") ? "16:9" : ratioOptions.value[0] ?? "";
  },
  { flush: "sync" }
);
const modelGroups = computed(() => groupNodeModels(models.value));
const generationPrompt = computed(() =>
  [
    data.value.prompt.trim(),
    ...refList.value.flatMap((item, index) => (item.dataType === "STRING" && item.value?.trim() ? [`参考 ${index + 1}：\n${item.value.trim()}`] : [])),
  ]
    .filter(Boolean)
    .join("\n\n")
);
const outputFile = computed(() => outputs.value.image?.dataType === "IMAGE" ? outputs.value.image.value : undefined);
const previewUrl = files.useFileUrl(
  outputFile,
  (error) => showError(error, "图片读取失败")
);

onMounted(() => loadModels()
  .then(() => resumePendingGeneration())
  .catch((error) => showError(error, "模型读取失败")));
onScopeDispose(() => {
  disposed = true;
  generationController?.abort();
});

async function replaceOutput(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = "";
  if (!file || generating.value || deleting.value || uploading.value || disposed) return;
  if (!file.type.startsWith("image/")) return void ElMessage.error("请选择图片文件");
  if (!file.size || file.size > 100 * 1024 * 1024) return void ElMessage.error("图片不能为空且不能超过 100 MB");
  uploading.value = true;
  try {
    const workspace = files.getWorkspaceFiles();
    const url = await files.uploadFile(file);
    if (disposed) {
      await workspace.remove(url);
      return;
    }
    // ACT: 保留历史输出文件，避免破坏撤销记录和复制节点的引用。
    outputs.value.image = { dataType: "IMAGE", value: { url, mimeType: file.type } };
  } catch (error) {
    showError(error, "图片替换失败");
  } finally {
    uploading.value = false;
  }
}

function loadModels() {
  if (modelsRequest) return modelsRequest;
  modelsLoading.value = true;
  modelsRequest = ai.getMediaModels().then((items) => {
    if (generating.value || deleting.value) return;
    models.value = items.filter((item) => item.type === "image");
    // ACT: 只给空配置选默认模型，保留暂时不可用的旧选择及其参数。
    if (!data.value.model) {
      const first = models.value[0];
      data.value.model = first ? JSON.stringify([first.providerId, first.modelId]) : "";
    }
  }).finally(() => {
    modelsLoading.value = false;
    modelsRequest = undefined;
  });
  return modelsRequest;
}

function mediaBindingFields(binding?: PrepareMediaJobResult) {
  return binding ? {
    canvasPath: binding.canvasPath,
    nodeId: binding.nodeId,
    outputSlot: binding.outputSlot,
    expectedNodeVersion: binding.expectedNodeVersion,
  } : {};
}

function buildImageInput(choice: NodeMediaModel) {
  return {
    providerId: choice.providerId,
    modelId: choice.modelId,
    prompt: generationPrompt.value,
    size: choice.imageSizes?.includes(data.value.size) ? data.value.size : undefined,
    ratio: choice.imageRatios?.includes(data.value.ratio) ? data.value.ratio : undefined,
    outputDirectory: `assets/${id}`,
    images: refList.value.flatMap((item) => (item.dataType === "IMAGE" && item.value ? [{ path: item.value.url, mimeType: item.value.mimeType }] : [])),
  };
}

async function waitForImageResult(directory: string, idempotencyKey: string, binding?: PrepareMediaJobResult, signal?: AbortSignal) {
  const choice = selectedModel.value;
  if (!choice) throw new Error("请先选择图片模型");
  const [result] = await ai.generateImage({
    directory,
    idempotencyKey,
    ...buildImageInput(choice),
    ...mediaBindingFields(binding),
  }, signal);
  if (!result) throw new Error("供应商未返回图片");
  outputs.value.image = { dataType: "IMAGE", value: { url: result.path, mimeType: result.mimeType } };
  await mediaPersistence.clearPending(outputSlot);
}

async function resumePendingGeneration() {
  const pending = mediaPersistence.readPending();
  if (!pending || pending.outputSlot !== outputSlot || generating.value || uploading.value || deleting.value) return;
  const workspace = files.getWorkspaceFiles();
  const controller = new AbortController();
  generationController = controller;
  generation = generationState.run(async () => {
    const { directory } = await workspace.list();
    controller.signal.throwIfAborted();
    const job = await ai.fetchMediaJob(directory, pending.idempotencyKey, controller.signal);
    if (!job) throw new Error("未找到任务记录，点击生成可核对并确认放弃原任务");
    if (job.status === "completed" && job.linkStatus !== "pending" && job.files?.length) {
      const result = job.files.find(file => file.mediaType === "image") ?? job.files[0];
      outputs.value.image = { dataType: "IMAGE", value: { url: result.path, mimeType: result.mimeType } };
      await mediaPersistence.clearPending(outputSlot);
      return;
    }
    if (job.status === "failed") throw Object.assign(new Error(job.errorMessage || "媒体生成失败"), { definitive: true });
    if (job.status === "unknown") throw new Error(`${job.errorMessage || "提交结果未知"}；结果未知，点击生成可确认放弃后重新提交`);
    if (job.status === "collectionFailed") {
      throw new Error(job.errorMessage || "媒体生成失败");
    }
    const [result] = await ai.pollMediaJob(directory, pending.idempotencyKey, controller.signal);
    if (!result) throw new Error("供应商未返回图片");
    outputs.value.image = { dataType: "IMAGE", value: { url: result.path, mimeType: result.mimeType } };
    await mediaPersistence.clearPending(outputSlot);
  })
    .catch(async (error) => {
      showError(error, "图片生成失败");
      await mediaPersistence.releaseFailed(outputSlot, error).catch((releaseError) => showError(releaseError, "解除任务占用失败"));
    })
    .finally(() => {
      generationController = undefined;
    });
}

// 结果未知的任务不会再写回节点；只有按钮操作经用户确认后才解除占用，Agent 调用仍被 prepare 拒绝。
async function releaseUnknownPending() {
  const pending = mediaPersistence.readPending();
  if (!pending || pending.outputSlot !== outputSlot || generating.value) return true;
  const { directory } = await files.getWorkspaceFiles().list();
  const job = await ai.fetchMediaJob(directory, pending.idempotencyKey);
  if (job && job.status !== "unknown") {
    await resumePendingGeneration();
    return false;
  }
  try {
    await ElMessageBox.confirm(
      "上次任务结果未知，服务可能仍在生成或已计费。请先在服务端核对；放弃后原任务的结果不会写回节点，本次会产生新的生成请求。",
      "放弃上次任务？",
      { type: "warning", confirmButtonText: "放弃并重新生成", cancelButtonText: "取消" },
    );
  } catch { return false; }
  if (disposed || mediaPersistence.readPending()?.idempotencyKey !== pending.idempotencyKey) return false;
  const current = await ai.fetchMediaJob(directory, pending.idempotencyKey);
  if (current && current.status !== "unknown") {
    await resumePendingGeneration();
    return false;
  }
  await mediaPersistence.clearPending(outputSlot);
  return true;
}

async function startFromButton() {
  if (await releaseUnknownPending()) await startGeneration();
}

async function startGeneration() {
  const choice = selectedModel.value;
  if (generating.value) throw new Error("图片正在生成，请等待完成");
  if (uploading.value) throw new Error("图片正在替换，请等待完成");
  if (deleting.value) throw new Error("节点正在删除");
  if (!choice) throw new Error("请先选择图片模型");
  if (!generationPrompt.value) throw new Error("请输入生成提示词");
  if (refList.value.some(item => item.value === undefined)) throw new Error("引用节点暂无内容，请先补充引用内容");
  const workspace = files.getWorkspaceFiles();
  const controller = new AbortController();
  const { idempotencyKey, binding } = await mediaPersistence.prepare(outputSlot);
  generationController = controller;
  // ACT: 工具立即返回，任务由节点持有，停止或卸载时取消本地等待。
  generation = generationState.run(() => workspace
    .list()
    .then(({ directory }) => {
      controller.signal.throwIfAborted();
      return waitForImageResult(directory, idempotencyKey, binding, controller.signal);
    }))
    .catch(async (error) => {
      showError(error, "图片生成失败");
      await mediaPersistence.releaseFailed(outputSlot, error).catch((releaseError) => showError(releaseError, "解除任务占用失败"));
    })
    .finally(() => {
      generationController = undefined;
    });
  return { status: "generating" };
}

nodeEvent.on("save", (reason) => {
  if (reason === "reload" && (generating.value || uploading.value || deleting.value)) throw new Error("图片处理中，请完成后再刷新节点");
});
nodeEvent.on("delete", async () => {
  if (uploading.value) throw new Error("图片正在替换，请稍后删除节点");
  deleting.value = true;
  generationController?.abort();
  try {
    await generation;
    await files.removeNodeFiles();
  } finally {
    deleting.value = false;
  }
});

async function resizeImage(event: Event) {
  const image = event.currentTarget as HTMLImageElement;
  if (!image.naturalWidth || !image.naturalHeight) return;
  imageWidth.value = (240 * image.naturalWidth) / image.naturalHeight;
  await nextTick();
  updateNodeInternals();
}

function showError(error: unknown, fallback: string) {
  if (error instanceof Error && error.name === "AbortError") return;
  const message = (error as { response?: { data?: { message?: string } } })?.response?.data?.message;
  ElMessage.error(message || (error instanceof Error ? error.message : fallback));
}

function getConfig() {
  return {
    config: {
      providerId: selectedModel.value?.providerId ?? "",
      modelId: selectedModel.value?.modelId ?? "",
      size: data.value.size,
      ratio: data.value.ratio,
    },
    models: models.value,
  };
}

nodeTools.register({
  name: "getConfig",
  description: "读取此图片生成节点的当前模型、分辨率、比例及可选图片模型能力，不含密钥；未声明的分辨率或比例不会发送给供应商",
  parameters: z.strictObject({}),
  async execute(_args, { signal }) {
    signal?.throwIfAborted();
    await loadModels();
    signal?.throwIfAborted();
    return getConfig();
  },
});

nodeTools.register({
  name: "setConfig",
  description: "修改此图片生成节点的模型、分辨率或比例；先用 getConfig 查询可选能力，providerId 与 modelId 必须同时提供；不修改提示词、不启动生成",
  parameters: z.strictObject({
    providerId: z.string().min(1).optional(),
    modelId: z.string().min(1).optional(),
    size: z.string().min(1).optional(),
    ratio: z.string().min(1).optional(),
  }).refine((args) => (args.providerId === undefined) === (args.modelId === undefined), "providerId 与 modelId 必须同时提供"),
  async execute(args, { signal }) {
    signal?.throwIfAborted();
    if (generating.value || deleting.value) throw new Error("节点正在生成或删除，请稍后修改配置");
    await loadModels();
    signal?.throwIfAborted();
    if (generating.value || deleting.value) throw new Error("节点正在生成或删除，请稍后修改配置");
    const choice = args.modelId === undefined ? selectedModel.value
      : models.value.find((item) => item.providerId === args.providerId && item.modelId === args.modelId);
    if (!choice) throw new Error("请选择 getConfig 返回的有效图片模型");
    const sizes = choice.imageSizes ?? [];
    const ratios = choice.imageRatios ?? [];
    if (args.size !== undefined && !sizes.includes(args.size)) throw new Error(`当前模型不支持分辨率 ${args.size}，可选：${sizes.join("、")}`);
    if (args.ratio !== undefined && !ratios.includes(args.ratio)) throw new Error(`当前模型不支持比例 ${args.ratio}，可选：${ratios.join("、")}`);
    data.value.model = JSON.stringify([choice.providerId, choice.modelId]);
    if (args.size !== undefined) data.value.size = args.size;
    if (args.ratio !== undefined) data.value.ratio = args.ratio;
    return getConfig();
  },
});

nodeTools.register({
  name: "setPrompt",
  description: "修改此节点的图片生成提示词，支持 {{ref 1}} 等参考标记；只修改提示词，不启动生成",
  parameters: z.strictObject({ prompt: z.string() }),
  execute({ prompt: value }) {
    if (deleting.value) throw new Error("节点正在删除，请稍后修改");
    data.value.prompt = value;
    data.value.promptModel = value.split("\n").map((text) => [{ type: "Write", text }]);
    return { prompt: value };
  },
});

nodeTools.register({
  name: "generateImage",
  description: "启动此节点的后台图片生成，使用当前提示词、模型、分辨率、比例和参考图片；立即返回已开始，用 getGenerationStatus 查询完成结果，cancelGeneration 停止生成",
  parameters: z.strictObject({}),
  execute(_args, { signal }) {
    signal?.throwIfAborted();
    return startGeneration();
  },
});
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
