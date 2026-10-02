<template>
  <el-card class="mobileExecutePanel" shadow="never">
    <template #header>{{ node ? "后端节点动作与任务" : "后台任务" }}</template>
    <el-alert v-if="error" :title="error" type="error" :closable="false" showIcon />
    <el-alert v-if="connectionError" :title="connectionError" type="warning" :closable="false" showIcon />
    <template v-if="node">
      <el-alert v-if="!descriptor && !loading" title="此节点尚未提供后端执行描述，请迁移插件后使用" type="warning" :closable="false" />
      <el-select v-if="descriptor?.actions.length" v-model="actionName" class="actionSelect" placeholder="选择节点动作" aria-label="节点动作">
        <el-option v-for="item in descriptor.actions" :key="item.name" :label="item.description || item.name" :value="item.name" />
      </el-select>
      <el-form v-if="action" labelPosition="top" class="parameterForm" @submit.prevent="executeAction">
        <el-form-item v-for="field in fields" :key="field.name" :label="field.schema.title || field.name" :required="field.required">
          <el-select v-if="field.schema.enum" v-model="values[field.name]" clearable>
            <el-option v-for="(value, index) in field.schema.enum" :key="index" :label="String(value)" :value="value" />
          </el-select>
          <el-switch v-else-if="field.schema.type === 'boolean'" v-model="values[field.name]" />
          <el-input-number v-else-if="['number', 'integer'].includes(field.schema.type || '')" v-model="values[field.name]" :min="field.schema.minimum" :max="field.schema.maximum" :precision="field.schema.type === 'integer' ? 0 : undefined" />
          <el-input v-else-if="field.schema.type === 'object' || field.schema.type === 'array' || field.schema.$ref || field.schema.oneOf || field.schema.anyOf" v-model="jsonValues[field.name]" type="textarea" :autosize="{ minRows: 2, maxRows: 12 }" />
          <el-input v-else v-model="values[field.name]" :maxlength="field.schema.maxLength" :type="field.schema.maxLength && field.schema.maxLength > 200 ? 'textarea' : 'text'" />
          <p v-if="field.schema.description" class="fieldDescription">{{ field.schema.description }}</p>
        </el-form-item>
        <el-input v-if="!hasProperties" v-model="rawArgs" type="textarea" :autosize="{ minRows: 3, maxRows: 12 }" aria-label="动作 JSON 参数" />
        <div class="actions"><el-button type="primary" nativeType="submit" :loading="submitting" :disabled="!canvasPath || !!pendingCommand">执行</el-button></div>
      </el-form>
      <div v-if="pendingCommand" class="actions"><el-button :loading="submitting" @click="reconcileCommand">查询待确认命令 {{ pendingCommand.commandId }}</el-button></div>
      <pre v-if="result" class="json">{{ result }}</pre>
    </template>
    <div class="actions"><el-button :loading="loading" @click="load">刷新任务</el-button></div>
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
  </el-card>
</template>

<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { ElMessage, ElMessageBox } from "element-plus";
import axios from "axios";
import { createExecutionClient, ExecutionRequestError, fetchNodeCatalog, getExecutionClientId, isExecutableNode, type NodeCatalogEntry } from "@toonflow/nodes-scaffold/runtime";
import type { CanvasCommand, CanvasCommandResult, NodeJobView } from "@toonflow/nodes-scaffold/execution";
import type { WorkspaceGraph } from "@/lib/workspaceFiles";
import { readWorkspaceDraft, removeWorkspaceDraft, saveWorkspaceDraft } from "@/lib/workspaceDrafts";
import { useWorkspaceEvents } from "@/lib/workspaceEvents";
import saveFile from "@/lib/saveFile";
import type { CanvasNode } from "../lib/mobileGraphModel";

type ParameterSchema = { type?: string; title?: string; description?: string; default?: unknown; enum?: any[]; minimum?: number; maximum?: number; maxLength?: number; $ref?: string; oneOf?: unknown; anyOf?: unknown };
type MediaJob = { jobId: string; mediaType?: string; status: string; linkStatus?: string; nodeId?: string; errorMessage?: string };
const props = defineProps<{ directory: string; canvasPath?: string; node?: CanvasNode; graph?: WorkspaceGraph }>();
const emit = defineEmits<{ changed: [] }>();
const route = useRoute();
const router = useRouter();
const catalog = ref<NodeCatalogEntry[]>([]);
const descriptor = computed(() => {
  const entry = catalog.value.find(item => `remote-${item.name}` === props.node?.type);
  return entry && isExecutableNode(entry) ? entry : undefined;
});
const actionName = ref("");
const action = computed(() => descriptor.value?.actions.find(item => item.name === actionName.value));
const hasProperties = computed(() => action.value?.parameters.type === "object" && !!action.value.parameters.properties);
const fields = computed(() => {
  const properties = action.value?.parameters.properties;
  const required = action.value?.parameters.required;
  return properties && typeof properties === "object" ? Object.entries(properties).map(([name, schema]) => ({
    name, schema: schema as ParameterSchema, required: Array.isArray(required) && required.includes(name),
  })) : [];
});
const values = ref<Record<string, any>>({});
const jsonValues = ref<Record<string, string>>({});
const rawArgs = ref("{}");
type ParameterDraft = { values: Record<string, any>; jsonValues: Record<string, string>; rawArgs: string };
const jobs = ref<NodeJobView[]>([]);
const mediaJobs = ref<MediaJob[]>([]);
const pendingCommand = ref<CanvasCommand>();
const result = ref("");
const error = ref("");
const loading = ref(false);
const submitting = ref(false);
let revision = 0;
let disposed = false;
const draftKey = computed(() => JSON.stringify([props.directory, props.canvasPath, props.node?.id, actionName.value]));
let parameterBinding = "";
function saveParameters() {
  if (!parameterBinding) return;
  const [directory, path, nodeId, name] = JSON.parse(parameterBinding) as string[];
  if (!directory || !path || !nodeId || !name) return;
  try { saveWorkspaceDraft(directory, path, `parameters:${nodeId}:${name}`, { values: values.value, jsonValues: jsonValues.value, rawArgs: rawArgs.value }); }
  catch (reason) { error.value = reason instanceof Error ? reason.message : "参数草稿保存失败"; }
}
watch(draftKey, key => {
  saveParameters();
  parameterBinding = "";
  try {
    const saved = props.canvasPath && props.node && actionName.value ? readWorkspaceDraft<ParameterDraft>(props.directory, props.canvasPath, `parameters:${props.node.id}:${actionName.value}`) : undefined;
    values.value = saved?.values ?? Object.fromEntries(fields.value.filter(field => field.schema.default !== undefined).map(field => [field.name, JSON.parse(JSON.stringify(field.schema.default))]));
    jsonValues.value = saved?.jsonValues ?? Object.fromEntries(fields.value.filter(field => field.schema.type === "object" || field.schema.type === "array").filter(field => field.schema.default !== undefined).map(field => [field.name, JSON.stringify(field.schema.default, null, 2)]));
    rawArgs.value = saved?.rawArgs ?? "{}";
  } catch (reason) { error.value = reason instanceof Error ? reason.message : "参数草稿读取失败"; }
  parameterBinding = key;
}, { immediate: true });
watch([values, jsonValues, rawArgs], saveParameters, { deep: true, flush: "sync" });

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
  if (!command || commandMatches(command)) error.value = reason instanceof Error ? reason.message : "命令结果待确认，参数草稿已保留";
}

async function load() {
  const directory = props.directory;
  const nodeId = props.node?.id;
  const currentRevision = ++revision;
  const current = () => currentRevision === revision && directory === props.directory && nodeId === props.node?.id && !disposed;
  if (!directory) return;
  loading.value = true;
  error.value = "";
  const results = await Promise.allSettled([
    createExecutionClient(directory).listJobs(),
    axios.get<{ code: number; data: MediaJob[]; message?: string }>("/api/ai/media/list", { params: { directory } }),
    props.node ? fetchNodeCatalog() : Promise.resolve(catalog.value),
  ]);
  if (!current()) return;
  const [local, media, nodes] = results;
  if (local.status === "fulfilled") jobs.value = local.value.filter(job => !nodeId || job.nodeId === nodeId);
  if (media.status === "fulfilled" && media.value.data.code === 200 && Array.isArray(media.value.data.data)) mediaJobs.value = media.value.data.data.filter(job => !nodeId || job.nodeId === nodeId);
  if (nodes.status === "fulfilled") catalog.value = nodes.value;
  const failed = results.find(item => item.status === "rejected");
  if (failed?.status === "rejected") error.value = failed.reason instanceof Error ? failed.reason.message : "任务查询失败";
  if (media.status === "fulfilled" && media.value.data.code !== 200) error.value = media.value.data.message || "媒体任务查询失败";
  if (descriptor.value && !descriptor.value.actions.some(item => item.name === actionName.value)) actionName.value = descriptor.value.actions[0]?.name ?? "";
  loading.value = false;
}

function argumentsFromDraft() {
  if (!hasProperties.value) {
    const args: unknown = JSON.parse(rawArgs.value);
    if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error("动作参数必须为 JSON 对象");
    return args as Record<string, unknown>;
  }
  const args: Record<string, unknown> = { ...values.value };
  for (const field of fields.value) {
    const json = jsonValues.value[field.name]?.trim();
    if (json) args[field.name] = JSON.parse(json);
    if (field.required && (args[field.name] === undefined || args[field.name] === "")) throw new Error(`请填写 ${field.schema.title || field.name}`);
  }
  return args;
}

async function executeAction() {
  const node = props.node;
  const definition = descriptor.value;
  if (!node || !definition || !action.value || !props.canvasPath || submitting.value || pendingCommand.value) return;
  submitting.value = true;
  error.value = "";
  let command: CanvasCommand | undefined;
  try {
    command = {
      directory: props.directory, canvasPath: props.canvasPath, commandId: crypto.randomUUID(), name: "nodeTools",
      args: { nodeId: node.id, name: action.value.name.startsWith("node:") ? action.value.name : `node:${action.value.name}`, args: argumentsFromDraft(), expectedNodeRevision: definition.executionRevision },
      expectedVersions: { [node.id]: props.graph?.toonflowGraph.nodes[node.id] ?? 0 },
      clientContext: { clientId: getExecutionClientId() },
    };
    saveWorkspaceDraft(command.directory, command.canvasPath, `command:${node.id}`, command);
    pendingCommand.value = command;
    const response = await createExecutionClient(command.directory).command(command);
    displayCommand(response, command);
  } catch (err) { commandFailed(command, err); }
  finally { submitting.value = false; }
}

function displayCommand(response: CanvasCommandResult, command: CanvasCommand) {
  if (response.commandId !== command.commandId || !commandMatches(command)) return;
  result.value = JSON.stringify(response, null, 2);
  if (response.status === "completed" || response.status === "failed" || response.status === "needsReview") {
    clearCommand(command);
    if (response.status !== "completed") error.value = response.errorMessage || "执行失败，参数草稿已保留";
    emit("changed");
    void load();
  }
}
async function reconcileCommand() {
  const command = pendingCommand.value;
  if (!command || submitting.value) return;
  submitting.value = true;
  try {
    const client = createExecutionClient(command.directory);
    const response = await client.getCommand(command.commandId) ?? await client.command(command);
    displayCommand(response, command);
  } catch (err) { commandFailed(command, err); }
  finally { submitting.value = false; }
}
async function cancelJob(job: NodeJobView) {
  try {
    await ElMessageBox.confirm(job.kind === "media" ? "仅停止本地观察，已提交的媒体仍会生成、收取并可能计费。" : "取消该后台任务？已进入提交阶段的结果会继续保存。", job.kind === "media" ? "停止观察" : "取消任务", { confirmButtonText: job.kind === "media" ? "停止观察" : "取消任务", cancelButtonText: "继续执行" });
  } catch { return; }
  try { await createExecutionClient(job.directory).cancelJob(job.jobId); await load(); }
  catch (err) { ElMessage.error(err instanceof Error ? err.message : "取消失败"); }
}
async function resumeJob(job: NodeJobView) {
  try {
    await ElMessageBox.confirm("使用已保存的输入继续原任务。已写入的图和正文会按原命令核对，不会重新提交模型生成。", "恢复原任务", { confirmButtonText: "恢复", cancelButtonText: "取消" });
  } catch { return; }
  try { await createExecutionClient(job.directory).resumeJob(job.jobId); await load(); }
  catch (err) { ElMessage.error(err instanceof Error ? err.message : "恢复失败"); }
}
async function downloadResult(job: NodeJobView) {
  try { await saveFile(new Blob([JSON.stringify(job.result, null, 2)], { type: "application/json" }), `${job.kind}Result.json`); }
  catch (err) { ElMessage.error(err instanceof Error ? err.message : "结果下载失败"); }
}
function openJobNode(job: NodeJobView) {
  void router.push({ path: `/mobile/node/${job.nodeId}`, query: { ...route.query, directory: job.directory, canvas: job.canvasPath } });
}

watch(() => [props.directory, props.canvasPath, props.node?.id], () => {
  pendingCommand.value = undefined;
  result.value = "";
  try {
    const saved = props.canvasPath && props.node ? readWorkspaceDraft<CanvasCommand>(props.directory, props.canvasPath, `command:${props.node.id}`) : undefined;
    if (saved?.commandId && saved.name === "nodeTools" && commandMatches(saved)) pendingCommand.value = saved;
  } catch (reason) { error.value = reason instanceof Error ? reason.message : "命令草稿读取失败"; }
}, { immediate: true });
const { error: connectionError } = useWorkspaceEvents({
  directory: () => props.directory,
  context: () => JSON.stringify([props.canvasPath, props.node?.id]),
  refresh: async () => { await load(); if (pendingCommand.value) await reconcileCommand(); },
  receive: async event => {
    if (event.type !== "jobChanged" && event.type !== "graphChanged") return;
    await load();
    if (pendingCommand.value) await reconcileCommand();
  },
});
onUnmounted(() => {
  disposed = true; revision++;
  saveParameters();
});
</script>

<style scoped lang="scss">
.mobileExecutePanel {
  margin-top: 12px;
  .actionSelect { width: 100%; margin-top: 12px; }
  .parameterForm {
    margin-top: 12px;
    .el-select { width: 100%; }
    .fieldDescription { width: 100%; margin: 4px 0 0; color: var(--el-text-color-secondary); font-size: 12px; }
  }
  .actions { display: flex; flex-wrap: wrap; gap: 8px; margin: 8px 0; }
  .json { white-space: pre-wrap; overflow-wrap: anywhere; max-height: 240px; overflow: auto; }
  .jobList {
    padding: 0; list-style: none;
    li { padding: 8px 0; border-bottom: 1px solid var(--el-border-color-lighter); overflow-wrap: anywhere; }
  }
}
</style>
