<template>
  <div v-click-outside:[clickOutsideExclude]="closeMobilePopover" class="modelPopover" @keydown.esc.capture="handleMobileEscape">
    <el-popover
      ref="popoverRef"
      v-bind="popoverVisibility"
      @hide="closeMobilePopover"
      trigger="click"
      placement="top-start"
      :width="340"
      :offset="10"
      :showArrow="false"
      popperClass="agentModelPopover"
      :popperOptions="mobile ? mobilePopupOptions : undefined"
      :popperStyle="{ padding: '20px', maxWidth: 'calc(100vw - 24px)' }">
      <template #reference>
        <el-button ref="modelButtonRef" class="modelButton" text :disabled="disabled" aria-label="模型与推理设置" @click="toggleMobilePopover">
          <modelIcon v-if="selectedModelChoice" :model="selectedModelChoice.modelId" :size="14" />
          <span class="modelName">{{ selectedModelChoice?.label ?? "选择模型" }}</span>
          <span class="reasoningSummary">· <span class="reasoningLabel">{{ reasoningLabel }}</span></span>
          <icon-chevron-down :size="12" />
        </el-button>
      </template>
      <el-form class="modelOptions" labelPosition="top" @keydown.esc.capture="handleMobileEscape">
        <el-form-item label="模型">
          <template v-if="mobile" #label>
            <div class="modelFieldLabel">
              <span>模型</span>
              <el-button ref="modelSearchButtonRef" class="modelSearchButton" text :disabled="disabled" :aria-pressed="modelSearchActive" @pointerdown="modelSearchButtonRef?.ref?.focus({ preventScroll: true })" @click.prevent="toggleMobileSearch">{{ modelSearchActive ? "结束搜索" : "搜索模型" }}</el-button>
            </div>
          </template>
          <el-select ref="selectRef" v-model="selectedModel" :filterable="!mobile || modelSearchActive" :automaticDropdown="mobile && modelSearchActive" :disabled="disabled" :teleported="mobile" placeholder="选择模型" aria-label="选择模型" noDataText="请先在设置中添加模型" @visible-change="handleModelDropdown">
            <template #prefix><modelIcon v-if="selectedModelChoice" :model="selectedModelChoice.modelId" :size="18" /></template>
            <el-option-group v-for="provider in modelGroups" :key="provider.id" :label="provider.label">
              <el-option v-for="model in provider.models" :key="model.id" :label="model.label" :value="JSON.stringify([provider.id, model.id])">
                <el-space :size="8">
                  <modelIcon :model="model.id" :size="16" />
                  <span>{{ model.label }}</span>
                </el-space>
              </el-option>
            </el-option-group>
          </el-select>
        </el-form-item>
        <el-form-item label="推理等级">
          <el-segmented v-model="reasoningEffort" :options="reasoningOptions" :disabled="disabled" block aria-label="推理等级" />
        </el-form-item>
      </el-form>
    </el-popover>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import { useRoute } from "vue-router";
import { ClickOutside as vClickOutside, ElButton, ElPopover, ElSelect } from "element-plus";
import { mobilePopupOptions } from "./agent/popupPosition";
import { IconChevronDown } from "@tabler/icons-vue";
import { modelIcon } from "@toonflow/model-icons";
import { customProviders, modelChoices } from "@/stores/settings";

const selectedModel = defineModel<string>({ default: "" });
const reasoningEffort = defineModel<string>("reasoningEffort", { default: "" });
const props = withDefaults(defineProps<{ active?: boolean; disabled?: boolean }>(), { active: true, disabled: false });
const visible = ref(false);
const modelDropdownVisible = ref(false);
const modelSearchActive = ref(false);
const modelButtonRef = ref<InstanceType<typeof ElButton>>();
const modelSearchButtonRef = ref<InstanceType<typeof ElButton>>();
const route = useRoute();
const mobile = computed(() => route.path === "/mobile" || route.path.startsWith("/mobile/"));
const popoverRef = ref<InstanceType<typeof ElPopover>>();
const selectRef = ref<InstanceType<typeof ElSelect>>();
const clickOutsideExclude = computed(() => [popoverRef.value?.popperRef?.contentRef, selectRef.value?.popperRef]);
// 移动子下拉在 body 中，关闭父层时排除该下拉；桌面保持库的原有 v-model 行为。
const popoverVisibility = computed(() => mobile.value
  ? { visible: visible.value }
  : { visible: visible.value, "onUpdate:visible": updateVisible });

function updateVisible(value: boolean) { visible.value = value; }
function toggleMobilePopover() {
  if (!mobile.value) return;
  visible.value = !visible.value;
  if (visible.value) modelButtonRef.value?.ref?.focus({ preventScroll: true });
}
function closeMobilePopover() { if (mobile.value) visible.value = false; }

async function toggleMobileSearch() {
  if (!mobile.value || props.disabled) return;
  const search = !modelSearchActive.value;
  modelSearchActive.value = false;
  selectRef.value?.blur();
  await nextTick();
  if (!visible.value || !props.active || props.disabled) return;
  modelSearchActive.value = search;
  await nextTick();
  if (!visible.value || !props.active || props.disabled) return;
  if (modelSearchActive.value) selectRef.value?.focus();
  else modelButtonRef.value?.ref?.focus({ preventScroll: true });
}

function handleModelDropdown(value: boolean) {
  modelDropdownVisible.value = value;
  if (value || !mobile.value || !modelSearchActive.value) return;
  // 切换按钮先移走输入焦点；由其 click 决定下一模式，避免关闭回调抢先反转。
  if (document.activeElement === modelSearchButtonRef.value?.ref) return;
  const restoreFocus = selectRef.value?.$el.contains(document.activeElement);
  modelSearchActive.value = false;
  nextTick(() => {
    selectRef.value?.blur();
    if (restoreFocus && visible.value && props.active && !props.disabled) modelButtonRef.value?.ref?.focus({ preventScroll: true });
  });
}

function handleMobileEscape(event: KeyboardEvent) {
  // Select 会阻止 Escape 冒泡；捕获阶段先保留子层处理，再关闭父层。
  if (!mobile.value || !visible.value || modelDropdownVisible.value || event.isComposing || event.repeat) return;
  event.preventDefault();
  event.stopPropagation();
  visible.value = false;
  nextTick(() => modelButtonRef.value?.ref?.focus({ preventScroll: true }));
}

const reasoningOptions = [
  { label: "默认", value: "" },
  { label: "低", value: "low" },
  { label: "中", value: "medium" },
  { label: "高", value: "high" },
];
const modelGroups = computed(() => customProviders.value.toSorted((left, right) => Number(right.id === "tfRouter") - Number(left.id === "tfRouter")));
const selectedModelChoice = computed(() => modelChoices.value.find(item => item.value === selectedModel.value));
const reasoningLabel = computed(() => reasoningOptions.find(item => item.value === reasoningEffort.value)?.label ?? "默认");
watch(selectedModel, () => { reasoningEffort.value = ""; });
watch(visible, value => {
  if (!value) {
    modelSearchActive.value = false;
    if (mobile.value) selectRef.value?.blur();
  }
});
watch(modelChoices, items => {
  if (!selectedModel.value) selectedModel.value = items[0]?.value ?? "";
}, { immediate: true });
watch(() => !props.active || props.disabled, close => { if (close) visible.value = false; });
</script>

<style lang="scss">
.modelPopover {
  display: inline-flex;
  min-width: 0;
  max-width: 100%;

  .modelButton {
    max-width: 100%;
    min-width: 0;
    height: 28px;
    padding: 0 8px;
    color: var(--el-text-color-regular);

    > span {
      display: flex;
      gap: 6px;
      min-width: 0;
    }
    svg {
      flex-shrink: 0;
    }

    .reasoningLabel {
      flex-shrink: 0;
      color: var(--el-text-color-secondary);
      font-size: 12px;
    }
    .reasoningSummary { display: flex; gap: 6px; flex-shrink: 0; }

    .modelName {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      text-align: left;
    }
  }
}

.agentModelPopover {
  .modelOptions {
    .el-form-item {
      margin-bottom: 24px;

      &:last-child {
        margin-bottom: 0;
      }
      .el-form-item__label {
        margin-bottom: 10px;
        font-weight: 500;
        color: var(--el-text-color-primary);
        &:has(.modelFieldLabel) { height: auto; }
      }
      .modelFieldLabel { display: flex; align-items: center; justify-content: space-between; width: 100%; gap: 12px; }
      .modelSearchButton { min-height: 44px; min-width: 44px; padding: 0 8px; }
      .el-segmented {
        width: 100%;

        @media (max-width: 360px) {
          .el-segmented__item {
            padding-inline: 6px;
          }
        }
      }
    }
  }
}
</style>

