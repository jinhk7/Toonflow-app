<template>
  <el-drawer v-model="visible" title="添加连接" direction="btt" size="75%" appendToBody>
    <el-form labelPosition="top">
      <el-form-item label="目标节点">
        <el-select v-model="targetId" filterable placeholder="选择节点" style="width: 100%" @change="syncHandles">
          <el-option
            v-for="node in candidates"
            :key="node.id"
            :label="nodeLabel(node)"
            :value="node.id"
            :disabled="node.id === sourceId" />
        </el-select>
      </el-form-item>
      <el-form-item label="输出端口（当前节点）">
        <el-select v-model="sourceHandle" style="width: 100%">
          <el-option v-for="handle in sourceHandles" :key="handle.id" :label="handle.label || handle.id" :value="handle.id" />
        </el-select>
      </el-form-item>
      <el-form-item label="输入端口（目标节点）">
        <el-select v-model="targetHandle" style="width: 100%">
          <el-option v-for="handle in targetHandles" :key="handle.id" :label="handle.label || handle.id" :value="handle.id" />
        </el-select>
      </el-form-item>
      <el-alert v-if="browserRuleWarning" type="info" :closable="false" showIcon title="该目标节点可能在桌面端有额外连接规则；手机端仅校验类型与端口，保存后若桌面插件拒绝请改用桌面画布。" />
      <el-button type="primary" :disabled="!canSubmit" style="width: 100%" @click="submit">连接</el-button>
    </el-form>
  </el-drawer>
</template>

<script setup lang="ts">
import { computed, ref, watch } from "vue";
import type { Connection } from "@vue-flow/core";
import { nodeLabel, type CanvasNode } from "../lib/mobileGraphModel";
import { canConnect, connectionRequiresBrowserRule } from "../lib/validateConnection";

const props = defineProps<{
  modelValue: boolean;
  sourceId: string;
  nodes: CanvasNode[];
}>();

const emit = defineEmits<{ "update:modelValue": [boolean]; connect: [Connection] }>();

const visible = computed({
  get: () => props.modelValue,
  set: value => emit("update:modelValue", value),
});

const targetId = ref("");
const sourceHandle = ref("");
const targetHandle = ref("");

const sourceNode = computed(() => props.nodes.find(n => n.id === props.sourceId));
const targetNode = computed(() => props.nodes.find(n => n.id === targetId.value));
const candidates = computed(() => props.nodes.filter(n => n.type !== "canvasGroup"));

function listHandles(node: CanvasNode | undefined, type: "source" | "target") {
  const list = node?.data?.handles;
  if (!Array.isArray(list)) return [] as { id: string; label?: string }[];
  return list.filter(h => h && h.type === type);
}

const sourceHandles = computed(() => listHandles(sourceNode.value, "source"));
const targetHandles = computed(() => listHandles(targetNode.value, "target"));

const browserRuleWarning = computed(() => targetNode.value && connectionRequiresBrowserRule(targetNode.value));

const canSubmit = computed(() => {
  if (!sourceNode.value || !targetNode.value || !sourceHandle.value || !targetHandle.value) return false;
  return canConnect({
    source: props.sourceId,
    target: targetId.value,
    sourceHandle: sourceHandle.value,
    targetHandle: targetHandle.value,
  }, sourceNode.value, targetNode.value).ok;
});

function syncHandles() {
  targetHandle.value = targetHandles.value[0]?.id ?? "";
}

watch(() => props.modelValue, open => {
  if (!open) return;
  targetId.value = "";
  sourceHandle.value = sourceHandles.value[0]?.id ?? "";
  targetHandle.value = "";
});

function submit() {
  if (!canSubmit.value) return;
  emit("connect", {
    source: props.sourceId,
    target: targetId.value,
    sourceHandle: sourceHandle.value,
    targetHandle: targetHandle.value,
  });
  visible.value = false;
}
</script>
