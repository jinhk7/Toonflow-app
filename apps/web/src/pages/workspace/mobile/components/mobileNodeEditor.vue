<template>
  <el-card v-if="sections.length" class="mobileNodeEditor" shadow="never">
    <template #header>节点编辑</template>
    <el-alert v-if="error" :title="error" type="error" :closable="false" showIcon />
    <el-form v-for="section in sections" :key="section.action.name" class="editorSection" labelPosition="top" :disabled="!section.ready && !section.dirty" @submit.prevent="saveSection(section)">
      <h3>{{ section.action.editor?.label }}</h3>
      <el-form-item v-for="field in section.fields.filter(item => !item.editor?.hidden)" :key="field.name" :label="field.editor?.label || field.schema.title || field.name" :required="field.required">
        <el-select v-if="field.editor?.model" :modelValue="modelValue(section, field)" :clearable="canClear(field)" @change="value => changeModel(section, field, value)">
          <el-option v-for="model in models(section, field)" :key="JSON.stringify([model.providerId, model.modelId])" :label="model.name || model.modelName || model.modelId" :value="JSON.stringify([model.providerId, model.modelId])" />
        </el-select>
        <el-select v-else-if="field.editor?.choices || field.schema.enum" :modelValue="section.values[field.name] === '' ? undefined : JSON.stringify(section.values[field.name])" :clearable="canClear(field)" @change="value => changeChoice(section, field, value)">
          <el-option v-for="value in choices(section, field)" :key="JSON.stringify(value)" :label="value?.label || (typeof value === 'string' ? value : JSON.stringify(value))" :value="JSON.stringify(value?.value ?? value)" />
        </el-select>
        <el-switch v-else-if="field.schema.type === 'boolean'" v-model="section.values[field.name]" @change="changeSection(section)" />
        <el-input-number v-else-if="['number', 'integer'].includes(field.schema.type || '')" v-model="section.values[field.name]" :min="field.schema.minimum" :max="field.schema.maximum" :precision="field.schema.type === 'integer' ? 0 : undefined" @change="changeSection(section)" />
        <el-input v-else-if="isJson(field)" v-model="section.jsonValues[field.name]" type="textarea" :autosize="{ minRows: 3, maxRows: 16 }" @input="changeSection(section)" />
        <el-input v-else v-model="section.values[field.name]" :maxlength="field.schema.maxLength" :type="field.editor?.multiline ? 'textarea' : 'text'" :autosize="field.editor?.multiline ? { minRows: 4, maxRows: 16 } : undefined" @input="changeSection(section)" />
        <p v-if="field.schema.description" class="fieldDescription">{{ field.schema.description }}</p>
      </el-form-item>
      <div class="sectionActions">
        <el-button type="primary" nativeType="submit" :loading="section.saving" :disabled="!section.ready || section.loading || !!section.pending || !section.dirty">保存{{ section.action.editor?.label }}</el-button>
        <el-button v-if="section.pending" :loading="section.saving" @click="reconcileSection(section)">核对原保存</el-button>
        <el-button v-if="section.error && !section.dirty && section.action.editor?.readAction" :loading="section.loading" :disabled="false" @click="retryRead(section)">重新读取节点信息</el-button>
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
import type { WorkspaceGraph } from "@/lib/workspaceFiles";
import { readWorkspaceDraft, removeWorkspaceDraft, saveWorkspaceDraft } from "@/lib/workspaceDrafts";
import { isEqual } from "lodash-es";
import type { CanvasNode } from "../lib/mobileGraphModel";

type ParameterSchema = { type?: string; title?: string; description?: string; default?: unknown; enum?: any[]; minimum?: number; maximum?: number; minLength?: number; maxLength?: number; pattern?: string; $ref?: string; oneOf?: unknown; anyOf?: unknown };
type EditorAction = NodeExecutionDescriptor["actions"][number];
type EditorField = { name: string; schema: ParameterSchema; required: boolean; editor?: NonNullable<NodeActionEditor["fields"]>[string] };
type EditorDraft = { values: Record<string, any>; jsonValues: Record<string, string>; baseVersion: number };
type EditorSection = EditorDraft & { action: EditorAction; fields: EditorField[]; current: unknown; dirty: boolean; loading: boolean; ready: boolean; saving: boolean; readRevision: number; error: string; pending?: CanvasCommand; sent?: EditorDraft };
type ModelChoice = { providerId: string; modelId: string; name?: string; modelName?: string; [key: string]: any };

const props = defineProps<{ directory: string; canvasPath: string; node: CanvasNode; graph: WorkspaceGraph; catalog: NodeCatalogEntry[] }>();
const emit = defineEmits<{ changed: [] }>();
const descriptor = computed(() => {
  const entry = props.catalog.find(item => `remote-${item.name}` === props.node.type);
  return entry && isExecutableNode(entry) ? entry : undefined;
});
const sections = ref<EditorSection[]>([]);
const error = ref("");
let connection: AbortController | undefined;
const binding = computed(() => JSON.stringify([props.directory, props.canvasPath, props.node.id, descriptor.value?.executionRevision]));

function at(value: unknown, path?: string): any {
  return path?.split(".").reduce((current: any, key) => current && typeof current === "object" && Object.hasOwn(current, key) ? current[key] : undefined, value);
}
function isJson(field: EditorField) {
  return ["object", "array"].includes(field.schema.type ?? "") || !!(field.schema.$ref || field.schema.oneOf || field.schema.anyOf);
}
function canClear(field: EditorField) {
  return field.schema.type === "string" && !field.required && !field.schema.minLength && !field.schema.pattern && (!field.schema.enum || field.schema.enum.includes(""));
}
function draftKind(section: EditorSection) { return `nodeEditor:${props.node.id}:${section.action.name}`; }
function clearSectionCommand(section: EditorSection, command: CanvasCommand) {
  const kind = `nodeEditorCommand:${String(command.args.nodeId)}:${section.action.name}`;
  const saved = readWorkspaceDraft<{ command: CanvasCommand }>(command.directory, command.canvasPath, kind);
  if (saved?.command?.commandId === command.commandId) removeWorkspaceDraft(command.directory, command.canvasPath, kind);
  if (section.pending?.commandId === command.commandId) section.pending = undefined;
}
function changeSection(section: EditorSection) {
  section.dirty = true;
  try { saveWorkspaceDraft(props.directory, props.canvasPath, draftKind(section), draftOf(section)); }
  catch (reason) { section.error = reason instanceof Error ? reason.message : "编辑草稿保存失败"; }
}
function fillSection(section: EditorSection) {
  if (section.dirty || section.pending) return;
  const values: Record<string, any> = {};
  const jsonValues: Record<string, string> = {};
  for (const field of section.fields) {
    const source = section.action.editor?.values?.[field.name];
    const mapped = source?.result ? at(section.current, source.result) : source?.node ? at(props.node, source.node) : undefined;
    const value = mapped === undefined ? field.schema.default : mapped;
    if (value === undefined) continue;
    values[field.name] = JSON.parse(JSON.stringify(value));
    if (isJson(field)) jsonValues[field.name] = JSON.stringify(value, null, 2);
  }
  section.values = values;
  section.jsonValues = jsonValues;
  section.baseVersion = section.action.editor?.readAction ? (at(section.current, "nodeVersion") ?? section.baseVersion) : props.graph.toonflowGraph.nodes[props.node.id] ?? 0;
}
function models(section: EditorSection, field: EditorField): ModelChoice[] {
  const source = at(section.current, field.editor?.model?.sourcePath);
  return Array.isArray(source) ? source.filter(item => typeof item?.providerId === "string" && typeof item?.modelId === "string") : [];
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
    const selected = source.find(model => model.providerId === section.values.providerId && model.modelId === section.values.modelId);
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
    for (const item of section.fields.filter(item => item.editor?.choices?.modelProperty)) {
      const options = choices(section, item);
      if (!options.some(option => isEqual(option, section.values[item.name]))) { delete section.values[item.name]; delete section.jsonValues[item.name]; }
    }
  } else section.values[field.name] = value || "";
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
    if (isJson(field) && !field.editor?.choices && !field.schema.enum) value = section.jsonValues[field.name]?.trim() ? JSON.parse(section.jsonValues[field.name]) : undefined;
    if (value === undefined || value === null && !isJson(field) || value === "" && !field.required && !canClear(field) && (field.editor?.choices || field.editor?.model)) continue;
    args[field.name] = value;
  }
  return args;
}
function draftOf(section: EditorSection): EditorDraft { return JSON.parse(JSON.stringify({ values: section.values, jsonValues: section.jsonValues, baseVersion: section.baseVersion })); }
function commandFor(name: string, args: Record<string, unknown>, baseVersion?: number): CanvasCommand {
  if (!descriptor.value) throw new Error("节点执行描述尚未加载");
  return {
    directory: props.directory, canvasPath: props.canvasPath, commandId: crypto.randomUUID(), name: "nodeTools",
    args: { nodeId: props.node.id, name: name.startsWith("node:") ? name : `node:${name}`, args, expectedNodeRevision: descriptor.value.executionRevision },
    ...(baseVersion !== undefined ? { expectedVersions: { [props.node.id]: baseVersion } } : {}),
    clientContext: { clientId: getExecutionClientId() },
  };
}
async function readSection(section: EditorSection, signal: AbortSignal) {
  if (!section.action.editor?.readAction) { fillSection(section); return; }
  const revision = ++section.readRevision;
  section.loading = true;
  try {
    const current = await createExecutionClient(props.directory).execute(commandFor(section.action.editor.readAction, {}), signal);
    signal.throwIfAborted();
    if (revision !== section.readRevision) return;
    section.current = current;
    section.ready = true;
    section.error = "";
    fillSection(section);
  } catch (reason) {
    if (!signal.aborted && revision === section.readRevision) section.error = reason instanceof Error ? reason.message : "节点信息读取失败";
  } finally { if (!signal.aborted && revision === section.readRevision) section.loading = false; }
}
function retryRead(section: EditorSection) { if (connection) void readSection(section, connection.signal); }
async function finishSection(section: EditorSection, response: CanvasCommandResult, signal: AbortSignal) {
  if (!section.pending || response.commandId !== section.pending.commandId) return;
  if (response.status === "accepted" || response.status === "running") return;
  const command = section.pending;
  clearSectionCommand(section, command);
  if (response.status !== "completed") { section.error = response.errorMessage || "保存失败，编辑草稿已保留"; return; }
  const unchanged = isEqual(draftOf(section), section.sent);
  const version = at(response.result, "nodeVersion") ?? at(response.result, "version");
  if (Number.isSafeInteger(version)) section.baseVersion = version;
  const contentRevision = at(response.result, "revision");
  if (typeof contentRevision === "string" && section.fields.some(field => field.name === "expectedRevision")) section.values.expectedRevision = contentRevision;
  if (section.fields.some(field => field.name === "expectedOutput") && at(response.result, "dataType")) {
    section.values.expectedOutput = { dataType: at(response.result, "dataType"), value: at(response.result, "value") };
    section.jsonValues.expectedOutput = JSON.stringify(section.values.expectedOutput);
  }
  if (unchanged) {
    section.dirty = false;
    if (isEqual(readWorkspaceDraft<EditorDraft>(command.directory, command.canvasPath, draftKind(section)), section.sent)) removeWorkspaceDraft(command.directory, command.canvasPath, draftKind(section));
    if (section.action.editor?.readAction) await readSection(section, signal);
  } else {
    changeSection(section);
  }
  signal.throwIfAborted();
  section.error = "";
  emit("changed");
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
  if (section.saving || !section.ready || section.loading || section.pending || !section.dirty || !connection) return;
  const signal = connection.signal;
  section.saving = true;
  section.error = "";
  try {
    if (!Number.isSafeInteger(section.baseVersion) || section.baseVersion < 0) throw new Error("草稿缺少原节点版本，请保留草稿并重新核对节点信息");
    if (section.fields.some(field => field.name === "expectedRevision") && !/^[a-f0-9]{64}$/.test(section.values.expectedRevision ?? "")) throw new Error("草稿缺少原文件版本，请保留草稿并重新核对正文");
    const command = commandFor(section.action.name, argsFor(section), section.baseVersion);
    section.sent = draftOf(section);
    saveWorkspaceDraft(command.directory, command.canvasPath, `nodeEditorCommand:${props.node.id}:${section.action.name}`, { command, sent: section.sent });
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
  if (!section.pending || section.saving || !connection) return;
  const signal = connection.signal;
  const command = section.pending;
  section.saving = true;
  try {
    const client = createExecutionClient(command.directory);
    const response = await client.getCommand(command.commandId, signal) ?? await client.command(command, signal);
    signal.throwIfAborted();
    await settleSection(section, response, signal);
  } catch (reason) { if (!signal.aborted) section.error = reason instanceof Error ? reason.message : "保存核对失败，草稿已保留"; }
  finally { if (!signal.aborted) section.saving = false; }
}

watch(binding, async () => {
  connection?.abort();
  const current = new AbortController();
  connection = current;
  error.value = "";
  sections.value = (descriptor.value?.actions ?? []).filter(action => action.editor).map(action => {
    const fields = Object.entries(action.parameters.properties ?? {}).map(([name, schema]) => ({ name, schema: schema as ParameterSchema, required: Array.isArray(action.parameters.required) && action.parameters.required.includes(name), editor: action.editor?.fields?.[name] }));
    return { action, fields, current: undefined, values: {}, jsonValues: {}, baseVersion: props.graph.toonflowGraph.nodes[props.node.id] ?? 0, dirty: false, loading: false, ready: !action.editor?.readAction, saving: false, readRevision: 0, error: "" };
  });
  for (const section of sections.value) {
    try {
      const draft = readWorkspaceDraft<EditorDraft>(props.directory, props.canvasPath, draftKind(section));
      if (draft) { section.values = draft.values; section.jsonValues = draft.jsonValues; section.baseVersion = draft.baseVersion; section.dirty = true; }
      const pending = readWorkspaceDraft<{ command: CanvasCommand; sent: EditorDraft }>(props.directory, props.canvasPath, `nodeEditorCommand:${props.node.id}:${section.action.name}`);
      if (pending?.command?.directory === props.directory && pending.command.canvasPath === props.canvasPath && pending.command.args.nodeId === props.node.id) { section.pending = pending.command; section.sent = pending.sent; }
    } catch (reason) { section.dirty = true; section.error = reason instanceof Error ? reason.message : "节点草稿无法读取"; }
    if (!section.action.editor?.readAction) fillSection(section);
  }
  for (const section of sections.value) {
    await readSection(section, current.signal);
    if (current.signal.aborted) return;
    if (section.pending) await reconcileSection(section);
  }
}, { immediate: true });
async function refresh(contentOnly = false) {
  if (!connection) return;
  await Promise.all(sections.value.filter(section => !section.dirty && !section.pending && !section.saving && (!contentOnly || section.fields.some(field => field.name === "expectedRevision"))).map(section => readSection(section, connection!.signal)));
}
watch(() => props.node, () => { void refresh(); });
defineExpose({ refresh: () => refresh(true) });
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
  }
}
</style>
