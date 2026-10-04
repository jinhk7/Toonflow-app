<template>
  <section class="mobileWorkspace">
    <mobileTopBar :title="projectName" :subtitle="canvasName" :backTo="'/mobile'" />
    <div class="toolbar">
      <el-select v-model="canvasId" class="canvasSelect" placeholder="画布" :loading="canvasLoading" @change="switchCanvas">
        <el-option v-for="canvas in canvases" :key="canvas.id" :label="canvas.name" :value="canvas.id" />
      </el-select>
      <el-input v-model="query" clearable placeholder="搜索节点名或类型" aria-label="搜索节点" />
      <el-radio-group v-model="viewMode" class="viewMode" aria-label="节点展示方式">
        <el-radio-button value="all">全部节点</el-radio-button>
        <el-radio-button value="type">按类型分组</el-radio-button>
      </el-radio-group>
    </div>
    <div class="actions">
      <el-button type="primary" :disabled="!graph" @click="addNodeVisible = true">新增节点</el-button>
      <el-button :disabled="!selectedIds.length || !graph" @click="groupSelected">归组</el-button>
      <el-button @click="openAgent">Agent</el-button>
      <el-button @click="openTasks">任务</el-button>
      <el-button :icon="IconRefresh" :loading="loading" aria-label="刷新画布" @click="reload" />
    </div>
    <el-alert v-if="graphError" type="error" :title="graphError" showIcon :closable="false" />
    <el-alert v-else-if="connectionError" type="warning" :title="connectionError" showIcon :closable="false" />
    <el-alert v-else-if="conflict" type="warning" :title="conflict.message" showIcon :closable="false" />
    <el-scrollbar v-loading="loading" class="nodeScroll">
      <mobileNodeList
        v-if="graph"
        :nodes="filteredNodes"
        :typeLabels="typeLabels"
        :groupByType="viewMode === 'type'"
        :selectedIds="selectedIds"
        :highlightId="highlightId"
        @toggleSelect="toggleSelect"
        @openNode="openNode" />
      <el-empty v-else-if="!loading" description="无法加载画布" />
    </el-scrollbar>
    <mobileAddNodeSheet v-model="addNodeVisible" :nodeTypes="nodeTypes" @create="createNode" />
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { IconRefresh } from "@tabler/icons-vue";
import { ElMessage } from "element-plus";
import mobileTopBar from "./components/mobileTopBar.vue";
import mobileNodeList from "./components/mobileNodeList.vue";
import mobileAddNodeSheet from "./components/mobileAddNodeSheet.vue";
import { listProjectCanvases } from "./lib/canvasList";
import { nodeLabel, type CanvasNode } from "./lib/mobileGraphModel";
import { createGroupAroundNodes, createNodePayload } from "./lib/mobileGraphOps";
import { fetchEnabledNodeTypes, type MobileNodeType } from "./lib/nodeCatalog";
import useWorkspaceExecution from "@/lib/workspaceExecution";
import { useMobileGraph } from "./lib/useMobileGraph";

const route = useRoute();
const router = useRouter();
const directory = computed(() => String(route.query.directory ?? ""));
const getExecution = useWorkspaceExecution(directory);
const projectName = computed(() => String(route.query.name ?? "项目"));
const canvasId = ref(String(route.query.canvas ?? ""));
const canvases = ref<{ id: string; name: string }[]>([]);
const canvasLoading = ref(false);
const query = ref("");
const viewMode = ref<"all" | "type">("type");
const selectedIds = ref<string[]>([]);
const highlightId = ref("");
const addNodeVisible = ref(false);
const nodeTypes = ref<MobileNodeType[]>([]);

const { graph, loading, error: graphError, connectionError, conflict, load, applyChanges } = useMobileGraph(
  () => directory.value,
  () => canvasId.value,
);

const canvasName = computed(() => canvases.value.find(c => c.id === canvasId.value)?.name ?? "");
const typeLabels = computed(() => new Map(nodeTypes.value.map(item => [item.type, item.label])));
const filteredNodes = computed(() => {
  const q = query.value.trim().toLowerCase();
  return ((graph.value?.nodes ?? []) as CanvasNode[])
    .filter(node => node.type !== "canvasGroup")
    .filter(node => !q || [nodeLabel(node), String(node.type ?? ""), typeLabels.value.get(String(node.type ?? "")) ?? ""]
      .some(value => value.toLowerCase().includes(q)))
    .sort((left, right) => nodeLabel(left).localeCompare(nodeLabel(right), "zh-CN"));
});

watch(() => route.query.highlight, value => { highlightId.value = typeof value === "string" ? value : ""; }, { immediate: true });

async function loadCanvases() {
  if (!directory.value) return;
  canvasLoading.value = true;
  try {
    canvases.value = await listProjectCanvases(directory.value);
    if (!canvasId.value && canvases.value[0]) canvasId.value = canvases.value[0].id;
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : "读取画布列表失败");
  } finally {
    canvasLoading.value = false;
  }
}

async function reload() {
  if (!directory.value || !canvasId.value) return;
  await load();
}

async function switchCanvas() {
  selectedIds.value = [];
  await router.replace({ query: { ...route.query, canvas: canvasId.value } });
  await reload();
}

function toggleSelect(nodeId: string) {
  const set = new Set(selectedIds.value);
  if (set.has(nodeId)) set.delete(nodeId);
  else set.add(nodeId);
  selectedIds.value = [...set];
}

function openNode(nodeId: string) {
  void router.push({
    path: `/mobile/node/${nodeId}`,
    query: { directory: directory.value, canvas: canvasId.value, name: projectName.value },
  });
}
function openTasks() {
  void router.push({ path: "/mobile/tasks", query: { directory: directory.value, name: projectName.value, canvas: canvasId.value } });
}
function openAgent() {
  void router.push({ path: "/mobile/agent", query: { directory: directory.value, name: projectName.value, canvas: canvasId.value, selected: JSON.stringify(selectedIds.value) } });
}

async function createNode(payload: { type: string; label: string }) {
  if (!graph.value) return;
  const definition = nodeTypes.value.find(item => item.type === payload.type);
  if (!definition) throw new Error("节点类型已不可用");
  const node = createNodePayload(payload.type, payload.label, graph.value.nodes.length);
  try {
    const added = await getExecution().execute<{ node: { id: string } }>({ canvasPath: canvasId.value, name: "addNode", args: { type: payload.type, label: payload.label, position: node.position } });
    await load();
    ElMessage.success("已添加节点");
    openNode(added.node.id);
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : "添加节点失败");
  }
}

async function groupSelected() {
  if (!graph.value || !selectedIds.value.length) return;
  try {
    await applyChanges(createGroupAroundNodes(graph.value, selectedIds.value));
    selectedIds.value = [];
    ElMessage.success("已创建分组");
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : "归组失败");
  }
}

onMounted(async () => {
  if (!directory.value) {
    await router.replace("/mobile");
    return;
  }
  try {
    nodeTypes.value = await fetchEnabledNodeTypes();
  } catch (err) {
    ElMessage.warning(err instanceof Error ? err.message : "节点类型加载失败");
  }
  await loadCanvases();
  if (canvasId.value) await reload();
});
</script>

<style lang="scss" scoped>
.mobileWorkspace {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-height: 0;
}

.toolbar {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 8px 12px;

  .canvasSelect {
    width: 100%;
  }

  .viewMode {
    :deep(.el-radio-button__inner) {
      display: flex;
      align-items: center;
      min-height: 44px;
    }
  }
}

.actions {
  display: flex;
  gap: 8px;
  padding: 0 12px 8px;
  flex-wrap: wrap;
}

.nodeScroll {
  flex: 1;
  padding: 0 8px 16px;
}
</style>
