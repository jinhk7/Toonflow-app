<template>
  <el-card class="mobileAgentPanel" shadow="never">
    <template #header>Agent 运行</template>
    <el-button :loading="loading" @click="loadRuns">刷新运行列表</el-button>
    <el-alert v-if="error" :title="error" type="error" :closable="false" />
    <ul class="runList">
      <li v-for="run in runs" :key="run.runId">
        <strong>{{ run.modelId }} · {{ run.runId }}</strong>
        <p>{{ run.status }}</p>
        <el-button v-if="run.sessionFile" text type="primary" @click="openConversation(run.sessionFile)">打开会话</el-button>
      </li>
    </ul>
  </el-card>
</template>

<script setup lang="ts">
import { onUnmounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import axios from "axios";

type RunSummary = { runId: string; sessionFile: string | null; status: string; modelId: string };
const props = defineProps<{ directory: string }>();
const route = useRoute();
const router = useRouter();
const runs = ref<RunSummary[]>([]);
const loading = ref(false);
const error = ref("");
let revision = 0;
let timer: ReturnType<typeof setTimeout> | undefined;
let disposed = false;

async function loadRuns() {
  const directory = props.directory;
  if (!directory || disposed) return;
  const currentRevision = ++revision;
  loading.value = true;
  try {
    const { data } = await axios.get<{ code: number; data: RunSummary[]; message?: string }>("/api/agent/run/list", { params: { directory } });
    if (currentRevision !== revision || directory !== props.directory || disposed) return;
    if (data.code !== 200 || !Array.isArray(data.data)) throw new Error(data.message || "读取运行列表失败");
    runs.value = data.data;
    error.value = "";
  } catch (err) { if (currentRevision === revision && !disposed) error.value = err instanceof Error ? err.message : "读取运行列表失败"; }
  finally {
    if (currentRevision === revision && !disposed) {
      loading.value = false;
      clearTimeout(timer);
      if (!document.hidden) timer = setTimeout(() => { void loadRuns(); }, 5000);
    }
  }
}
function openConversation(session: string) {
  void router.push({ path: "/mobile/agent", query: { ...route.query, directory: props.directory, session } });
}
function recover() { clearTimeout(timer); if (!document.hidden) void loadRuns(); }
watch(() => props.directory, () => { revision++; runs.value = []; recover(); }, { immediate: true });
document.addEventListener("visibilitychange", recover);
window.addEventListener("online", recover);
onUnmounted(() => {
  disposed = true; revision++;
  clearTimeout(timer);
  document.removeEventListener("visibilitychange", recover);
  window.removeEventListener("online", recover);
});
</script>

<style scoped lang="scss">
.mobileAgentPanel {
  margin-top: 12px;
  .runList {
    padding: 0; list-style: none;
    li { padding: 8px 0; border-bottom: 1px solid var(--el-border-color-lighter); overflow-wrap: anywhere; }
  }
}
</style>
