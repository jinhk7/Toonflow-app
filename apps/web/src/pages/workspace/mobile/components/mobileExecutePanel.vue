<template>
  <el-card v-if="!node || mediaType || generationName || pluginActions.length || pendingCommand || legacyDrafts.length || error" class="mobileExecutePanel" shadow="never">
    <template #header>{{ node ? generationName ? generationLabel : mediaType ? mediaLabel + "素材" : "节点操作" : "后台任务" }}</template>
    <el-alert v-if="error || generationError || (!node || generationName && mediaType) && mediaError" :title="error || generationError || mediaError" type="error" :closable="false" showIcon />
    <el-alert v-if="connectionError" :title="connectionError" type="warning" :closable="false" showIcon />
    <template v-if="node">
      <template v-if="pluginActions.length">
        <el-alert v-if="pluginReadError" :title="pluginReadError" type="error" :closable="false" showIcon />
        <el-select v-model="pluginActionName" :disabled="submitting || !!pendingCommand || pluginWriteFailed" class="actionSelect" aria-label="节点操作">
          <el-option v-for="item in pluginActions" :key="item.name" :label="item.description || item.name" :value="item.name" />
        </el-select>
        <el-form v-if="pluginAction" :disabled="!!pluginReadError || submitting || !!pendingCommand" labelPosition="top" class="parameterForm" novalidate @submit.prevent="executePluginAction">
          <el-form-item v-for="field in pluginFields" :key="field.name" :label="field.schema.title || field.name" :required="field.required">
            <el-select v-if="field.schema.enum" v-model="pluginValues[field.name]" clearable><el-option v-for="(value, index) in field.schema.enum" :key="index" :label="String(value)" :value="value" /></el-select>
            <el-input v-else-if="isJsonField(field.schema)" v-model="pluginJsonValues[field.name]" type="textarea" :autosize="{ minRows: 2, maxRows: 12 }" />
            <el-switch v-else-if="field.schema.type === 'boolean'" v-model="pluginValues[field.name]" />
            <el-input-number v-else-if="field.schema.type === 'number' || field.schema.type === 'integer'" v-model="pluginValues[field.name]" :min="field.schema.minimum" :max="field.schema.maximum" :precision="field.schema.type === 'integer' ? 0 : undefined" />
            <el-input v-else v-model="pluginValues[field.name]" :maxlength="field.schema.maxLength" :type="field.schema.maxLength && field.schema.maxLength > 200 ? 'textarea' : 'text'" />
            <p v-if="field.schema.description" class="fieldDescription">{{ field.schema.description }}</p>
          </el-form-item>
          <el-input v-if="!pluginHasProperties" v-model="pluginRawArgs" type="textarea" :autosize="{ minRows: 3, maxRows: 12 }" aria-label="操作 JSON 参数" />
          <div class="actions"><el-button type="primary" nativeType="submit" :loading="submitting" :disabled="loading || !canvasPath || !!pendingCommand || !!pluginReadError || editorBlocked">执行</el-button></div>
        </el-form>
        <div class="actions"><el-button :disabled="!!pluginReadError && !pluginWriteFailed && pluginOriginalDraft === undefined" @click="downloadPluginDraft">下载操作草稿</el-button><el-button v-if="pluginWriteFailed" @click="savePluginDraft">重试保存草稿</el-button></div>
        <details v-if="result"><summary>操作结果</summary><pre>{{ result }}</pre></details>
        <ul class="jobList"><li v-for="job in jobs" :key="job.jobId"><strong>{{ statusLabel(job.status) }}</strong><p v-if="job.errorMessage">{{ job.errorMessage }}</p><div class="actions"><el-button v-if="job.result !== undefined" @click="downloadResult(job)">下载任务结果</el-button><el-button v-if="job.canResume" @click="resumeJob(job)">继续原任务</el-button><el-button v-if="job.status === 'accepted' || job.status === 'running'" @click="cancelJob(job)">{{ job.kind === 'media' ? '停止观察' : '取消任务' }}</el-button></div></li></ul>
      </template>
      <div v-if="legacyDrafts.length" class="legacyDrafts">
        <p role="status">上次未执行的操作草稿已保留。请先核对，再使用当前已保存的节点内容。</p>
        <details><summary>查看保留的操作草稿</summary><div v-for="draft in legacyDrafts" :key="draft.kind"><strong>{{ legacyLabel(draft.kind) }}</strong><pre>{{ JSON.stringify(draft.value, null, 2) }}</pre></div></details>
        <div class="actions"><el-button @click="downloadLegacyDrafts">下载保留草稿</el-button><el-button v-if="!legacyAcknowledged" @click="legacyAcknowledged = true">使用已保存的节点内容</el-button></div>
      </div>
      <div v-if="generationName" class="nodeActions">
        <p v-if="generationState" class="generationStatus" role="status">{{ statusLabel(generationState.status) }}<span v-if="generationState.error"> · {{ generationState.error }}</span></p>
        <el-progress v-if="currentJob?.progress !== undefined" :percentage="Math.max(0, Math.min(100, currentJob.progress <= 1 ? currentJob.progress * 100 : currentJob.progress))" />
        <el-button type="primary" class="generateButton" :loading="submitting && !pendingCommand" :disabled="generationBlocked" @click="executeNodeAction(generationName)">{{ generationLabel }}</el-button>
        <p v-if="editorBlocked && !loading" class="saveHint" role="status">请先保存节点修改，再生成或替换结果</p>
        <p v-else-if="!hasPrompt && !loading" class="saveHint" role="status">{{ mediaType ? "请填写并保存提示词，或连接有内容的文本引用" : "请填写并保存提示词" }}</p>
        <p v-else-if="!modelReady && !loading" class="saveHint" role="status">请选择并保存可用模型</p>
        <div class="actions">
          <el-button v-if="generationState?.canCancelObservation || !mediaType && running" :disabled="submitting || !!pendingCommand || editorPending" @click="executeNodeAction('cancelGeneration')">{{ mediaType ? "取消本地等待" : "停止生成" }}</el-button>
          <el-button v-if="generationState?.mediaJob?.status === 'collectionFailed'" :disabled="submitting || !!pendingCommand || editorPending" @click="executeNodeAction('retryCollection')">重试保存原结果</el-button>
          <el-button v-if="generationState?.mediaJob?.status === 'unknown' || node.data.pendingMediaJob && generationState && !generationState.mediaJob || !mediaType && generationState?.status === 'needsReview'" :disabled="submitting || !!pendingCommand || editorPending" @click="executeNodeAction('abandonUnknownGeneration', { confirmed: true })">核对并放弃原任务</el-button>
          <el-button v-if="currentJob?.canResume" :disabled="submitting || !!pendingCommand || editorPending" @click="resumeJob(currentJob)">继续原任务</el-button>
          <el-button :loading="loading" :disabled="submitting || uploading" @click="load()">核对生成状态</el-button>
        </div>
      </div>
      <div v-if="mediaType" class="actions">
        <el-button :loading="uploading" :disabled="resultBlocked" @click="fileInput?.click()">{{ currentOutput ? "替换" : "上传" }}{{ mediaLabel }}</el-button>
        <input ref="fileInput" type="file" :accept="mediaType + '/*'" hidden :disabled="resultBlocked" :aria-label="'选择' + mediaLabel" @change="uploadOutput" />
        <mediaHistory v-if="generationName && (mediaType === 'image' || mediaType === 'video')" :key="node.id" :nodeId="node.id" :mediaType="mediaType" label="历史记录" :current="currentOutput" :disabled="resultBlocked" @select="selectOutput" />
        <el-button v-if="!generationName" :loading="loading" :disabled="submitting || uploading" @click="load()">刷新节点状态</el-button>
      </div>
      <div v-if="pendingCommand" class="actions"><el-button :loading="submitting" @click="reconcileCommand()">核对上次操作</el-button></div>
    </template>
    <template v-else>
      <div class="actions"><el-button :loading="loading" @click="load()">刷新任务</el-button></div>
      <ul class="jobList">
        <li v-for="job in jobs" :key="job.jobId">
          <strong>{{ job.kind }} · {{ job.jobId }}</strong>
          <p>{{ job.status }}<span v-if="job.errorMessage"> · {{ job.errorMessage }}</span></p>
          <el-progress v-if="job.progress !== undefined" :percentage="Math.max(0, Math.min(100, job.progress <= 1 ? job.progress * 100 : job.progress))" />
          <div class="actions">
            <el-button v-if="job.nodeId && job.canvasPath" text @click="openJobNode(job)">查看节点</el-button>
            <el-button v-if="job.result !== undefined" text @click="downloadResult(job)">下载任务结果</el-button>
            <el-button v-if="job.canResume" text @click="resumeJob(job)">恢复原任务</el-button>
            <el-button v-if="job.status === 'accepted' || job.status === 'running'" text type="danger" @click="cancelJob(job)">{{ job.kind === "media" ? "停止观察" : "取消任务" }}</el-button>
          </div>
        </li>
      </ul>
      <ul class="jobList">
        <li v-for="job in mediaJobs" :key="job.jobId">
          <strong>{{ job.mediaType || "媒体" }} · {{ job.jobId }}</strong>
          <p>{{ job.status }}<span v-if="job.linkStatus"> · {{ job.linkStatus }}</span><span v-if="job.errorMessage"> · {{ job.errorMessage }}</span></p>
        </li>
      </ul>
    </template>
  </el-card>
</template>

<script setup lang="ts">
import { computed, nextTick, onUnmounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { ElMessage, ElMessageBox } from "element-plus";
import axios from "axios";
import { isPlainObject } from "lodash-es";
import { createExecutionClient, ExecutionRequestError, fetchNodeCatalog, getExecutionClientId, isExecutableNode, type NodeCatalogEntry } from "@toonflow/nodes-scaffold/runtime";
import type { CanvasCommand, CanvasCommandResult, NodeJobView } from "@toonflow/nodes-scaffold/execution";
import useWorkspaceFiles, { graphValueJson, type WorkspaceGraph } from "@/lib/workspaceFiles";
import { readWorkspaceDraft, readWorkspaceDrafts, removeWorkspaceDraft, saveWorkspaceDraft } from "@/lib/workspaceDrafts";
import { useWorkspaceEvents } from "@/lib/workspaceEvents";
import saveFile from "@/lib/saveFile";
import mediaHistory from "@toonflow/nodes-scaffold/mediaHistory";
import type { NodeMediaValue, NodeOutputs } from "@toonflow/nodes-scaffold/values";
import type { NodeMediaJobView } from "@toonflow/nodes-scaffold/runtime";
import { getTargetSources } from "@toonflow/nodes-scaffold/inputValues";
import type { CanvasNode } from "../lib/mobileGraphModel";

type GenerationState = { status: string; controlsBlocked?: boolean; canCancelObservation?: boolean; mediaJob?: NodeMediaJobView; error?: string; outputs?: NodeOutputs };
type ParameterSchema = { type?: string | string[]; title?: string; description?: string; default?: unknown; enum?: any[]; minimum?: number; maximum?: number; maxLength?: number; $ref?: string; oneOf?: unknown; anyOf?: unknown; allOf?: unknown };
function isJsonField(schema: ParameterSchema) { return !schema.enum && (Array.isArray(schema.type) || schema.type === "object" || schema.type === "array" || schema.type === "null" || !!schema.$ref || !!schema.oneOf || !!schema.anyOf || !!schema.allOf); }
type MediaJob = { jobId: string; mediaType?: string; status: string; linkStatus?: string; nodeId?: string; canvasPath?: string; errorMessage?: string };
const props = defineProps<{ directory: string; canvasPath?: string; node?: CanvasNode; graph?: WorkspaceGraph; refreshNode?: (signal?: AbortSignal, contentOnly?: boolean) => Promise<boolean | void>; editorBlocked?: boolean; editorPending?: boolean; modelReady?: boolean }>();
const emit = defineEmits<{ changed: []; catalog: [entries: NodeCatalogEntry[]] }>();
const route = useRoute();
const router = useRouter();
const catalog = ref<NodeCatalogEntry[]>([]);
const descriptor = computed(() => {
  const entry = catalog.value.find(item => `remote-${item.name}` === props.node?.type);
  return entry && isExecutableNode(entry) ? entry : undefined;
});
const generationName = computed(() => ({
  "remote-imageGenerationNode": "generateImage", "remote-videoGenerationNode": "generateVideo", "remote-textNode": "generateText",
} as Record<string, string>)[props.node?.type ?? ""]);
const mediaType = computed(() => ({
  "remote-imageGenerationNode": "image", "remote-imageNode": "image", "remote-videoGenerationNode": "video", "remote-videoNode": "video", "remote-audioNode": "audio",
} as Record<string, "image" | "video" | "audio">)[props.node?.type ?? ""]);
const mediaLabel = computed(() => ({ image: "图片", video: "视频", audio: "音频" }[mediaType.value ?? "image"]));
const generationLabel = computed(() => generationName.value === "generateText" ? "生成文本" : "生成" + mediaLabel.value);
const pluginActions = computed(() => !generationName.value && !mediaType.value ? descriptor.value?.actions.filter(action => !action.editor) ?? [] : []);
const pluginActionName = ref("");
watch(pluginActions, actions => { if (!actions.some(action => action.name === pluginActionName.value)) pluginActionName.value = actions[0]?.name ?? ""; });
const pluginAction = computed(() => pluginActions.value.find(action => action.name === pluginActionName.value));
const pluginHasProperties = computed(() => pluginAction.value?.parameters.type === "object" && !!pluginAction.value.parameters.properties);
const pluginFields = computed(() => {
  const properties = pluginAction.value?.parameters.properties, required = pluginAction.value?.parameters.required;
  return properties && typeof properties === "object" ? Object.entries(properties).map(([name, schema]) => ({ name, schema: schema as ParameterSchema, required: Array.isArray(required) && required.includes(name) })) : [];
});
const pluginValues = ref<Record<string, any>>({});
const pluginJsonValues = ref<Record<string, string>>({});
const pluginRawArgs = ref("{}");
const pluginReadError = ref("");
const pluginWriteFailed = ref(false);
const pluginOriginalDraft = ref<string>();
let pluginBinding = "";
let pluginSnapshot: unknown;
function savePluginDraft() {
  if (!pluginBinding || pluginReadError.value && !pluginWriteFailed.value) return false;
  const [directory, canvasPath, nodeId, name] = JSON.parse(pluginBinding) as string[];
  try { saveWorkspaceDraft(directory, canvasPath, `parameters:${nodeId}:${name}`, { values: pluginValues.value, jsonValues: pluginJsonValues.value, rawArgs: pluginRawArgs.value, snapshot: pluginSnapshot }); pluginWriteFailed.value = false; pluginReadError.value = ""; return true; }
  catch (reason) { pluginWriteFailed.value = true; pluginReadError.value = reason instanceof Error ? reason.message : "操作草稿保存失败，请先下载保留"; return false; }
}
watch(() => JSON.stringify([props.directory, props.canvasPath, props.node?.id, pluginActionName.value]), key => {
  pluginBinding = ""; pluginReadError.value = ""; pluginWriteFailed.value = false; pluginSnapshot = undefined; pluginOriginalDraft.value = undefined;
  pluginValues.value = {}; pluginJsonValues.value = {}; pluginRawArgs.value = "{}";
  if (!props.canvasPath || !props.node || !pluginAction.value) return;
  try {
    const saved = readWorkspaceDraft<any>(props.directory, props.canvasPath, `parameters:${props.node.id}:${pluginActionName.value}`);
    if (saved !== undefined && (!isPlainObject(saved) || saved.values !== undefined && !isPlainObject(saved.values) || saved.jsonValues !== undefined && (!isPlainObject(saved.jsonValues) || Object.values(saved.jsonValues).some(value => typeof value !== "string")) || saved.rawArgs !== undefined && typeof saved.rawArgs !== "string")) throw new Error("操作草稿格式无法读取，原内容已保留");
    pluginValues.value = saved?.values ?? Object.fromEntries(pluginFields.value.filter(field => field.schema.default !== undefined).map(field => [field.name, JSON.parse(JSON.stringify(field.schema.default))]));
    pluginJsonValues.value = saved?.jsonValues ?? Object.fromEntries(pluginFields.value.filter(field => isJsonField(field.schema)).filter(field => field.schema.default !== undefined).map(field => [field.name, JSON.stringify(field.schema.default, null, 2)]));
    pluginRawArgs.value = saved?.rawArgs ?? "{}";
    pluginSnapshot = saved?.snapshot;
  } catch (reason) {
    pluginReadError.value = reason instanceof Error ? reason.message : "操作草稿读取失败";
    try { pluginOriginalDraft.value = localStorage.getItem("toonflow.draft." + JSON.stringify([props.directory, props.canvasPath, `parameters:${props.node.id}:${pluginActionName.value}`])) ?? undefined; } catch { /* 读取被限制时不导出空替代稿。 */ }
  }
  pluginBinding = key;
}, { immediate: true, flush: "sync" });
watch([pluginValues, pluginJsonValues, pluginRawArgs], () => { if (pluginBinding) savePluginDraft(); }, { deep: true, flush: "sync" });
async function downloadPluginDraft() {
  try { await saveFile(new Blob([pluginOriginalDraft.value ?? JSON.stringify({ values: pluginValues.value, jsonValues: pluginJsonValues.value, rawArgs: pluginRawArgs.value, snapshot: pluginSnapshot }, null, 2)], { type: "application/json" }), "nodeOperationDraft.json"); }
  catch (reason) { ElMessage.error(reason instanceof Error ? reason.message : "草稿下载失败"); }
}
async function executePluginAction() {
  if (!pluginAction.value || pluginReadError.value || props.editorBlocked || loading.value || !savePluginDraft()) return;
  try {
    const args: Record<string, unknown> = pluginHasProperties.value ? { ...pluginValues.value } : JSON.parse(pluginRawArgs.value);
    if (!isPlainObject(args)) throw new Error("操作参数必须是 JSON 对象");
    for (const field of pluginFields.value) {
      if (isJsonField(field.schema)) {
        const value = pluginJsonValues.value[field.name];
        if (value?.trim()) args[field.name] = JSON.parse(value);
        else delete args[field.name];
      }
      if (field.required && (args[field.name] === undefined || args[field.name] === "")) throw new Error("请填写 " + (field.schema.title || field.name));
    }
    await executeNodeAction(pluginAction.value.name, args);
  } catch (reason) { error.value = reason instanceof Error ? reason.message : "操作参数无效"; }
}
const generationState = ref<GenerationState>();
const generationError = ref("");
const fileInput = ref<HTMLInputElement>();
const uploading = ref(false);
const currentOutput = computed(() => {
  const output = mediaType.value && props.node?.data.outputs?.[mediaType.value];
  return output?.value && typeof output.value.url === "string" ? output.value as NodeMediaValue : undefined;
});
const running = computed(() => ["accepted", "running"].includes(generationState.value?.status ?? ""));
const hasGenerationAction = computed(() => !!generationName.value && descriptor.value?.actions.some(item => item.name === generationName.value));
// 文本引用可能只保留 textPath；正文由后端 readOutputs 读取并在生成前校验。
const hasPrompt = computed(() => typeof props.node?.data.prompt === "string" && !!props.node.data.prompt.trim() || !!mediaType.value && !!props.graph && !!props.node && getTargetSources(props.node.id, "in", props.graph.nodes, props.graph.edges).some(({ handle }) => handle.dataType === "STRING" || Array.isArray(handle.dataType) && handle.dataType.includes("STRING")));
const generationBlocked = computed(() => !hasGenerationAction.value || !hasPrompt.value || !props.modelReady || !generationState.value || !!generationError.value || !!error.value || !!mediaType.value && !!mediaError.value || loading.value || submitting.value || uploading.value || !!pendingCommand.value || !!props.editorBlocked || legacyDrafts.value.length > 0 && !legacyAcknowledged.value || running.value || generationState.value.status === "needsReview" || !!generationState.value.controlsBlocked);
const resultBlocked = computed(() => loading.value || submitting.value || uploading.value || !!pendingCommand.value || !!props.editorBlocked || legacyDrafts.value.length > 0 && !legacyAcknowledged.value || !!generationError.value || !!error.value || !!generationName.value && (!!mediaError.value || !generationState.value || !!generationState.value.controlsBlocked || running.value));
const legacyDrafts = ref<{ kind: string; value: unknown }[]>([]);
const legacyAcknowledged = ref(false);
function loadLegacyDrafts() {
  if (props.node && !generationName.value && !mediaType.value) { legacyDrafts.value = []; return; }
  const drafts = props.canvasPath && props.node ? readWorkspaceDrafts<any>(props.directory, props.canvasPath, `parameters:${props.node.id}:`).filter(draft => Object.keys(draft.value?.values ?? {}).length || Object.keys(draft.value?.jsonValues ?? {}).length || draft.value?.rawArgs?.trim() && draft.value.rawArgs.trim() !== "{}") : [];
  if (graphValueJson(drafts) !== graphValueJson(legacyDrafts.value)) { legacyDrafts.value = drafts; legacyAcknowledged.value = false; }
}
function legacyLabel(kind: string) {
  const name = kind.slice(kind.lastIndexOf(":") + 1);
  return descriptor.value?.actions.find(action => action.name === name)?.editor?.label ?? "保留的操作草稿";
}
async function downloadLegacyDrafts() {
  try { await saveFile(new Blob([JSON.stringify(legacyDrafts.value, null, 2)], { type: "application/json" }), "nodeDrafts.json"); }
  catch (reason) { ElMessage.error(reason instanceof Error ? reason.message : "草稿下载失败"); }
}
const currentJob = computed(() => jobs.value.find(job => job.jobId === props.node?.data.generationJobId));
function statusLabel(status: string) {
  return ({ idle: "尚未生成", accepted: "已排队", running: "生成中", prepared: "已准备", submitting: "提交中", tracking: "生成中", collecting: "保存结果中", completed: "已完成", failed: "生成失败", cancelled: "已停止本地等待", unknown: "上次任务状态待确认", collectionFailed: "结果保存失败", needsReview: "上次任务待核对" } as Record<string, string>)[status] ?? status;
}
const jobs = ref<NodeJobView[]>([]);
const mediaJobs = ref<MediaJob[]>([]);
const pendingCommand = ref<CanvasCommand>();
const result = ref("");
const error = ref("");
const mediaError = ref("");
const loading = ref(false);
const submitting = ref(false);
let revision = 0;
let mediaRevision = 0;
let catalogRevision = 0;
let snapshotCursor = 0;
let mediaTimer: ReturnType<typeof setTimeout> | undefined;
let latestMedia: { revision: number; binding: string; task: Promise<boolean> } | undefined;
let latestTasks: { revision: number; binding: string; task: Promise<boolean> } | undefined;
const lifetime = new AbortController();
const jobSequences = new Map<string, number>();
let disposed = false;
const taskBinding = computed(() => JSON.stringify([props.directory, props.canvasPath, props.node?.id, props.node?.type, descriptor.value?.executionRevision]));
let generationRevision = 0;
function commandMatches(command: CanvasCommand) {
  return command.directory === props.directory && command.canvasPath === props.canvasPath && command.args.nodeId === props.node?.id;
}
function clearCommand(command: CanvasCommand) {
  const saved = readWorkspaceDraft<CanvasCommand>(command.directory, command.canvasPath, `command:${String(command.args.nodeId)}`);
  if (saved?.commandId === command.commandId) removeWorkspaceDraft(command.directory, command.canvasPath, `command:${String(command.args.nodeId)}`);
  if (pendingCommand.value?.commandId === command.commandId) pendingCommand.value = undefined;
}
function commandFailed(command: CanvasCommand | undefined, reason: unknown) {
  if (command && reason instanceof ExecutionRequestError && reason.status >= 400 && reason.status < 500) clearCommand(command);
  if (!command || commandMatches(command)) error.value = reason instanceof Error ? reason.message : "上次操作结果待确认，原操作已保留";
}

function matchesNode(job: { nodeId?: string; canvasPath?: string }) {
  return !props.node || job.nodeId === props.node.id && job.canvasPath === props.canvasPath;
}
function requestSignal(signal?: AbortSignal) {
  return AbortSignal.any([lifetime.signal, AbortSignal.timeout(20000), ...(signal ? [signal] : [])]);
}
function scheduleMedia() {
  clearTimeout(mediaTimer);
  if (!disposed && !document.hidden && (running.value || mediaJobs.value.some(job => ["prepared", "submitting", "tracking", "collecting"].includes(job.status) || job.status === "completed" && job.linkStatus === "pending")))
    mediaTimer = setTimeout(() => { void loadMedia(); }, 3000);
}
function loadMedia(signal?: AbortSignal, includeGeneration = true) {
  const task = readMedia(signal, includeGeneration);
  latestMedia = { revision: mediaRevision, binding: taskBinding.value, task };
  return task;
}
async function readMedia(signal?: AbortSignal, includeGeneration = true): Promise<boolean> {
  if (props.node && !(generationName.value && mediaType.value)) { mediaJobs.value = []; mediaError.value = ""; return !includeGeneration || !generationName.value || !!await readGeneration(signal); }
  const binding = taskBinding.value;
  const directory = props.directory;
  const version = ++mediaRevision;
  const current = () => !disposed && !signal?.aborted && version === mediaRevision && binding === taskBinding.value;
  const newer = () => !disposed && !signal?.aborted && latestMedia && latestMedia.revision > version && latestMedia.binding === binding && binding === taskBinding.value ? latestMedia.task : false;
  if (!directory) return false;
  try {
    const { data } = await axios.get<{ code: number; data: MediaJob[]; message?: string }>("/api/ai/media/list", { params: { directory }, signal: requestSignal(signal) });
    if (!current()) return newer();
    if (data.code !== 200 || !Array.isArray(data.data)) throw new Error(data.message || "媒体任务查询失败");
    const next = data.data.filter(matchesNode);
    if (graphValueJson(next) !== graphValueJson(mediaJobs.value)) mediaJobs.value = next;
    mediaError.value = "";
    return !includeGeneration || !generationName.value || !!await readGeneration(signal);
  } catch (reason) {
    if (!current()) return newer();
    mediaError.value = reason instanceof Error ? reason.message : "媒体任务查询失败";
    return false;
  } finally { if (current()) scheduleMedia(); }
}
async function loadCatalog(signal?: AbortSignal) {
  if (!props.node) return true;
  const version = ++catalogRevision;
  try {
    const entries = await fetchNodeCatalog(requestSignal(signal));
    if (disposed || signal?.aborted || version !== catalogRevision) return false;
    if (graphValueJson(entries) !== graphValueJson(catalog.value)) {
      catalog.value = entries;
      emit("catalog", entries);
    }
    return true;
  } catch (reason) {
    if (!disposed && !signal?.aborted && version === catalogRevision) error.value = reason instanceof Error ? reason.message : "节点描述读取失败";
    return false;
  }
}
async function syncNode(signal?: AbortSignal) {
  if (!await loadCatalog(signal)) return false;
  if (!await refreshNode(signal)) return false;
  return !generationName.value || !!await readGeneration(signal);
}
async function refreshNode(signal?: AbortSignal) {
  await nextTick();
  return !props.refreshNode || await props.refreshNode(signal) !== false;
}
function load(signal?: AbortSignal) {
  const task = readTasks(signal);
  latestTasks = { revision, binding: taskBinding.value, task };
  return task;
}
async function readTasks(signal?: AbortSignal): Promise<boolean> {
  const directory = props.directory;
  const binding = taskBinding.value;
  const currentRevision = ++revision;
  const current = () => !signal?.aborted && currentRevision === revision && binding === taskBinding.value && !disposed;
  const newer = () => !disposed && !signal?.aborted && latestTasks && latestTasks.revision > currentRevision && latestTasks.binding === binding && binding === taskBinding.value ? latestTasks.task : false;
  if (!directory) return false;
  loading.value = true;
  error.value = "";
  try { loadLegacyDrafts(); } catch (reason) { error.value = reason instanceof Error ? reason.message : "保留草稿读取失败"; }
  const [local] = await Promise.allSettled([
    createExecutionClient(directory).listJobSnapshot(requestSignal(signal)),
  ]);
  if (!current()) return newer();
  const snapshot = local.status === "fulfilled" && local.value && Array.isArray(local.value.jobs) && Number.isSafeInteger(local.value.cursor) && local.value.cursor >= 0 ? local.value : undefined;
  const cursor = snapshot?.cursor ?? 0;
  const results = await Promise.allSettled([
    loadMedia(signal, false),
    loadCatalog(signal),
  ]);
  if (!current()) return newer();
  const [media, described] = results;
  let synchronized = described.status === "fulfilled" && described.value;
  if (synchronized) {
    try { synchronized = await refreshNode(signal); }
    catch (reason) {
      if (current()) error.value = reason instanceof Error ? reason.message : "节点编辑信息同步失败";
      synchronized = false;
    }
  }
  if (synchronized && generationName.value) synchronized = !!await readGeneration(signal);
  if (!current()) return newer();
  if (snapshot) {
    const latest = new Map(jobs.value.map(job => [job.jobId, job]));
    const next = snapshot.jobs.filter(matchesNode).map(job => (jobSequences.get(job.jobId) ?? 0) > cursor ? latest.get(job.jobId) ?? job : job);
    for (const job of jobs.value) if ((jobSequences.get(job.jobId) ?? 0) > cursor && !next.some(item => item.jobId === job.jobId)) next.push(job);
    next.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    if (graphValueJson(next) !== graphValueJson(jobs.value)) jobs.value = next;
  } else if (local.status === "fulfilled") error.value = "任务快照缺少有效列表或游标";
  const failed = [local, ...results].find(item => item.status === "rejected");
  if (failed?.status === "rejected") error.value = failed.reason instanceof Error ? failed.reason.message : "任务查询失败";
  loading.value = false;
  let loaded = !!snapshot && !error.value && !mediaError.value && media.status === "fulfilled" && media.value && synchronized;
  if (loaded && pendingCommand.value) loaded = await reconcileCommand(signal, false);
  if (!current()) return newer();
  // 先固定任务游标，再核对目录、媒体和编辑内容；完整同步成功才跳过历史事件。
  if (loaded) snapshotCursor = Math.max(snapshotCursor, cursor);
  return loaded;
}

function nodeCommand(name: string, args: Record<string, unknown>, baseVersion: number): CanvasCommand {
  if (!props.node || !descriptor.value || !props.canvasPath || !Number.isSafeInteger(baseVersion) || baseVersion < 0) throw new Error("节点信息尚未同步");
  if (!descriptor.value.actions.some(item => item.name === name || item.name === "node:" + name)) throw new Error("此节点不支持该操作");
  return {
    directory: props.directory, canvasPath: props.canvasPath, commandId: crypto.randomUUID(), name: "nodeTools",
    args: { nodeId: props.node.id, name: name.startsWith("node:") ? name : "node:" + name, args, expectedNodeRevision: descriptor.value.executionRevision },
    expectedVersions: { [props.node.id]: baseVersion }, clientContext: { clientId: getExecutionClientId() },
  };
}
async function readGeneration(signal?: AbortSignal, forAction = false): Promise<GenerationState | undefined> {
  if (!generationName.value || !props.node || !props.canvasPath || !descriptor.value) return;
  const binding = taskBinding.value, version = ++generationRevision, nodeId = props.node.id;
  const current = requestSignal(signal);
  try {
    const graph = await useWorkspaceFiles(props.directory).readGraph(props.canvasPath, current);
    current.throwIfAborted();
    if (disposed || binding !== taskBinding.value || !graph.nodes.some(node => node.id === nodeId && node.type === props.node?.type)) return;
    const state = await createExecutionClient(props.directory).execute<GenerationState>(nodeCommand("getGenerationStatus", {}, graph.toonflowGraph.nodes[nodeId]), current);
    if (disposed || current.aborted || binding !== taskBinding.value) return;
    if (!state || typeof state.status !== "string" || mediaType.value && typeof state.controlsBlocked !== "boolean") throw new Error("生成状态暂时无法确认");
    if (version === generationRevision) { generationState.value = state; generationError.value = ""; }
    return state;
  } catch (reason) {
    if (forAction && !disposed && binding === taskBinding.value) throw reason;
    if (!disposed && !signal?.aborted && binding === taskBinding.value && version === generationRevision) generationError.value = reason instanceof Error ? reason.message : "生成状态查询失败";
  }
}
async function submitNodeAction(name: string, args: Record<string, unknown>, baseVersion: number) {
  const command = nodeCommand(name, args, baseVersion);
  saveWorkspaceDraft(command.directory, command.canvasPath, "command:" + props.node!.id, command);
  pendingCommand.value = command;
  try {
    const response = await createExecutionClient(command.directory).command(command, lifetime.signal);
    if (displayCommand(response, command)) await load();
  } catch (reason) { commandFailed(command, reason); }
}
async function executeNodeAction(name: string, args: Record<string, unknown> = {}) {
  if (!props.node || !descriptor.value || !props.graph || submitting.value || uploading.value || pendingCommand.value || props.editorPending) return;
  const binding = taskBinding.value, originalVersion = props.graph.toonflowGraph.nodes[props.node.id];
  submitting.value = true;
  error.value = "";
  try {
    loadLegacyDrafts();
    if ((generationName.value || mediaType.value) && (name === generationName.value || name.startsWith("set")) && legacyDrafts.value.length && !legacyAcknowledged.value) throw new Error("请先核对保留的操作草稿");
    if (generationName.value) {
      const state = await readGeneration(undefined, true);
      if (!state || disposed || binding !== taskBinding.value) return;
      if (name === generationName.value && (!hasPrompt.value || !props.modelReady)) throw new Error("请先保存提示词并选择可用模型");
      if (name === generationName.value && (props.editorBlocked || state.controlsBlocked || ["accepted", "running", "needsReview"].includes(state.status))) throw new Error(props.editorBlocked ? "请先保存节点修改再生成" : "上次任务尚未结束，请先核对原任务");
      if (name.startsWith("set") && (props.editorBlocked || state.controlsBlocked || ["accepted", "running", "needsReview"].includes(state.status))) throw new Error("请先保存修改并核对原任务，再替换结果");
      if (name === "retryCollection" && state.mediaJob?.status !== "collectionFailed") throw new Error("原任务状态已变化，请重新核对");
      if (name === "abandonUnknownGeneration") {
        if (mediaType.value ? state.mediaJob && state.mediaJob.status !== "unknown" || !props.node.data.pendingMediaJob : state.status !== "needsReview") throw new Error("原任务状态已变化，请重新核对");
        try { await ElMessageBox.confirm("供应商可能仍在生成或已计费。确认已核对原任务后解除绑定；保留历史结果，不会自动发起新生成。", "放弃原任务？", { type: "warning", confirmButtonText: "确认放弃", cancelButtonText: "取消" }); } catch { return; }
      }
      if (name === "cancelGeneration") {
        if (mediaType.value && !state.canCancelObservation || !mediaType.value && !["accepted", "running"].includes(state.status)) return;
        if (mediaType.value) {
          try { await ElMessageBox.confirm("仅停止本地等待，供应商任务仍会继续生成和保存结果，并可能计费。", "取消本地等待", { confirmButtonText: "取消本地等待", cancelButtonText: "继续等待" }); } catch { return; }
        }
      }
      if (disposed || binding !== taskBinding.value || props.editorPending || name === generationName.value && props.editorBlocked) return;
    } else if (props.editorBlocked) throw new Error("请先保存节点修改");
    await submitNodeAction(name, args, originalVersion);
  } catch (reason) { if (!disposed && binding === taskBinding.value) error.value = reason instanceof Error ? reason.message : "节点操作失败"; }
  finally { submitting.value = false; }
}
async function selectOutput(value: NodeMediaValue) {
  if (resultBlocked.value || !mediaType.value) return;
  const slot = mediaType.value, output = props.node?.data.outputs?.[slot] ?? null;
  await executeNodeAction({ image: "setImage", video: "setVideo", audio: "setAudio" }[slot], { path: value.url, mimeType: value.mimeType, expectedOutput: JSON.parse(JSON.stringify(output)) });
}
async function uploadOutput(event: Event) {
  const input = event.target as HTMLInputElement, file = input.files?.[0];
  input.value = "";
  if (!file || resultBlocked.value || !mediaType.value || !props.node || !props.graph) return;
  const limit = 100;
  if (!file.type.startsWith(mediaType.value + "/") || !file.size || file.size > limit * 1024 * 1024) return void ElMessage.error("请选择有效的" + mediaLabel.value + "文件（不超过" + limit + "MB）");
  const directory = props.directory, binding = taskBinding.value, version = props.graph.toonflowGraph.nodes[props.node.id], name = "upload" + ({ image: "Image", video: "Video", audio: "Audio" }[mediaType.value]);
  const files = useWorkspaceFiles(directory);
  uploading.value = true;
  error.value = "";
  try {
    loadLegacyDrafts();
    if (legacyDrafts.value.length && !legacyAcknowledged.value) throw new Error("请先核对保留的操作草稿");
    if (generationName.value) {
      const state = await readGeneration(undefined, true);
      if (!state || disposed || binding !== taskBinding.value) return;
      if (state.controlsBlocked || ["accepted", "running", "needsReview"].includes(state.status)) throw new Error("请先核对原任务，再替换结果");
    }
    if (props.editorBlocked || disposed || binding !== taskBinding.value) return;
    const stagedPath = "assets/uploads/" + crypto.randomUUID();
    for (const path of ["assets", "assets/uploads"]) {
      await files.mkdir(path).catch((reason: { response?: { data?: { data?: { code?: string } } } }) => { if (reason.response?.data?.data?.code !== "EEXIST") throw reason; });
      if (disposed || binding !== taskBinding.value) return;
    }
    await files.write(stagedPath, file, true, lifetime.signal);
    if (disposed || binding !== taskBinding.value || props.editorBlocked) return;
    submitting.value = true;
    await submitNodeAction(name, { stagedPath, name: file.name, mimeType: file.type }, version);
  } catch (reason) { if (!disposed && binding === taskBinding.value) error.value = reason instanceof Error ? reason.message : "上传失败"; }
  finally { uploading.value = false; submitting.value = false; }
}

function displayCommand(response: CanvasCommandResult, command: CanvasCommand) {
  if (disposed || response.commandId !== command.commandId || !commandMatches(command) || pendingCommand.value?.commandId !== command.commandId) return false;
  result.value = JSON.stringify(response, null, 2);
  if (response.status === "completed" || response.status === "failed" || response.status === "needsReview") {
    clearCommand(command);
    if (response.status !== "completed") error.value = response.errorMessage || "节点操作未完成，请核对当前状态";
    emit("changed");
    return true;
  }
  return false;
}
async function reconcileCommand(signal?: AbortSignal, refreshJobs = true): Promise<boolean> {
  const command = pendingCommand.value;
  if (!command) return true;
  if (submitting.value) return false;
  const current = requestSignal(signal);
  let posting = false;
  submitting.value = true;
  try {
    const client = createExecutionClient(command.directory);
    let response = await client.getCommand(command.commandId, current);
    if (!response) { posting = true; response = await client.command(command, current); }
    if (current.aborted || disposed || !commandMatches(command) || pendingCommand.value?.commandId !== command.commandId) return false;
    if (displayCommand(response, command) && refreshJobs) return load(signal);
    return true;
  } catch (err) {
    if (!current.aborted && !disposed && commandMatches(command) && pendingCommand.value?.commandId === command.commandId) {
      if (posting) commandFailed(command, err);
      else error.value = err instanceof Error ? err.message : "命令核对失败，原命令已保留";
    }
    return false;
  }
  finally { submitting.value = false; }
}
async function cancelJob(job: NodeJobView) {
  const binding = taskBinding.value;
  try {
    await ElMessageBox.confirm(job.kind === "media" ? "仅停止本地观察，已提交的媒体仍会生成、收取并可能计费。" : "取消该后台任务？已进入提交阶段的结果会继续保存。", job.kind === "media" ? "停止观察" : "取消任务", { confirmButtonText: job.kind === "media" ? "停止观察" : "取消任务", cancelButtonText: "继续执行" });
  } catch { return; }
  if (disposed || binding !== taskBinding.value) return;
  try { await createExecutionClient(job.directory).cancelJob(job.jobId); if (!disposed && binding === taskBinding.value) await load(); }
  catch (err) { if (!disposed && binding === taskBinding.value) ElMessage.error(err instanceof Error ? err.message : "取消失败"); }
}
async function resumeJob(job: NodeJobView) {
  const binding = taskBinding.value;
  try {
    await ElMessageBox.confirm("使用已保存的输入继续原任务。已写入的图和正文会按原命令核对，不会重新提交模型生成。", "恢复原任务", { confirmButtonText: "恢复", cancelButtonText: "取消" });
  } catch { return; }
  if (disposed || binding !== taskBinding.value) return;
  try { await createExecutionClient(job.directory).resumeJob(job.jobId); if (!disposed && binding === taskBinding.value) await load(); }
  catch (err) { if (!disposed && binding === taskBinding.value) ElMessage.error(err instanceof Error ? err.message : "恢复失败"); }
}
async function downloadResult(job: NodeJobView) {
  try { await saveFile(new Blob([JSON.stringify(job.result, null, 2)], { type: "application/json" }), `${job.kind}Result.json`); }
  catch (err) { ElMessage.error(err instanceof Error ? err.message : "结果下载失败"); }
}
function openJobNode(job: NodeJobView) {
  void router.push({ path: `/mobile/node/${job.nodeId}`, query: { ...route.query, directory: job.directory, canvas: job.canvasPath } });
}

watch(taskBinding, () => {
  revision++; mediaRevision++;
  snapshotCursor = 0;
  jobSequences.clear();
  jobs.value = [];
  mediaJobs.value = [];
  mediaError.value = "";
  error.value = "";
  generationState.value = undefined;
  generationError.value = "";
  generationRevision++;
  legacyDrafts.value = [];
  legacyAcknowledged.value = false;
  clearTimeout(mediaTimer);
  pendingCommand.value = undefined;
  result.value = "";
  try {
    const saved = props.canvasPath && props.node ? readWorkspaceDraft<CanvasCommand>(props.directory, props.canvasPath, `command:${props.node.id}`) : undefined;
    if (saved?.commandId && saved.name === "nodeTools" && commandMatches(saved)) pendingCommand.value = saved;
  } catch (reason) { error.value = reason instanceof Error ? reason.message : "命令草稿读取失败"; }
}, { immediate: true });
const { error: connectionError } = useWorkspaceEvents({
  directory: () => props.directory,
  context: () => taskBinding.value,
  cursor: () => snapshotCursor,
  refresh: signal => load(signal),
  receive: async (event, signal) => {
    if (event.type === "pluginsChanged") return syncNode(signal);
    if (event.type === "contentChanged" && props.node && (!event.canvasId || event.canvasId === props.canvasPath)) {
      // ACT: 协议没有资源关联，保守核对最多 256 个动作中的干净读取区块；未来可按资源元数据收窄。
      return !props.refreshNode || await props.refreshNode(signal, true) !== false;
    }
    if (event.type === "jobChanged") {
      if (event.seq <= snapshotCursor) return;
      const value = event.payload.job;
      if (!value || typeof value !== "object") return; // 文本增量不改变任务状态，终态另有完整任务通知。
      const job = value as NodeJobView;
      if (![job.jobId, job.directory, job.commandId, job.kind, job.status, job.createdAt, job.updatedAt].every(value => typeof value === "string")) throw new Error("任务事件格式无效");
      if (!matchesNode(job)) return;
      const index = jobs.value.findIndex(item => item.jobId === job.jobId);
      jobSequences.set(job.jobId, event.seq);
      if (index < 0) jobs.value.unshift(job);
      else if (graphValueJson(jobs.value[index]) !== graphValueJson(job)) jobs.value[index] = job;
      if (pendingCommand.value && pendingCommand.value.commandId === event.commandId && !await reconcileCommand(signal, false)) return false;
      if (job.kind === "media") return loadMedia(signal);
      if (generationName.value) return !!await readGeneration(signal);
    }
    if (event.type === "graphChanged" && (!event.canvasId || event.canvasId === props.canvasPath) && pendingCommand.value && pendingCommand.value.commandId === event.commandId) return reconcileCommand(signal, false);
  },
});
const stopHiddenMedia = () => { if (document.hidden) clearTimeout(mediaTimer); };
document.addEventListener("visibilitychange", stopHiddenMedia);
onUnmounted(() => {
  disposed = true; revision++;
  lifetime.abort();
  clearTimeout(mediaTimer);
  document.removeEventListener("visibilitychange", stopHiddenMedia);
});
</script>

<style scoped lang="scss">
.mobileExecutePanel {
  margin-top: 12px;
  overflow-wrap: anywhere;
  .actionSelect { width: 100%; margin-top: 12px; }
  .parameterForm { margin-top: 12px; .el-select { width: 100%; } .fieldDescription { width: 100%; margin: 4px 0; color: var(--el-text-color-secondary); } }
  pre { max-height: 240px; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; }
  .nodeActions {
    .generateButton { width: 100%; min-height: 44px; }
    .generationStatus { margin: 0 0 12px; }
    .saveHint { color: var(--el-color-warning); margin: 8px 0; }
  }
  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    margin: 12px 0;
    :deep(.el-button) { margin: 0; min-height: 44px; }
  }
  .jobList {
    list-style: none;
    margin: 0;
    padding: 0;
    li { padding: 12px 0; border-top: 1px solid var(--el-border-color-lighter); }
  }
  .legacyDrafts { pre { max-height: 240px; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; } }
}
</style>
