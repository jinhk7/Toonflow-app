<template>
  <el-card v-if="sections.length" class="mobileNodeEditor" shadow="never">
    <template #header>节点编辑</template>
    <el-alert v-if="error" :title="error" type="error" :closable="false" showIcon />
    <el-form v-for="section in sections" :key="section.action.name" class="editorSection" labelPosition="top" :disabled="!section.ready && !section.dirty" @submit.prevent="saveSection(section)">
      <h3>{{ section.action.editor?.label }}</h3>
      <el-form-item v-for="field in section.fields.filter(item => !item.editor?.hidden)" :key="field.name" :label="field.editor?.label || field.schema.title || field.name" :required="field.required">
        <el-select v-if="field.editor?.model" :modelValue="modelValue(section, field)" :clearable="canClear(field)" @change="value => changeModel(section, field, value)">
          <el-option v-for="model in models(section, field)" :key="modelOptionValue(model, field)" :label="model.name || model.modelName || model[field.name] || model.modelId" :value="modelOptionValue(model, field)" />
        </el-select>
        <el-select v-else-if="field.editor?.choices || field.schema.enum" :modelValue="section.values[field.name] === '' ? undefined : JSON.stringify(section.values[field.name])" :clearable="canClear(field)" @change="value => changeChoice(section, field, value)">
          <el-option v-for="value in choices(section, field)" :key="JSON.stringify(value)" :label="value?.label || (typeof value === 'string' ? value : JSON.stringify(value))" :value="JSON.stringify(value?.value ?? value)" />
        </el-select>
        <el-select v-else-if="isNullableBoolean(field)" :modelValue="JSON.stringify(section.values[field.name])" @change="value => changeChoice(section, field, value)">
          <el-option label="开启" value="true" />
          <el-option label="关闭" value="false" />
          <el-option label="未设置" value="null" />
        </el-select>
        <el-switch v-else-if="field.schema.type === 'boolean'" v-model="section.values[field.name]" @change="changeSection(section)" />
        <el-input-number v-else-if="field.schema.type === 'number' || field.schema.type === 'integer'" v-model="section.values[field.name]" :min="field.schema.minimum" :max="field.schema.maximum" :precision="field.schema.type === 'integer' ? 0 : undefined" @change="changeSection(section)" />
        <el-input v-else-if="isJson(field)" v-model="section.jsonValues[field.name]" type="textarea" :autosize="{ minRows: 3, maxRows: 16 }" @input="changeSection(section)" />
        <el-input v-else v-model="section.values[field.name]" :maxlength="field.schema.maxLength" :type="field.editor?.multiline ? 'textarea' : 'text'" :autosize="field.editor?.multiline ? { minRows: 4, maxRows: 16 } : undefined" @input="changeSection(section)" />
        <p v-if="field.schema.description" class="fieldDescription">{{ field.schema.description }}</p>
      </el-form-item>
      <div class="sectionActions">
        <el-button type="primary" nativeType="submit" :loading="section.saving" :disabled="!section.ready || section.loading || !!section.pending || !section.dirty || sections.some(item => item !== section && item.saving)">保存{{ section.action.editor?.label }}</el-button>
        <el-button v-if="section.pending" :loading="section.saving" :disabled="sections.some(item => item !== section && item.saving)" @click="reconcileSection(section)">核对原保存</el-button>
        <el-button v-if="section.error || section.dirty" :loading="section.loading" :disabled="section.saving || !!section.pending" @click="retryRead(section)">核对最新节点信息</el-button>
      </div>
      <div v-if="section.reviewing && section.remote" class="remotePreview">
        <p>远端当前内容（草稿保留在上方）</p>
        <pre>{{ JSON.stringify(remoteValues(section), null, 2) }}</pre>
        <el-button :disabled="section.loading || section.saving || !!section.pending" @click="acceptRemote(section)">接受当前版本并保留草稿</el-button>
      </div>
      <el-alert v-if="section.error" :title="section.error" type="warning" :closable="false" showIcon />
    </el-form>
  </el-card>
</template>

<script setup lang="ts">
import { computed, onScopeDispose, ref, watch } from "vue";
import { ElMessage } from "element-plus";
import { createExecutionClient, ExecutionRequestError, getExecutionClientId, isExecutableNode, type NodeCatalogEntry } from "@toonflow/nodes-scaffold/runtime";
import type { CanvasCommand, CanvasCommandResult, NodeExecutionDescriptor, NodeActionEditor } from "@toonflow/nodes-scaffold/execution";
import useWorkspaceFiles, { type WorkspaceGraph } from "@/lib/workspaceFiles";
import { readWorkspaceDraft, readWorkspaceDrafts, removeWorkspaceDraft, saveWorkspaceDraft } from "@/lib/workspaceDrafts";
import { isEqual } from "lodash-es";
import type { CanvasNode } from "../lib/mobileGraphModel";

type ParameterSchema = { type?: string | string[]; title?: string; description?: string; default?: unknown; enum?: any[]; minimum?: number; maximum?: number; minLength?: number; maxLength?: number; pattern?: string; $ref?: string; oneOf?: unknown; anyOf?: unknown };
type EditorAction = NodeExecutionDescriptor["actions"][number];
type EditorField = { name: string; schema: ParameterSchema; required: boolean; editor?: NonNullable<NodeActionEditor["fields"]>[string] };
type EditorDraft = { values: Record<string, any>; jsonValues: Record<string, string>; baseVersion: number; baselineValues?: Record<string, any>; ownerId?: string; draftId?: string; editedAt?: number };
type EditorCommand = { command: CanvasCommand; sent: EditorDraft; createdAt?: number };
type EditorSection = EditorDraft & { action: EditorAction; fields: EditorField[]; current: unknown; readVersion?: number; readWithoutVersion?: boolean; dirty: boolean; loading: boolean; ready: boolean; saving: boolean; readRevision: number; error: string; reviewing: boolean; remote?: EditorDraft; pending?: CanvasCommand; sent?: EditorDraft; pendingCommands: EditorCommand[] };
type ModelChoice = Record<string, any>;

const props = defineProps<{ directory: string; canvasPath: string; node: CanvasNode; graph: WorkspaceGraph; catalog: NodeCatalogEntry[] }>();
const emit = defineEmits<{ changed: [] }>();
const descriptor = computed(() => {
  const entry = props.catalog.find(item => `remote-${item.name}` === props.node.type);
  return entry && isExecutableNode(entry) ? entry : undefined;
});
const sections = ref<EditorSection[]>([]);
const error = ref("");
const editorOwnerId = crypto.randomUUID();
let connection: AbortController | undefined;
const reads = new WeakMap<EditorSection, Promise<boolean>>();
const readGenerations = new WeakMap<EditorSection, number>();
let readGeneration = 0;
const ownVersions = new Map<number, number>();
const binding = computed(() => JSON.stringify([props.directory, props.canvasPath, props.node.id, descriptor.value?.executionRevision]));

function at(value: unknown, path?: string): any {
  return path?.split(".").reduce((current: any, key) => current && typeof current === "object" && Object.hasOwn(current, key) ? current[key] : undefined, value);
}
function isJson(field: EditorField) {
  return Array.isArray(field.schema.type) || field.schema.type === "null" || field.schema.type === "object" || field.schema.type === "array" || !!(field.schema.$ref || field.schema.oneOf || field.schema.anyOf);
}
function isNullableBoolean(field: EditorField) { return Array.isArray(field.schema.type) && field.schema.type.includes("boolean") && field.schema.type.includes("null") && field.schema.type.length === 2; }
function canClear(field: EditorField) {
  return field.schema.type === "string" && !field.required && !field.schema.minLength && !field.schema.pattern && (!field.schema.enum || field.schema.enum.includes(""));
}
function draftKind(section: EditorSection) { return `nodeEditor:${props.node.id}:${section.action.name}`; }
function migrationKind(section: EditorSection) { return `nodeEditorMigrated:${props.node.id}:${section.action.name}`; }
function commandKind(section: EditorSection, command?: CanvasCommand) { return `nodeEditorCommand:${String(command?.args.nodeId ?? props.node.id)}:${section.action.name}`; }
function clearSectionCommand(section: EditorSection, command: CanvasCommand) {
  const kind = commandKind(section, command);
  removeWorkspaceDraft(command.directory, command.canvasPath, `${kind}:${command.commandId}`);
  const saved = readWorkspaceDraft<{ command: CanvasCommand }>(command.directory, command.canvasPath, kind);
  if (saved?.command?.commandId === command.commandId) saveWorkspaceDraft(command.directory, command.canvasPath, `${kind}:settled:${command.commandId}`, true);
  section.pendingCommands = section.pendingCommands.filter(item => item.command.commandId !== command.commandId);
  section.pending = section.pendingCommands[0]?.command;
  section.sent = section.pendingCommands[0]?.sent;
}
function changeSection(section: EditorSection, userEdit = true) {
  if (userEdit) section.ownerId = editorOwnerId;
  section.dirty = true;
  const previousId = section.draftId;
  const draft = { ...draftOf(section), draftId: crypto.randomUUID(), editedAt: userEdit ? Math.max(Date.now(), (section.editedAt ?? 0) + 1) : section.editedAt ?? 0 };
  try {
    // ACT: 键永不复用，跨标签只删除自己观察过的快照；内部版本更新不提高草稿的编辑优先级。
    saveWorkspaceDraft(props.directory, props.canvasPath, `${draftKind(section)}:${draft.draftId}`, draft);
    saveWorkspaceDraft(props.directory, props.canvasPath, migrationKind(section), true);
    section.draftId = draft.draftId;
    section.editedAt = draft.editedAt;
    if (previousId) removeWorkspaceDraft(props.directory, props.canvasPath, `${draftKind(section)}:${previousId}`);
    return true;
  } catch (reason) { section.error = reason instanceof Error ? reason.message : "编辑草稿保存失败"; return false; }
}
function snapshotFor(section: EditorSection, graph?: WorkspaceGraph): EditorDraft {
  const values: Record<string, any> = {};
  const jsonValues: Record<string, string> = {};
  for (const field of section.fields) {
    const source = section.action.editor?.values?.[field.name];
    const node = graph ? graph.nodes.find(item => item.id === props.node.id) : props.node;
    const mapped = source?.result ? at(section.current, source.result) : source?.node ? at(node, source.node) : undefined;
    const value = mapped === undefined ? field.schema.default : mapped;
    if (value === undefined) continue;
    values[field.name] = JSON.parse(JSON.stringify(value));
    if (isJson(field)) jsonValues[field.name] = JSON.stringify(value, null, 2);
  }
  const nodeVersion = at(section.current, "nodeVersion");
  const baseVersion = section.action.editor?.readAction ? (Number.isSafeInteger(nodeVersion) && nodeVersion >= 0 ? nodeVersion : section.readVersion ?? section.baseVersion) : (graph ?? props.graph).toonflowGraph.nodes[props.node.id] ?? 0;
  return { values, jsonValues, baseVersion, baselineValues: JSON.parse(JSON.stringify(values)) };
}
function fillSection(section: EditorSection, graph?: WorkspaceGraph) {
  const remote = snapshotFor(section, graph);
  section.remote = remote;
  if (section.dirty || section.pending) {
    let version = section.baseVersion;
    while (ownVersions.has(version) && ownVersions.get(version)! > version) version = ownVersions.get(version)!;
    if (!section.pending && !section.saving && version > section.baseVersion && version === remote.baseVersion && isEqual(section.baselineValues, remote.values)) {
      section.baseVersion = version;
      changeSection(section, false);
    }
    return;
  }
  Object.assign(section, remote);
}
function models(section: EditorSection, field: EditorField): ModelChoice[] {
  const source = at(section.current, field.editor?.model?.sourcePath);
  const providerField = field.editor?.model?.providerField;
  return Array.isArray(source) ? source.filter(item => item && (typeof item.providerId === "string" && typeof item.modelId === "string" || typeof item[field.name] === "string" && (!providerField || typeof item[providerField] === "string"))) : [];
}
function modelOptionValue(model: ModelChoice, field: EditorField) {
  const providerField = field.editor?.model?.providerField;
  if (!providerField) return typeof model[field.name] === "string" ? model[field.name] : JSON.stringify([model.providerId, model.modelId]);
  const standardModel = typeof model.providerId === "string" && typeof model.modelId === "string";
  return JSON.stringify(standardModel ? [model.providerId, model.modelId] : [model[providerField], model[field.name]]);
}
function modelValue(section: EditorSection, field: EditorField) {
  const providerField = field.editor?.model?.providerField;
  return providerField ? section.values[field.name] ? JSON.stringify([section.values[providerField], section.values[field.name]]) : "" : section.values[field.name] ?? "";
}
function choices(section: EditorSection, field: EditorField): any[] {
  const config = field.editor?.choices;
  if (!config) return field.schema.enum ?? [];
  let source = at(section.current, config.sourcePath);
  if (config.modelProperty && Array.isArray(source)) {
    const modelField = section.fields.find(item => item.editor?.model?.sourcePath === config.sourcePath);
    const selected = modelField && source.find(model => modelOptionValue(model, modelField) === modelValue(section, modelField));
    source = at(selected, config.modelProperty);
  }
  if (!Array.isArray(source)) return [];
  if (config.dependentField && config.dependentProperty) source = source.filter(item => {
    const allowed = at(item, config.dependentProperty);
    return Array.isArray(allowed) ? allowed.some(value => isEqual(value, section.values[config.dependentField!])) : isEqual(allowed, section.values[config.dependentField!]);
  });
  const values: any[] = config.valueProperty ? source.flatMap((item: unknown) => { const value = at(item, config.valueProperty); return Array.isArray(value) ? value : value === undefined ? [] : [value]; }) : source;
  return [...new Map(values.map((value: any) => [JSON.stringify(value), value])).values()];
}
function changeModel(section: EditorSection, field: EditorField, value: string) {
  const providerField = field.editor?.model?.providerField;
  if (providerField) {
    const pair = value ? JSON.parse(value) : [undefined, undefined];
    section.values[providerField] = pair[0];
    section.values[field.name] = pair[1];
  } else section.values[field.name] = value || "";
  for (const item of section.fields.filter(item => item.editor?.choices?.modelProperty && item.editor.choices.sourcePath === field.editor?.model?.sourcePath)) {
    const options = choices(section, item);
    if (!options.some(option => isEqual(option, section.values[item.name]))) { delete section.values[item.name]; delete section.jsonValues[item.name]; }
  }
  changeSection(section);
}
function changeChoice(section: EditorSection, field: EditorField, value: string) {
  section.values[field.name] = value ? JSON.parse(value) : canClear(field) ? "" : undefined;
  for (const item of section.fields.filter(item => item.editor?.choices?.dependentField === field.name)) {
    if (!choices(section, item).some(option => isEqual(option, section.values[item.name]))) { delete section.values[item.name]; delete section.jsonValues[item.name]; }
  }
  changeSection(section);
}
function argsFor(section: EditorSection) {
  const args: Record<string, unknown> = {};
  for (const field of section.fields) {
    let value = section.values[field.name];
    if (isJson(field) && !isNullableBoolean(field) && !field.editor?.choices && !field.schema.enum) value = section.jsonValues[field.name]?.trim() ? JSON.parse(section.jsonValues[field.name]) : undefined;
    if (value === undefined || value === null && !isJson(field) && !field.schema.enum?.includes(null) || value === "" && !field.required && !canClear(field) && (field.editor?.choices || field.editor?.model)) continue;
    args[field.name] = value;
  }
  return args;
}
function draftOf(section: EditorSection): EditorDraft { return JSON.parse(JSON.stringify({ values: section.values, jsonValues: section.jsonValues, baseVersion: section.baseVersion, baselineValues: section.baselineValues, ownerId: section.ownerId, draftId: section.draftId, editedAt: section.editedAt })); }
function commandFor(name: string, args: Record<string, unknown>, baseVersion?: number): CanvasCommand {
  if (!descriptor.value) throw new Error("节点执行描述尚未加载");
  return {
    directory: props.directory, canvasPath: props.canvasPath, commandId: crypto.randomUUID(), name: "nodeTools",
    args: { nodeId: props.node.id, name: name.startsWith("node:") ? name : `node:${name}`, args, expectedNodeRevision: descriptor.value.executionRevision },
    ...(baseVersion !== undefined ? { expectedVersions: { [props.node.id]: baseVersion } } : {}),
    clientContext: { clientId: getExecutionClientId() },
  };
}
async function readSection(section: EditorSection, signal: AbortSignal, graph?: WorkspaceGraph, afterRead?: number): Promise<boolean> {
  if (!section.action.editor?.readAction) { fillSection(section, graph); return true; }
  const running = reads.get(section);
  if (running) {
    if (afterRead === undefined || readGenerations.get(section)! > afterRead) return running;
    await running;
    if (signal.aborted) return false;
    return readSection(section, signal, graph, afterRead);
  }
  readGenerations.set(section, ++readGeneration);
  const read = readCurrentSection(section, signal, graph);
  reads.set(section, read);
  try { return await read; } finally { if (reads.get(section) === read) reads.delete(section); }
}
async function readCurrentSection(section: EditorSection, signal: AbortSignal, graph?: WorkspaceGraph): Promise<boolean> {
  const revision = ++section.readRevision;
  section.loading = true;
  try {
    const client = createExecutionClient(props.directory);
    const readAction = section.action.editor!.readAction!;
    let current = section.readWithoutVersion ? undefined : await client.execute(commandFor(readAction, {}), signal);
    let readVersion: number | undefined;
    signal.throwIfAborted();
    const nodeVersion = at(current, "nodeVersion");
    if (section.readWithoutVersion || !Number.isSafeInteger(nodeVersion) || nodeVersion < 0) {
      graph = await useWorkspaceFiles(props.directory).readGraph(props.canvasPath, signal);
      signal.throwIfAborted();
      readVersion = graph.toonflowGraph.nodes[props.node.id];
      if (!graph.nodes.some(node => node.id === props.node.id) || !Number.isSafeInteger(readVersion) || readVersion! < 0) throw new Error("节点版本无法确认，草稿已保留");
      // ACT: 无版本结果仅绑定执行前的图版本；CAS 读取失败时保留原草稿，不能采用响应时的最新版本。
      current = await client.execute(commandFor(readAction, {}, readVersion), signal);
    }
    signal.throwIfAborted();
    if (revision !== section.readRevision) return false;
    section.current = current;
    section.readVersion = readVersion;
    section.readWithoutVersion = !Number.isSafeInteger(at(current, "nodeVersion")) || at(current, "nodeVersion") < 0;
    section.ready = true;
    section.error = "";
    fillSection(section, graph);
    return true;
  } catch (reason) {
    if (!signal.aborted && revision === section.readRevision) section.error = reason instanceof Error ? reason.message : "节点信息读取失败";
    return false;
  } finally { if (revision === section.readRevision) section.loading = false; }
}
async function retryRead(section: EditorSection) {
  if (!connection || section.loading || section.saving || section.pending) return;
  const signal = connection.signal;
  section.reviewing = true;
  section.remote = undefined;
  section.loading = true;
  try {
    const graph = await useWorkspaceFiles(props.directory).readGraph(props.canvasPath, signal);
    signal.throwIfAborted();
    if (!graph.nodes.some(node => node.id === props.node.id)) throw new Error("节点已不存在，草稿已保留");
    if (await readSection(section, signal, graph)) { section.ready = true; section.error = ""; }
  } catch (reason) { if (!signal.aborted) section.error = reason instanceof Error ? reason.message : "节点信息读取失败"; }
  finally { if (!signal.aborted) section.loading = false; }
}
function remoteValues(section: EditorSection) {
  return Object.fromEntries(section.fields.filter(field => !field.editor?.hidden).map(field => [field.editor?.label || field.schema.title || field.name, section.remote?.values[field.name]]));
}
function acceptRemote(section: EditorSection) {
  if (!section.remote || section.loading || section.saving || section.pending) return;
  section.baseVersion = section.remote.baseVersion;
  section.baselineValues = section.remote.baselineValues;
  for (const name of ["expectedRevision", "expectedOutput"]) {
    if (!section.fields.some(field => field.name === name && field.editor?.hidden)) continue;
    section.values[name] = section.remote.values[name];
    if (section.remote.jsonValues[name] !== undefined) section.jsonValues[name] = section.remote.jsonValues[name];
  }
  section.reviewing = false;
  section.error = "";
  changeSection(section);
}
async function finishSection(section: EditorSection, response: CanvasCommandResult, signal: AbortSignal) {
  if (!section.pending || response.commandId !== section.pending.commandId) return;
  if (response.status === "accepted" || response.status === "running") return;
  const command = section.pending;
  const sent = section.sent;
  clearSectionCommand(section, command);
  if (response.status !== "completed") { section.error = response.errorMessage || "保存失败，编辑草稿已保留"; return; }
  if (sent?.draftId) removeWorkspaceDraft(command.directory, command.canvasPath, `${draftKind(section)}:${sent.draftId}`);
  if (!sent?.draftId || !section.ownerId || section.ownerId !== sent.ownerId) {
    section.error = "原保存已完成，当前草稿已保留，请核对最新内容后接受当前版本";
    emit("changed");
    return;
  }
  const unchanged = isEqual(draftOf(section), sent);
  const version = at(response.result, "nodeVersion") ?? at(response.result, "version");
  if (Number.isSafeInteger(version) && version >= 0) {
    const previousVersion = command.expectedVersions?.[String(command.args.nodeId)];
    if (previousVersion !== undefined && version > previousVersion) ownVersions.set(previousVersion, version);
    section.baseVersion = version;
  }
  const contentRevision = at(response.result, "revision");
  if (typeof contentRevision === "string" && section.fields.some(field => field.name === "expectedRevision" && field.editor?.hidden)) section.values.expectedRevision = contentRevision;
  if (section.fields.some(field => field.name === "expectedOutput" && field.editor?.hidden) && at(response.result, "dataType")) {
    section.values.expectedOutput = { dataType: at(response.result, "dataType"), value: at(response.result, "value") };
    section.jsonValues.expectedOutput = JSON.stringify(section.values.expectedOutput);
  }
  section.baselineValues = JSON.parse(JSON.stringify({ ...sent?.values, ...at(command, "args.args"), ...Object.fromEntries(["expectedRevision", "expectedOutput"].filter(name => section.values[name] !== undefined && section.fields.some(field => field.name === name && field.editor?.hidden)).map(name => [name, section.values[name]])) }));
  if (unchanged) {
    section.dirty = false;
    section.draftId = undefined;
    section.editedAt = undefined;
    if (section.action.editor?.readAction) await readSection(section, signal);
    else if (!Number.isSafeInteger(version) || version < 0) {
      const graph = await useWorkspaceFiles(command.directory).readGraph(command.canvasPath, signal);
      signal.throwIfAborted();
      if (!graph.nodes.some(node => node.id === props.node.id)) throw new Error("节点已不存在，草稿已保留");
      fillSection(section, graph);
    }
  } else {
    section.dirty = true;
    changeSection(section, false);
  }
  signal.throwIfAborted();
  section.error = "";
  section.reviewing = false;
  emit("changed");
  const siblings = sections.value.filter(item => item !== section && item.dirty && !item.pending && !item.saving);
  if (siblings.length) {
    try {
      const graph = await useWorkspaceFiles(command.directory).readGraph(command.canvasPath, signal);
      signal.throwIfAborted();
      const afterRead = readGeneration;
      await Promise.all(siblings.map(item => readSection(item, signal, graph, afterRead)));
    } catch (reason) { if (!signal.aborted) for (const item of siblings) item.error = reason instanceof Error ? reason.message : "草稿版本核对失败，草稿已保留"; }
  }
  ElMessage.success("已保存节点信息");
}
async function settleSection(section: EditorSection, response: CanvasCommandResult, signal: AbortSignal) {
  const client = createExecutionClient(section.pending!.directory);
  const deadline = Date.now() + 20000;
  while ((response.status === "accepted" || response.status === "running") && Date.now() < deadline) {
    await new Promise<void>(resolve => setTimeout(resolve, 500));
    signal.throwIfAborted();
    response = await client.getCommand(response.commandId, signal) ?? response;
  }
  await finishSection(section, response, signal);
}
async function saveSection(section: EditorSection) {
  if (sections.value.some(item => item.saving) || !section.ready || section.loading || section.pending || !section.dirty || !connection) return;
  const signal = connection.signal;
  section.saving = true;
  section.error = "";
  try {
    if (!Number.isSafeInteger(section.baseVersion) || section.baseVersion < 0) throw new Error("草稿缺少原节点版本，请保留草稿并重新核对节点信息");
    if (section.action.editor?.readAction && section.action.editor.values?.expectedRevision?.result && section.fields.some(field => field.name === "expectedRevision" && field.editor?.hidden) && [undefined, null, ""].includes(section.values.expectedRevision)) throw new Error("草稿缺少原文件版本，请保留草稿并重新核对正文");
    if (!section.draftId && !changeSection(section, false)) throw new Error(section.error);
    saveWorkspaceDraft(props.directory, props.canvasPath, migrationKind(section), true);
    const command = commandFor(section.action.name, argsFor(section), section.baseVersion);
    section.sent = draftOf(section);
    const pending = { command, sent: section.sent, createdAt: Date.now() };
    saveWorkspaceDraft(command.directory, command.canvasPath, `${commandKind(section, command)}:${command.commandId}`, pending);
    section.pendingCommands.push(pending);
    section.pending = command;
    const response = await createExecutionClient(command.directory).command(command, signal);
    signal.throwIfAborted();
    await settleSection(section, response, signal);
  } catch (reason) {
    if (signal.aborted) return;
    if (reason instanceof ExecutionRequestError && reason.status >= 400 && reason.status < 500 && section.pending) {
      clearSectionCommand(section, section.pending);
    }
    section.error = reason instanceof Error ? reason.message : "保存结果待确认，原命令和草稿已保留";
  } finally { if (!signal.aborted) section.saving = false; }
}
async function reconcileSection(section: EditorSection) {
  if (!section.pending || sections.value.some(item => item.saving) || !connection) return;
  const signal = connection.signal;
  const command = section.pending;
  section.saving = true;
  try {
    const client = createExecutionClient(command.directory);
    while (section.pending) {
      const pending: CanvasCommand = section.pending;
      const response = await client.getCommand(pending.commandId, signal) ?? await client.command(pending, signal);
      signal.throwIfAborted();
      await settleSection(section, response, signal);
      if (section.pending?.commandId === pending.commandId) break;
    }
  } catch (reason) { if (!signal.aborted) section.error = reason instanceof Error ? reason.message : "保存核对失败，草稿已保留"; }
  finally { if (!signal.aborted) section.saving = false; }
}

watch(binding, async () => {
  connection?.abort();
  const current = new AbortController();
  connection = current;
  ownVersions.clear();
  error.value = "";
  sections.value = (descriptor.value?.actions ?? []).filter(action => action.editor).map(action => {
    const fields = Object.entries(action.parameters.properties ?? {}).map(([name, schema]) => ({ name, schema: schema as ParameterSchema, required: Array.isArray(action.parameters.required) && action.parameters.required.includes(name), editor: action.editor?.fields?.[name] }));
    return { action, fields, current: undefined, values: {}, jsonValues: {}, baseVersion: props.graph.toonflowGraph.nodes[props.node.id] ?? 0, ownerId: editorOwnerId, dirty: false, loading: false, ready: !action.editor?.readAction, saving: false, readRevision: 0, error: "", reviewing: false, pendingCommands: [] };
  });
  for (const section of sections.value) {
    try {
      const snapshots = readWorkspaceDrafts<EditorDraft>(props.directory, props.canvasPath, `${draftKind(section)}:`).filter(item => typeof item.value?.draftId === "string" && item.kind === `${draftKind(section)}:${item.value.draftId}`).map(item => item.value);
      const draft = snapshots.sort((left, right) => (right.editedAt ?? 0) - (left.editedAt ?? 0) || right.draftId!.localeCompare(left.draftId!))[0]
        ?? (readWorkspaceDraft<boolean>(props.directory, props.canvasPath, migrationKind(section)) ? undefined : readWorkspaceDraft<EditorDraft>(props.directory, props.canvasPath, draftKind(section)));
      if (draft) { Object.assign(section, draft); section.dirty = true; }
      const kind = commandKind(section);
      const legacy = readWorkspaceDraft<EditorCommand>(props.directory, props.canvasPath, kind);
      const pending = [...(legacy && !readWorkspaceDraft<boolean>(props.directory, props.canvasPath, `${kind}:settled:${legacy.command.commandId}`) ? [legacy] : []), ...readWorkspaceDrafts<EditorCommand>(props.directory, props.canvasPath, `${kind}:`).map(item => item.value)];
      section.pendingCommands = [...new Map(pending.filter(item => item?.command?.directory === props.directory && item.command.canvasPath === props.canvasPath && item.command.args.nodeId === props.node.id && item.command.args.name === `node:${section.action.name}`).map(item => [item.command.commandId, item])).values()].sort((left, right) => (left.createdAt ?? 0) - (right.createdAt ?? 0));
      section.pending = section.pendingCommands[0]?.command;
      section.sent = section.pendingCommands[0]?.sent;
      if (!draft && section.sent) { Object.assign(section, section.sent); section.dirty = true; }
    } catch (reason) { section.dirty = true; section.error = reason instanceof Error ? reason.message : "节点草稿无法读取"; }
    if (!section.action.editor?.readAction) fillSection(section);
  }
  for (const section of sections.value) {
    await readSection(section, current.signal);
    if (current.signal.aborted) return;
    if (section.pending) await reconcileSection(section);
  }
}, { immediate: true });
async function refresh(signal?: AbortSignal, contentOnly = false, fresh = false): Promise<boolean> {
  if (!connection) return false;
  const current = signal ? AbortSignal.any([connection.signal, signal]) : connection.signal;
  const afterRead = fresh ? readGeneration : undefined;
  const results = await Promise.all(sections.value.filter(section => !section.dirty && !section.pending && !section.saving && (!contentOnly || section.fields.some(field => field.name === "expectedRevision"))).map(section => readSection(section, current, undefined, afterRead)));
  return !current.aborted && results.every(Boolean);
}
watch(() => props.node, () => { void refresh(); });
defineExpose({ refresh: (signal?: AbortSignal, contentOnly = true) => refresh(signal, contentOnly, true) });
onScopeDispose(() => connection?.abort());
</script>

<style scoped lang="scss">
.mobileNodeEditor {
  margin-top: 12px;
  .editorSection {
    border-bottom: 1px solid var(--el-border-color-lighter);
    padding-bottom: 12px;
    &:last-child { border-bottom: 0; }
    h3 { font-size: 15px; margin: 12px 0; }
    .el-select { width: 100%; }
    .fieldDescription { font-size: 12px; color: var(--el-text-color-secondary); }
    .sectionActions { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 8px; }
    .remotePreview {
      margin-bottom: 12px;
      p { font-size: 12px; color: var(--el-text-color-secondary); }
      pre { max-height: 240px; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; }
    }
  }
}
</style>
