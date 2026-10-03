<template>
  <section class="mobileNodeDetail" v-loading="loading">
    <mobileTopBar :title="title" :subtitle="typeLabel" :backTo="workspaceLink" />
    <el-alert v-if="graphError || connectionError" :title="graphError || connectionError" type="warning" :closable="false" showIcon />
    <el-main v-if="node && graph" class="content">
      <el-alert v-if="conflict" :title="conflict.message" type="warning" :closable="false" showIcon />
      <details v-if="conflict?.changes" class="draftPreview"><summary>查看保留的修改草稿</summary><pre>{{ JSON.stringify(conflict.changes, null, 2) }}</pre></details>
      <el-form labelPosition="top">
        <el-form-item label="名称">
          <el-input v-model="labelDraft" @blur="saveLabel" />
        </el-form-item>
        <el-form-item label="所属分组">
          <el-select v-model="parentGroupId" clearable placeholder="未分组" style="width: 100%" @change="saveParent">
            <el-option label="未分组" value="" />
            <el-option v-for="group in groups" :key="group.id" :label="group.label" :value="group.id" />
          </el-select>
        </el-form-item>
      </el-form>
      <mobileNodeEditor ref="nodeEditor" :directory="directory" :canvasPath="canvasPath" :node="node" :graph="graph" :catalog="catalog" @changed="load" />
      <el-card shadow="never" class="section">
        <template #header>
          <div class="sectionHeader">
            <span>连接</span>
            <el-button size="small" type="primary" @click="connectionVisible = true">添加</el-button>
          </div>
        </template>
        <ul class="refList">
          <li v-for="link in refs" :key="link.edgeId">
            <button class="refButton" type="button" @click="jumpToPeer(link.peerId)">
              <el-tag size="small" :type="link.direction === 'in' ? 'info' : 'success'">{{ link.direction === 'in' ? '入' : '出' }}</el-tag>
              <span>{{ link.peerLabel }}</span>
              <span class="handles">{{ link.sourceHandle }} → {{ link.targetHandle }}</span>
            </button>
            <el-button text type="danger" aria-label="删除连接" @click="removeConnection(link.edgeId)">删除</el-button>
          </li>
        </ul>
        <el-empty v-if="!refs.length" description="暂无连接" :imageSize="64" />
      </el-card>
      <el-card v-if="outputPreview" shadow="never" class="section">
        <template #header>输出预览</template>
        <p class="outputText">{{ outputPreview }}</p>
      </el-card>
      <el-card v-if="mediaOutputs.length" shadow="never" class="section">
        <template #header>媒体结果</template>
        <div v-for="asset in mediaOutputs" :key="asset.slot" class="mediaPreview">
          <img v-if="asset.type === 'IMAGE' && previewUrls[asset.slot]" :src="previewUrls[asset.slot]" :alt="title + ' ' + asset.slot" />
          <video v-else-if="asset.type === 'VIDEO' && previewUrls[asset.slot]" :src="previewUrls[asset.slot]" controls playsinline />
          <audio v-else-if="asset.type === 'AUDIO' && previewUrls[asset.slot]" :src="previewUrls[asset.slot]" controls />
        </div>
      </el-card>
      <mobileExecutePanel
        :directory="directory"
        :canvasPath="canvasPath"
        :node="node"
        :graph="graph"
        :refreshNode="refreshNodeEditor"
        @catalog="catalog = $event"
        @changed="load" />
    </el-main>
    <el-empty v-else-if="!loading" description="节点不存在" />
    <mobileConnectionSheet
      v-if="graph && node"
      v-model="connectionVisible"
      :sourceId="node.id"
      :nodes="graph.nodes as CanvasNode[]"
      @connect="addConnection" />
  </section>
</template>

<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { ElMessage } from "element-plus";
import type { Connection } from "@vue-flow/core";
import mobileTopBar from "./components/mobileTopBar.vue";
import mobileConnectionSheet from "./components/mobileConnectionSheet.vue";
import mobileExecutePanel from "./components/mobileExecutePanel.vue";
import mobileNodeEditor from "./components/mobileNodeEditor.vue";
import type { NodeCatalogEntry } from "@toonflow/nodes-scaffold/runtime";
import {
  listGroups,
  nodeLabel,
  nodeReferences,
  type CanvasNode,
} from "./lib/mobileGraphModel";
import {
  changeForNode,
  createConnection,
  removeEdgeChange,
  setNodeParent,
  updateNodeLabel,
} from "./lib/mobileGraphOps";
import { useMobileGraph } from "./lib/useMobileGraph";
import useWorkspaceFiles from "@/lib/workspaceFiles";

const route = useRoute();
const router = useRouter();
const nodeId = computed(() => String(route.params.nodeId ?? ""));
const directory = computed(() => String(route.query.directory ?? ""));
const canvasPath = computed(() => String(route.query.canvas ?? ""));
const projectName = computed(() => String(route.query.name ?? "项目"));

const { graph, loading, error: graphError, connectionError, conflict, load, applyChanges } = useMobileGraph(
  () => directory.value,
  () => canvasPath.value,
);

const node = computed(() => (graph.value?.nodes as CanvasNode[] | undefined)?.find(n => n.id === nodeId.value));
const groups = computed(() => (graph.value ? listGroups(graph.value.nodes as CanvasNode[]) : []));
const refs = computed(() => (graph.value && nodeId.value ? nodeReferences(nodeId.value, graph.value) : []));

const labelDraft = ref("");
const parentGroupId = ref("");
const connectionVisible = ref(false);
const catalog = ref<NodeCatalogEntry[]>([]);
const nodeEditor = ref<InstanceType<typeof mobileNodeEditor>>();
async function refreshNodeEditor(signal?: AbortSignal, contentOnly = false) {
  signal?.throwIfAborted();
  const synchronized = await nodeEditor.value?.refresh(signal, contentOnly);
  signal?.throwIfAborted();
  return synchronized;
}

const title = computed(() => node.value ? nodeLabel(node.value) : "节点");
const typeLabel = computed(() => String(node.value?.type ?? ""));
const workspaceLink = computed(() => ({
  path: "/mobile/workspace",
  query: { directory: directory.value, canvas: canvasPath.value, name: projectName.value, highlight: nodeId.value },
}));

const outputPreview = computed(() => {
  const outputs = node.value?.data?.outputs;
  if (!outputs || typeof outputs !== "object") return "";
  const parts: string[] = [];
  for (const [slot, value] of Object.entries(outputs)) {
    if (value && typeof value === "object" && "value" in value) {
      const v = (value as { value?: unknown }).value;
      if (typeof v === "string" && v.trim()) parts.push(`${slot}: ${v.slice(0, 200)}`);
    }
  }
  return parts.join("\n");
});
const mediaOutputs = computed(() => Object.entries(node.value?.data?.outputs ?? {}).flatMap(([slot, output]) => {
  if (!output || typeof output !== "object") return [];
  const value = output as { dataType?: string; value?: { url?: string; mimeType?: string } };
  if (!["IMAGE", "VIDEO", "AUDIO"].includes(value.dataType ?? "") || typeof value.value?.url !== "string") return [];
  return [{ slot, type: value.dataType, path: value.value.url, mimeType: value.value.mimeType }];
}));
const previewUrls = ref<Record<string, string>>({});
watch([mediaOutputs, directory], async ([outputs, currentDirectory], _, onCleanup) => {
  let stale = false;
  const releases: (() => void)[] = [];
  onCleanup(() => { stale = true; releases.forEach(release => release()); });
  previewUrls.value = {};
  if (!currentDirectory) return;
  const files = useWorkspaceFiles(currentDirectory);
  await Promise.all(outputs.map(async asset => {
    const handle = files.acquireUrl(asset.path, asset.mimeType);
    releases.push(handle.release);
    try {
      const url = await handle.url;
      if (!stale) previewUrls.value = { ...previewUrls.value, [asset.slot]: url };
    } catch { /* 保留其他已载入的输出 */ }
  }));
}, { immediate: true });

let previousNodeId = "";
let previousLabel = "";
let previousParent = "";
watch(node, current => {
  if (!current) return;
  if (current.id !== previousNodeId || labelDraft.value === previousLabel) labelDraft.value = nodeLabel(current);
  if (current.id !== previousNodeId || parentGroupId.value === previousParent) parentGroupId.value = current.parentNode ?? "";
  previousNodeId = current.id;
  previousLabel = nodeLabel(current);
  previousParent = current.parentNode ?? "";
}, { immediate: true });

async function saveLabel() {
  if (!graph.value || !node.value) return;
  const next = updateNodeLabel(node.value, labelDraft.value.trim() || nodeLabel(node.value));
  if (next.data?.label === node.value.data?.label) return;
  try {
    await applyChanges([changeForNode(graph.value, next, node.value.id)]);
    ElMessage.success("已保存名称");
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : "保存失败");
  }
}

async function saveParent() {
  if (!graph.value || !node.value) return;
  const target = parentGroupId.value || null;
  if ((node.value.parentNode ?? null) === target) return;
  try {
    await applyChanges(setNodeParent(graph.value, node.value.id, target));
    ElMessage.success("已更新分组");
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : "更新分组失败");
  }
}

async function addConnection(connection: Connection) {
  if (!graph.value) return;
  try {
    await applyChanges([createConnection(graph.value, connection)]);
    ElMessage.success("已添加连接");
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : "连接失败");
  }
}

async function removeConnection(edgeId: string) {
  if (!graph.value) return;
  try {
    await applyChanges([removeEdgeChange(graph.value, edgeId)]);
    ElMessage.success("已删除连接");
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : "删除失败");
  }
}

function jumpToPeer(peerId: string) {
  void router.push({
    path: `/mobile/node/${peerId}`,
    query: { directory: directory.value, canvas: canvasPath.value, name: projectName.value },
  });
}

watch([directory, canvasPath], async () => {
  if (!directory.value || !canvasPath.value) {
    await router.replace("/mobile");
    return;
  }
}, { immediate: true });
</script>

<style lang="scss" scoped>
.mobileNodeDetail {
  flex: 1;
  display: flex;
  flex-direction: column;
  .draftPreview pre { white-space: pre-wrap; overflow-wrap: anywhere; }
}

.content {
  padding: 12px 16px 24px;
}

.section {
  margin-top: 12px;
}

.sectionHeader {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.refList {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;

  li {
    display: flex;
    align-items: center;
    gap: 4px;
  }
}

.refButton {
  flex: 1;
  min-height: 44px;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  border: 1px solid var(--el-border-color-lighter);
  border-radius: var(--el-border-radius-base);
  background: var(--el-fill-color-blank);
  cursor: pointer;
  text-align: left;

  .handles {
    font-size: 11px;
    color: var(--el-text-color-placeholder);
  }
}

.outputText {
  white-space: pre-wrap;
  font-size: 13px;
  margin: 0;
}
.mediaPreview {
  img, video { display: block; max-width: 100%; max-height: 70dvh; }
  audio { max-width: 100%; }
}
</style>
