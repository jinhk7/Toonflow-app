<template>
  <section class="mobileNodeDetail" v-loading="loading">
    <mobileTopBar :title="title" :subtitle="typeLabel" :backTo="workspaceLink" />
    <el-main v-if="node && graph" class="content">
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
      <el-card v-if="isMediaNode" shadow="never" class="section">
        <template #header>生成设置</template>
        <el-form labelPosition="top">
          <el-form-item label="模型">
            <el-select v-model="modelDraft" filterable placeholder="选择已安装模型" style="width: 100%">
              <el-option v-for="model in mediaModels" :key="`${model.providerId}:${model.modelId}`" :label="`${model.providerLabel} / ${model.label}`" :value="JSON.stringify([model.providerId, model.modelId])" />
            </el-select>
          </el-form-item>
          <el-form-item label="提示词">
            <el-input v-model="promptDraft" type="textarea" :autosize="{ minRows: 3, maxRows: 10 }" :maxlength="8000" />
          </el-form-item>
          <el-button type="primary" @click="saveMediaSettings">保存生成设置</el-button>
        </el-form>
      </el-card>
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
        <el-empty v-if="!refs.length" description="暂无连接" :image-size="64" />
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
        :persistNode="changes => applyChanges(changes)" />
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
import { computed, onMounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { ElMessage, ElMessageBox } from "element-plus";
import axios from "axios";
import type { Connection } from "@vue-flow/core";
import mobileTopBar from "./components/mobileTopBar.vue";
import mobileConnectionSheet from "./components/mobileConnectionSheet.vue";
import mobileExecutePanel from "./components/mobileExecutePanel.vue";
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

const { graph, loading, load, applyChanges } = useMobileGraph(
  () => directory.value,
  () => canvasPath.value,
);

const node = computed(() => (graph.value?.nodes as CanvasNode[] | undefined)?.find(n => n.id === nodeId.value));
const groups = computed(() => (graph.value ? listGroups(graph.value.nodes as CanvasNode[]) : []));
const refs = computed(() => (graph.value && nodeId.value ? nodeReferences(nodeId.value, graph.value) : []));

const modelDraft = ref("");
const promptDraft = ref("");
const mediaModels = ref<{ providerId: string; providerLabel: string; modelId: string; label: string; type: string }[]>([]);
const isMediaNode = computed(() => node.value?.type === "remote-imageGenerationNode" || node.value?.type === "remote-videoGenerationNode");
const labelDraft = ref("");
const parentGroupId = ref("");
const connectionVisible = ref(false);

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

watch(node, current => {
  if (!current) return;
  labelDraft.value = nodeLabel(current);
  parentGroupId.value = current.parentNode ?? "";
  modelDraft.value = typeof current.data?.model === "string" ? current.data.model : "";
  promptDraft.value = typeof current.data?.prompt === "string" ? current.data.prompt : "";
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

async function saveMediaSettings() {
  if (!graph.value || !node.value || !isMediaNode.value) return;
  if (node.value.data?.model === modelDraft.value && node.value.data?.prompt === promptDraft.value) return;
  if (node.value.data?.pendingMediaJob) {
    try { await ElMessageBox.confirm("编辑生成输入会使未完成任务的自动结果关联失效；仍要保存吗？", "确认修改", { confirmButtonText: "保存", cancelButtonText: "取消" }); }
    catch { return; }
  }
  try {
    await applyChanges([changeForNode(graph.value, { ...node.value, data: { ...node.value.data, model: modelDraft.value, prompt: promptDraft.value } }, node.value.id)]);
    ElMessage.success("已保存生成设置");
  } catch (error) { ElMessage.error(error instanceof Error ? error.message : "保存失败"); }
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

onMounted(async () => {
  if (!directory.value || !canvasPath.value) {
    await router.replace("/mobile");
    return;
  }
  await load();
  try {
    const { data } = await axios.get<{ code: number; data: typeof mediaModels.value }>("/api/ai/media/models", { headers: { "x-toonflow-workspace": "1" } });
    if (data.code === 200) mediaModels.value = data.data.filter(model => model.type === (node.value?.type === "remote-videoGenerationNode" ? "video" : "image"));
  } catch { /* 已有节点仍可查看；无可用模型时不提交新任务 */ }
});
</script>

<style lang="scss" scoped>
.mobileNodeDetail {
  flex: 1;
  display: flex;
  flex-direction: column;
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
