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
      <mobileExecutePanel
        :key="nodeBinding"
        :directory="directory"
        :canvasPath="canvasPath"
        :node="node"
        :graph="graph"
        :editorBlocked="!nodeEditor || nodeEditor.hasUnsavedChanges || !!conflict || referenceSaving"
        :editorPending="nodeEditor?.hasPendingChanges || referenceSaving"
        :modelReady="nodeEditor?.hasGenerationModel"
        :refreshNode="refreshNodeEditor"
        @catalog="catalog = $event"
        @changed="load" />
      <mobileNodeEditor :key="nodeBinding" ref="nodeEditor" :directory="directory" :canvasPath="canvasPath" :node="node" :graph="graph" :catalog="catalog" @changed="load" />
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
              <strong v-if="referenceIndex(link) >= 0">参考 {{ referenceIndex(link) + 1 }}</strong>
              <img v-if="referenceMedia[link.edgeId]?.type === 'IMAGE' && previewUrls['reference:' + link.edgeId]" class="referencePreview" :src="previewUrls['reference:' + link.edgeId]" alt="引用图片" />
              <video v-else-if="referenceMedia[link.edgeId]?.type === 'VIDEO' && previewUrls['reference:' + link.edgeId]" class="referencePreview" :src="previewUrls['reference:' + link.edgeId]" muted playsinline preload="metadata" aria-label="引用视频" />
              <span>{{ link.peerLabel }}</span>
              <span v-if="referenceValue(link)?.dataType === 'STRING'" class="referenceText">{{ typeof referenceValue(link)?.value === "string" ? String(referenceValue(link)?.value).slice(0, 200) || "正文为空" : "点此查看源节点正文" }}</span>
              <span class="handles">{{ link.sourceHandle }} → {{ link.targetHandle }}</span>
            </button>
            <div v-if="referenceIndex(link) >= 0 && inputReferences.length > 1" class="referenceActions">
              <el-button :disabled="referenceSaving || referenceIndex(link) === 0" :aria-label="'上移引用 ' + (referenceIndex(link) + 1)" @click="moveReference(link, -1)">上移</el-button>
              <el-button :disabled="referenceSaving || referenceIndex(link) === inputReferences.length - 1" :aria-label="'下移引用 ' + (referenceIndex(link) + 1)" @click="moveReference(link, 1)">下移</el-button>
            </div>
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
          <div class="resultActions">
            <el-button :disabled="!previewUrls[asset.slot]" @click="downloadOutput(asset)">下载</el-button>
            <el-button v-if="asset.type !== 'AUDIO'" :disabled="!previewUrls[asset.slot]" @click="previewSlot = asset.slot">全屏</el-button>
            <el-button @click="saveOutputToLibrary(asset)">添加到素材库</el-button>
          </div>
        </div>
      </el-card>
      <assetLibrary :key="nodeBinding" ref="assetLibraryRef" :directory="directory" />
    </el-main>
    <el-empty v-else-if="!loading" description="节点不存在" />
    <mobileConnectionSheet
      v-if="graph && node"
      v-model="connectionVisible"
      :sourceId="node.id"
      :nodes="graph.nodes as CanvasNode[]"
      @connect="addConnection" />
    <el-image-viewer v-if="previewAsset?.type === 'IMAGE' && previewUrls[previewAsset.slot]" :urlList="[previewUrls[previewAsset.slot]]" teleported @close="previewSlot = ''" />
    <el-dialog :modelValue="previewAsset?.type === 'VIDEO'" title="视频预览" width="min(800px, calc(100vw - 32px))" alignCenter appendToBody destroyOnClose @update:modelValue="previewSlot = ''">
      <video v-if="previewAsset?.type === 'VIDEO'" class="fullscreenVideo" :src="previewUrls[previewAsset.slot]" controls playsinline />
    </el-dialog>
  </section>
</template>

<script setup lang="ts">
import { computed, provide, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { ElMessage } from "element-plus";
import type { Connection } from "@vue-flow/core";
import mobileTopBar from "./components/mobileTopBar.vue";
import mobileConnectionSheet from "./components/mobileConnectionSheet.vue";
import mobileExecutePanel from "./components/mobileExecutePanel.vue";
import mobileNodeEditor from "./components/mobileNodeEditor.vue";
import assetLibrary from "../panels/canvas/components/assetLibrary.vue";
import saveFile from "@/lib/saveFile";
import { isNodeOutput, type NodeOutput } from "@toonflow/nodes-scaffold/values";
import { getTargetValues } from "@toonflow/nodes-scaffold/inputValues";
import type { NodeCatalogEntry } from "@toonflow/nodes-scaffold/runtime";
import {
  listGroups,
  nodeLabel,
  nodeReferences,
  type CanvasNode,
  type NodeRefLink,
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
const nodeBinding = computed(() => JSON.stringify([directory.value, canvasPath.value, node.value?.id, node.value?.type]));
provide("workspaceFiles", () => useWorkspaceFiles(directory.value));
const groups = computed(() => (graph.value ? listGroups(graph.value.nodes as CanvasNode[]) : []));
const inputReferences = computed(() => graph.value && node.value ? getTargetValues(node.value.id, "in", graph.value.nodes, graph.value.edges) : []);
function referenceIndex(link: NodeRefLink) { return link.direction === "in" && link.targetHandle === "in" ? inputReferences.value.findIndex(item => item.source === link.peerId && item.sourceHandle === link.sourceHandle) : -1; }
function referenceValue(link: NodeRefLink) { return inputReferences.value[referenceIndex(link)]; }
const refs = computed(() => (graph.value && nodeId.value ? nodeReferences(nodeId.value, graph.value).sort((left, right) => (referenceIndex(left) < 0 ? Infinity : referenceIndex(left)) - (referenceIndex(right) < 0 ? Infinity : referenceIndex(right))) : []));
const referenceSaving = ref(false);
async function moveReference(link: NodeRefLink, offset: number) {
  if (!graph.value || !node.value || referenceSaving.value) return;
  const from = referenceIndex(link), to = from + offset, ordered = [...inputReferences.value];
  if (from < 0 || to < 0 || to >= ordered.length) return;
  ordered.splice(to, 0, ordered.splice(from, 1)[0]!);
  const next = { ...node.value, data: { ...node.value.data, referenceOrder: { ...node.value.data.referenceOrder, in: ordered.map(item => encodeURIComponent(JSON.stringify([item.source, item.sourceHandle]))) } } };
  referenceSaving.value = true;
  try { await applyChanges([changeForNode(graph.value, next, next.id)]); }
  catch (reason) { ElMessage.error(reason instanceof Error ? reason.message : "引用顺序保存失败"); }
  finally { referenceSaving.value = false; }
}

const labelDraft = ref("");
const parentGroupId = ref("");
const connectionVisible = ref(false);
const catalog = ref<NodeCatalogEntry[]>([]);
const nodeEditor = ref<InstanceType<typeof mobileNodeEditor>>();
const assetLibraryRef = ref<InstanceType<typeof assetLibrary>>();
const previewSlot = ref("");
async function refreshNodeEditor(signal?: AbortSignal, contentOnly = false) {
  signal?.throwIfAborted();
  const synchronized = await nodeEditor.value?.refresh(signal, contentOnly);
  signal?.throwIfAborted();
  return synchronized;
}

const title = computed(() => node.value ? nodeLabel(node.value) : "节点");
const typeLabel = computed(() => catalog.value.find(entry => `remote-${entry.name}` === node.value?.type)?.displayName ?? String(node.value?.type ?? ""));
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
function mediaOutput(slot: string, output: unknown) {
  if (!isNodeOutput(output) || !["IMAGE", "VIDEO", "AUDIO"].includes(output.dataType) || typeof output.value !== "object") return;
  return { slot, type: output.dataType, path: output.value.url, mimeType: output.value.mimeType, output };
}
const mediaOutputs = computed(() => Object.entries(node.value?.data?.outputs ?? {}).flatMap(([slot, output]) => {
  const media = mediaOutput(slot, output);
  return media ? [media] : [];
}));
const referenceMedia = computed(() => Object.fromEntries(refs.value.filter(link => link.direction === "in").flatMap(link => {
  const peer = graph.value?.nodes.find(item => item.id === link.peerId);
  const media = mediaOutput("reference:" + link.edgeId, peer?.data?.outputs?.[link.sourceHandle ?? ""]);
  return media ? [[link.edgeId, media]] : [];
})));
const previewAsset = computed(() => mediaOutputs.value.find(asset => asset.slot === previewSlot.value));
const previewAssets = computed(() => [...mediaOutputs.value, ...Object.values(referenceMedia.value)]);
const previewUrls = ref<Record<string, string>>({});
watch([previewAssets, directory], async ([outputs, currentDirectory], _, onCleanup) => {
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

async function downloadOutput(asset: { path: string; mimeType: string }) {
  const files = useWorkspaceFiles(directory.value);
  try {
    await saveFile(async () => new Blob([await files.read(asset.path)], { type: asset.mimeType }), asset.path.split(/[\\/]/).at(-1) || "result");
  } catch (reason) { ElMessage.error(reason instanceof Error ? reason.message : "下载失败"); }
}
async function saveOutputToLibrary(asset: { slot: string; output: NodeOutput }) {
  try { await assetLibraryRef.value?.openSave(title.value, [{ label: asset.slot, output: JSON.parse(JSON.stringify(asset.output)) }]); }
  catch (reason) { ElMessage.error(reason instanceof Error ? reason.message : "素材库保存失败"); }
}
watch(nodeBinding, () => { previewSlot.value = ""; });

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
    flex-wrap: wrap;
    align-items: center;
    gap: 4px;
    .referenceActions { display: flex; gap: 4px; .el-button { min-height: 44px; margin: 0; } }
  }
}

.refButton {
  flex: 1;
  min-width: 0;
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
  .referencePreview { width: 64px; height: 64px; object-fit: contain; }
  .referenceText { display: block; width: 100%; overflow-wrap: anywhere; }
}

.outputText {
  white-space: pre-wrap;
  font-size: 13px;
  margin: 0;
}
.mediaPreview {
  margin-bottom: 12px;
  img, video { display: block; max-width: 100%; max-height: 70dvh; }
  audio { max-width: 100%; }
  .resultActions {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    margin-top: 8px;
    .el-button { margin: 0; min-height: 44px; }
  }
}
.fullscreenVideo { display: block; width: 100%; max-height: min(70dvh, max(80px, calc(var(--mobileViewportHeight, 100dvh) - env(safe-area-inset-top) - env(safe-area-inset-bottom) - 120px))); }
</style>
