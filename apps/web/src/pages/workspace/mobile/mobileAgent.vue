<template>
  <section class="mobileAgent">
    <mobileTopBar title="Toonflow Agent" :subtitle="projectName" :backTo="workspaceLink">
      <template #actions><el-button text @click="openTasks">任务</el-button></template>
    </mobileTopBar>
    <div class="contextBar">
      <el-select v-model="canvasId" clearable placeholder="选择会话画布上下文" aria-label="会话画布上下文" @change="updateCanvas">
        <el-option v-for="canvas in canvases" :key="canvas.id" :label="canvas.name" :value="canvas.id" />
      </el-select>
      <el-button :disabled="!canvasId" @click="openCanvas">节点</el-button>
    </div>
    <agentPanel v-if="directory" :key="directory" v-model="visible" :directory="directory" :canvasId="canvasId" :selectedNodeIds="selectedNodeIds" :sessionFile="sessionFile" @session="updateSession" />
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { ElMessage } from "element-plus";
import agentPanel from "@/components/agent/index.vue";
import mobileTopBar from "./components/mobileTopBar.vue";
import { listProjectCanvases } from "./lib/canvasList";

const route = useRoute();
const router = useRouter();
const directory = computed(() => String(route.query.directory ?? ""));
const projectName = computed(() => String(route.query.name ?? "项目"));
const sessionFile = computed(() => typeof route.query.session === "string" ? route.query.session : undefined);
const canvasId = ref(String(route.query.canvas ?? ""));
const selectedNodeIds = computed<string[]>(() => {
  try {
    const ids: unknown = JSON.parse(String(route.query.selected ?? "[]"));
    return Array.isArray(ids) && ids.every(id => typeof id === "string") ? ids.slice(0, 1000) : [];
  } catch { return []; }
});
const canvases = ref<{ id: string; name: string }[]>([]);
const visible = ref(true);
const workspaceLink = computed(() => ({ path: "/mobile/workspace", query: { directory: directory.value, name: projectName.value, canvas: canvasId.value } }));

function openCanvas() { void router.push(workspaceLink.value); }
function openTasks() { void router.push({ path: "/mobile/tasks", query: { ...route.query, canvas: canvasId.value } }); }
function updateCanvas() { void router.replace({ query: { ...route.query, canvas: canvasId.value || undefined, selected: undefined } }); }
function updateSession(file: string) {
  if (file !== sessionFile.value) void router.replace({ query: { ...route.query, session: file } });
}
watch(visible, value => { if (!value) openCanvas(); });
watch(directory, async (target, _, onCleanup) => {
  let stale = false;
  onCleanup(() => { stale = true; });
  canvases.value = [];
  if (!target) return;
  try {
    const list = await listProjectCanvases(target);
    if (!stale) canvases.value = list;
  } catch (error) { if (!stale) ElMessage.error(error instanceof Error ? error.message : "读取画布列表失败"); }
}, { immediate: true });
onMounted(() => { if (!directory.value) void router.replace("/mobile"); });
</script>

<style scoped lang="scss">
.mobileAgent {
  display: flex;
  flex-direction: column;
  height: 100dvh;
  min-height: 0;
  padding-bottom: env(safe-area-inset-bottom);
  box-sizing: border-box;

  .contextBar {
    display: flex;
    gap: 8px;
    padding: 8px 12px;

    .el-select { flex: 1; min-width: 0; }
  }
  .agent { flex: 1; min-height: 0; }
  :deep(.senderActions) { flex-wrap: wrap; gap: 4px; }
  :deep(.welcomeMessage) { padding: 16px 8px; }
  :deep(.welcomeSuggestions) { flex-direction: column; }
  :deep(.messageActions) { opacity: 1; }
  :deep(.senderEditor) { --senderMaxHeight: 30dvh; }
}
</style>
