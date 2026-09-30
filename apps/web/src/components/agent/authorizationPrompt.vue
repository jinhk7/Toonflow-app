<template>
  <el-dialog v-model="visible" title="工具授权" width="420px" :closeOnClickModal="false" :showClose="false">
    <p class="authorizationText">请核对本次工具调用、模型和完整输入；仅授权下方显示的同一输入。</p>
    <p v-if="pending" class="authorizationHint">工具：{{ pending.toolName }} · 模型：{{ pending.modelId }}</p>
    <pre v-if="pending" class="authorizationInput">{{ JSON.stringify(pending.args, null, 2) }}</pre>
    <el-input-number v-model="remaining" :min="1" :max="1000" aria-label="对此输入授权的执行次数" />
    <template #footer>
      <el-button @click="visible = false">稍后处理</el-button>
      <el-button type="primary" :loading="granting" @click="grant">确认授权</el-button>
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { ElMessage } from "element-plus";
import { fetchAgentRunSnapshot, grantAgentAuthorization, type AgentRunSnapshot } from "./runClient";

const props = defineProps<{ runId?: string; errorMessage?: string }>();
const visible = ref(false);
const granting = ref(false);
const remaining = ref(1);
const pendingCalls = ref<NonNullable<AgentRunSnapshot["pendingAuthorizations"]>>([]);
const pending = computed(() => pendingCalls.value[0]);

watch([() => props.runId, () => props.errorMessage], async ([runId]) => {
  if (!runId) { visible.value = false; pendingCalls.value = []; return; }
  try {
    const snapshot = await fetchAgentRunSnapshot(runId);
    if (props.runId !== runId) return;
    pendingCalls.value = snapshot.pendingAuthorizations ?? [];
    visible.value = pendingCalls.value.length > 0;
  } catch { visible.value = false; }
}, { immediate: true });

async function grant() {
  if (!props.runId || !pending.value) return;
  granting.value = true;
  try {
    const snapshot = await grantAgentAuthorization(props.runId, pending.value.toolCallId, remaining.value);
    pendingCalls.value = snapshot.pendingAuthorizations ?? [];
    ElMessage.success("已记录精确输入授权，请继续运行");
    visible.value = pendingCalls.value.length > 0;
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : "授权失败");
  } finally {
    granting.value = false;
  }
}
</script>

<style scoped lang="scss">
.authorizationText { margin: 0 0 8px; line-height: 1.5; }
.authorizationHint { margin: 0 0 8px; color: var(--el-text-color-secondary); font-size: 13px; }
.authorizationInput { max-height: 240px; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; }
</style>
