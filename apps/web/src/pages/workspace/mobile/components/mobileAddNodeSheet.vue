<template>
  <el-drawer v-model="visible" class="mobileSheet" modalClass="mobileSheetOverlay" title="新增节点" direction="btt" size="70%" appendToBody>
    <el-form labelPosition="top" @submit.prevent>
      <el-form-item label="节点类型">
        <el-select v-model="type" filterable placeholder="选择类型" style="width: 100%">
          <el-option v-for="item in nodeTypes" :key="item.type" :label="item.label" :value="item.type" />
        </el-select>
      </el-form-item>
      <el-form-item label="显示名称">
        <el-input v-model="label" maxlength="120" />
      </el-form-item>
      <el-button type="primary" :disabled="!type" style="width: 100%" @click="submit">创建</el-button>
    </el-form>
  </el-drawer>
</template>

<script setup lang="ts">
import { computed, ref, watch } from "vue";

const props = defineProps<{ modelValue: boolean; nodeTypes: { type: string; label: string }[] }>();
const emit = defineEmits<{ "update:modelValue": [boolean]; create: [{ type: string; label: string }] }>();

const visible = computed({
  get: () => props.modelValue,
  set: value => emit("update:modelValue", value),
});

const type = ref("");
const label = ref("");

watch(() => props.modelValue, open => {
  if (!open) return;
  type.value = props.nodeTypes[0]?.type ?? "";
  label.value = props.nodeTypes.find(n => n.type === type.value)?.label ?? "";
});

watch(type, value => {
  const match = props.nodeTypes.find(n => n.type === value);
  if (match) label.value = match.label;
});

function submit() {
  if (!type.value) return;
  emit("create", { type: type.value, label: label.value.trim() || props.nodeTypes.find(n => n.type === type.value)?.label || "节点" });
  visible.value = false;
}
</script>
