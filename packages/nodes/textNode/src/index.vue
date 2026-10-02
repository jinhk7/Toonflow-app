<template>
  <nodeSkeleton
    v-bind="nodeProps"
    :outputs="{ text: { dataType: 'STRING', value: savedText } }"
    v-model:bottomVisible="node.selected"
    :topVisible="node.selected"
    topWidth="max-content"
    :downloadUrl="downloadUrl"
    :downloadName="`${nodeProps.label || '文本'}.txt`"
    :bottomWidth="660"
    @fullscreen="fullscreen = true; editing = true">
    <div class="textContent" :class="{ empty: !text.trim() }">
      <div v-if="text.trim()" class="textPreview nopan nowheel" aria-label="文本内容">{{ text }}</div>
      <el-button class="editButton nodrag nopan" :icon="IconEdit" :disabled="generating || !textReady" text @dblclick.stop @click.stop="editing = true">编辑</el-button>
    </div>
    <template #bottom>
      <el-card class="promptCard" shadow="never" :bodyStyle="{ padding: '14px 16px 12px' }">
        <div class="promptHeader" v-if="refList.length">
          <referenceItem
            v-model="refList"
            @preview="setReferencePreview"
            @remove="removeReference" />
        </div>
        <promptInput v-model="promptModel" v-model:text="prompt" :references="referenceMentions" />
        <div class="promptFooter">
          <el-select v-model="model" class="modelSelect" filterable :loading="modelsLoading" :disabled="generating" placeholder="选择模型" aria-label="生成模型" noDataText="请先在设置中添加模型" placement="top-start" @visible-change="visible => visible && loadModels()">
            <template #prefix><icon-sparkles :size="17" /></template>
            <el-option-group v-for="provider in modelGroups" :key="provider.id" :label="provider.label">
              <el-option v-for="item in provider.models" :key="item.modelId" :label="item.label" :value="JSON.stringify([item.providerId, item.modelId])" />
            </el-option-group>
          </el-select>
          <div class="promptActions">
            <el-button class="sendButton" :icon="IconArrowUp" :loading="generating" :disabled="!prompt.trim() || !selectedModel || generating || !textReady" title="生成" aria-label="生成" @click="generateText" />
          </div>
        </div>
      </el-card>
    </template>
  </nodeSkeleton>
  <el-dialog v-model="editing" title="编辑文本" width="min(860px, calc(100vw - 32px))" :fullscreen="fullscreen" alignCenter appendToBody @closed="fullscreen = false">
    <el-input class="textEditor" :class="{ fullscreen }" v-model="text" type="textarea" :rows="1" :disabled="generating" resize="none" aria-label="编辑文本内容" />
  </el-dialog>
</template>

<script setup lang="ts">
import { computed, onMounted, onScopeDispose, ref, watch } from "vue";
import { ElButton, ElCard, ElInput, ElSelect, ElDialog, ElOption, ElOptionGroup, ElMessage, ElMessageBox } from "element-plus";
import { IconEdit, IconFileText, IconSparkles, IconArrowUp } from "@tabler/icons-vue";
import { groupNodeModels, nodeSkeleton, useNode, useNodeReferences, type NodeAiModel } from "@toonflow/nodes-scaffold/runtime";
import referenceItem from "@toonflow/nodes-scaffold/referenceItem";
import promptInput from "@toonflow/nodes-scaffold/promptInput";

type PromptModel = NonNullable<InstanceType<typeof promptInput>["$props"]["modelValue"]>;
defineOptions({ inheritAttrs: false, icon: IconFileText });
const { node, nodeProps, execution, nodeEvent } = useNode({ label: "文本" });
const nodeData = computed(() => node.data as typeof node.data & Record<string, unknown>);
const { refList, referenceMentions, setReferencePreview, removeReference } = useNodeReferences();
const text = ref("");
const savedText = ref("");
const textReady = ref(false);
const textPath = `assets/${node.id}/content.md`;
const editing = ref(false);
const fullscreen = ref(false);
const downloadUrl = ref("");
const prompt = ref(typeof nodeData.value.prompt === "string" ? nodeData.value.prompt : "");
const promptModel = ref<PromptModel>(Array.isArray(nodeData.value.promptModel) ? nodeData.value.promptModel as PromptModel : []);
const model = ref(typeof nodeData.value.model === "string" ? nodeData.value.model : "");
const models = ref<NodeAiModel[]>([]);
const modelsLoading = ref(false);
const generating = ref(false);
const selectedModel = computed(() => models.value.find(item => JSON.stringify([item.providerId, item.modelId]) === model.value));
const modelGroups = computed(() => groupNodeModels(models.value));
let revision = "";
let applying = false;
let disposed = false;
let dirty = false;
let saveError: unknown;
let textSaving = Promise.resolve();
let promptSaving = Promise.resolve();
let promptTimer: ReturnType<typeof setTimeout> | undefined;
let pollTimer: ReturnType<typeof setTimeout> | undefined;

function showError(error: unknown) {
  if (error instanceof Error && error.name === "AbortError") return;
  ElMessage.error(error instanceof Error ? error.message : "文本操作失败");
}
function applyText(content: string, nextRevision: string) {
  applying = true;
  text.value = content;
  savedText.value = content;
  revision = nextRevision;
  applying = false;
}
watch([text, () => node.selected], ([content, selected], _previous, onCleanup) => {
  downloadUrl.value = "";
  if (!selected || !content.trim()) return;
  const url = URL.createObjectURL(new Blob([content], { type: "text/plain;charset=utf-8" }));
  downloadUrl.value = url;
  onCleanup(() => URL.revokeObjectURL(url));
}, { immediate: true });
watch(text, value => {
  if (applying || !textReady.value || generating.value) return;
  dirty = true;
  textSaving = textSaving.then(async () => {
    if (saveError) throw saveError;
    const result = await execution.writeText(textPath, value, revision);
    revision = result.revision;
    savedText.value = value;
    if (text.value === value) dirty = false;
  }).catch(error => { saveError = error; showError(error); });
}, { flush: "sync" });
function savePrompt() {
  clearTimeout(promptTimer);
  promptTimer = undefined;
  const value = prompt.value;
  promptSaving = promptSaving.catch(() => {}).then(() => execution.call("setPrompt", { prompt: value })).then(() => {});
  return promptSaving;
}
watch([prompt, promptModel], () => {
  if (applying) return;
  clearTimeout(promptTimer);
  promptTimer = setTimeout(() => { void savePrompt().catch(showError); }, 400);
}, { deep: true, flush: "sync" });
watch(model, value => {
  if (applying) return;
  const choice = models.value.find(item => JSON.stringify([item.providerId, item.modelId]) === value);
  if (!choice || value === nodeData.value.model) return;
  promptSaving = promptSaving.catch(() => {}).then(() => execution.call("setConfig", { providerId: choice.providerId, modelId: choice.modelId })).then(() => {});
  void promptSaving.catch(showError);
}, { flush: "sync" });
watch(() => [nodeData.value.prompt, nodeData.value.model], () => {
  applying = true;
  if (!promptTimer && prompt.value !== nodeData.value.prompt && typeof nodeData.value.prompt === "string") prompt.value = nodeData.value.prompt;
  if (typeof nodeData.value.model === "string" && model.value !== nodeData.value.model) model.value = nodeData.value.model;
  applying = false;
});
nodeEvent.on("save", async () => {
  await textSaving;
  if (saveError) throw saveError;
});
nodeEvent.on("copy", () => {
  if (!textReady.value || dirty || saveError) throw new Error("请先完成文本保存");
  return { textPath: undefined, textSnapshot: text.value };
});
async function loadModels() {
  if (modelsLoading.value) return;
  modelsLoading.value = true;
  try {
    const state = await execution.call<{ model: string; models: NodeAiModel[] }>("getConfig");
    models.value = state.models;
    if (!model.value && state.models[0]) model.value = JSON.stringify([state.models[0].providerId, state.models[0].modelId]);
  } finally { modelsLoading.value = false; }
}
async function refresh() {
  try {
    if (!document.hidden) {
      const jobId = nodeData.value.generationJobId;
      const job = typeof jobId === "string" ? await execution.getJob(jobId) : undefined;
      generating.value = !!job && ["accepted", "running"].includes(job.status);
      const current = await execution.readText(textPath);
      if (!dirty && !saveError && !editing.value) applyText(current.content, current.revision);
    }
  } catch (error) { if (!disposed) showError(error); }
  finally { if (!disposed) pollTimer = setTimeout(() => { void refresh(); }, 2000); }
}
async function generateText() {
  if (!textReady.value || generating.value || !selectedModel.value || !prompt.value.trim()) return;
  try {
    await textSaving;
    if (saveError) throw saveError;
    const jobId = nodeData.value.generationJobId;
    const previous = typeof jobId === "string" ? await execution.getJob(jobId) : undefined;
    if (previous?.status === "needsReview") {
      try {
        await ElMessageBox.confirm("上次任务需要核对，可能仍在生成或已计费；已收到的生成结果保留在任务历史中。请先核对，确认后才解除原任务绑定并发起新的生成。", "解除上次文本任务？", { type: "warning", confirmButtonText: "解除并重新生成", cancelButtonText: "取消" });
      } catch { return; }
      await execution.call("abandonUnknownGeneration", { confirmed: true });
    }
    await savePrompt();
    await execution.call("generateText");
    generating.value = true;
  } catch (error) { showError(error); }
}
onMounted(async () => {
  try {
    const value = await execution.call<{ content: string; revision: string }>("getText");
    applyText(value.content, value.revision);
    textReady.value = true;
    await loadModels();
    void refresh();
  } catch (error) { showError(error); }
});
onScopeDispose(() => { disposed = true; clearTimeout(promptTimer); clearTimeout(pollTimer); });
</script>

<style lang="scss" scoped>
.textEditor {
  &.fullscreen :deep(.el-textarea__inner) {
    height: calc(100dvh - 112px);
  }

  :deep(.el-textarea__inner) {
    height: min(560px, calc(100dvh - 144px));
    padding: 16px 20px;
    overflow-y: auto;
    overscroll-behavior: contain;
    font-size: 14px;
    line-height: 1.8;
  }
}

.textContent {
  min-height: 110px;

  &.empty {
    display: flex;
    align-items: center;
    justify-content: center;

    .editButton {
      margin: 0;
    }
  }

  .textPreview {
    min-height: 110px;
    max-height: 240px;
    overflow: auto;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    user-select: none;
  }

  .editButton {
    display: flex;
    margin-left: auto;
  }
}

.promptCard {
  .promptHeader {
    display: flex;
    align-items: flex-start;
    gap: 12px;
  }

  .promptFooter {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;

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

    .promptActions {
      display: flex;
      align-items: center;
      gap: 12px;

      .toolButton {
        width: 28px;
        height: 28px;
        padding: 0;
      }

      .generationCount {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        color: var(--el-text-color-secondary);
        font-size: 12px;
      }

      .sendButton {
        width: 32px;
        height: 32px;
        margin: 0;
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
}
</style>
