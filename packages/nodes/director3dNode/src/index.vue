<template>
  <nodeSkeleton v-bind="nodeProps" style="width: 320px">
    <button v-loading="modelLoading" type="button" class="directorContent nopan" :disabled="modelLoading" :title="modelError || undefined" aria-label="打开导演台" @dblclick.stop @click.stop="openEditor">
      <img v-if="preview" class="scenePreview" :src="preview" alt="最后镜头" draggable="false" />
      <div v-else class="emptyPreview">
        <icon-cube3d-sphere :size="38" stroke="1.2" />
      </div>
    </button>
  </nodeSkeleton>
  <sceneEditor v-if="editing" v-model:anchors="anchors" v-model:prompt="prompt" v-model:model="model" v-model:lighting="lighting" v-model:sceneSettings="sceneSettings"
    :scene="scene" :result="selectedPlan" :models="models" :modelsLoading="modelsLoading" :addingMannequin="addingMannequin"
    :plans="plans" :selectedPlanId="preferences.selectedPlanId" :tasks="tasks"
    :exportingVideo="exportingVideo" :exportingImage="exportingImage" :exportProgress="exportProgress"
    @exportVideo="exportVideo" @exportImage="exportImage" @addMannequin="addMannequin"
    @selectPlan="selectPlan($event)" @loadModels="loadModels" @generate="generate" @editInstruction="setPrompt" @close="editing = false">
    <template #input>
      <referenceItem v-if="refList.length" v-model="refList" @preview="setReferencePreview" @remove="removeReference" />
      <promptInput v-model="promptModel" v-model:text="prompt" :references="referenceMentions" />
    </template>
  </sceneEditor>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, ref, shallowRef, watch } from "vue";
import { IconCube3dSphere } from "@tabler/icons-vue";
import { ElLoading, ElMessage } from "element-plus";
import { nodeSkeleton, useNode, useNodeReferences, useNodeExecution, createExecutionClient, type NodeAiModel } from "@toonflow/nodes-scaffold/runtime";
import type { NodeJobView } from "@toonflow/nodes-scaffold/execution";
import promptInput from "@toonflow/nodes-scaffold/promptInput";
import referenceItem from "@toonflow/nodes-scaffold/referenceItem";
import sceneEditor from "./sceneEditor.vue";
import { capturePreview, createStage, disposeStage, getSceneLighting, type LightingSettings, type SceneSettings } from "./scene";
import { prepareMotion, sampleMotion } from "./motion";
import { prepareSceneAnimation } from "./sceneAnimation";
import { anchorSchema, createEmptyScene, modelDocumentSchema, type ModelDocument, type CameraAnchor, type DirectorPlan, type DirectorGeneration } from "./document";

type PromptModel = NonNullable<InstanceType<typeof promptInput>["$props"]["modelValue"]>;
type ModelSnapshot = { path: string; revision: string; document: ModelDocument; directory: string; canvasPath: string };
defineOptions({ inheritAttrs: false, icon: IconCube3dSphere });
const { node, nodeProps, previewReady, ai } = useNode({ label: "3D导演台" });
const execution = useNodeExecution(node.id);
const vLoading = ElLoading.directive;
const data = computed(() => node.data as typeof node.data & Record<string, unknown>);
const modelDocument = shallowRef<ModelDocument>({ version: 1, scene: createEmptyScene(), plans: [] });
const scope = shallowRef<ModelSnapshot>();
const scene = computed(() => modelDocument.value.scene);
const plans = computed(() => modelDocument.value.plans);
const preferences = ref({ prompt: "", promptModel: [] as PromptModel, model: "", selectedPlanId: "", anchors: [] as CameraAnchor[],
  lighting: undefined as LightingSettings | undefined, sceneSettings: { gridVisible: true, skyVisible: true } as SceneSettings });
const selectedPlan = computed(() => plans.value.find(plan => plan.id === preferences.value.selectedPlanId));
const jobs = shallowRef<NodeJobView[]>([]);
const request = ref("");
const renderKinds = new Map<string, string>();
const instructions = new Map<string, string>();
const running = (job: NodeJobView) => job.status === "accepted" || job.status === "running";
const renderJobs = computed(() => jobs.value.filter(job => job.kind === "render" && running(job)));
const exportingVideo = computed(() => request.value === "video" || renderJobs.value.some(job => (renderKinds.get(job.jobId) ?? job.summary?.format) === "video"));
const exportingImage = computed(() => request.value.startsWith("image:") ? request.value.slice(6)
  : renderJobs.value.map(job => renderKinds.get(job.jobId) ?? (job.summary?.format === "image" ? `image:${job.summary.anchorId ?? ""}` : undefined)).find(kind => kind?.startsWith("image:"))?.slice(6) ?? "");
const exportProgress = computed(() => Math.max(0, ...renderJobs.value.map(job => (job.progress ?? 0) * 100)));
const tasks = computed<DirectorGeneration[]>(() => jobs.value.filter(job => job.kind === "directorDraft" && job.status !== "completed" && job.status !== "cancelled").map(job => ({
  id: job.jobId, instruction: instructions.get(job.jobId) ?? job.summary?.instruction ?? "", error: job.status === "failed" || job.status === "needsReview" ? job.errorMessage ?? job.status : undefined,
})));
const { refList, referenceMentions, setReferencePreview, removeReference } = useNodeReferences();
const editing = ref(false);
const addingMannequin = ref(false);
const modelsLoading = ref(false);
const models = ref<NodeAiModel[]>([]);
const selectedModel = computed(() => models.value.find(item => JSON.stringify([item.providerId, item.modelId]) === preferences.value.model));
const preview = ref("");
const modelLoading = ref(true);
const modelError = ref("");
const observer = new AbortController();
let disposed = false;
let modelVersion = 0;
let previewVersion = 0;
let jobVersion = 0;
let saveTimer: ReturnType<typeof setTimeout> | undefined;
let jobTimer: ReturnType<typeof setTimeout> | undefined;
let pendingPreferences: Record<string, unknown> = {};
let preferencesSaving: Promise<void> | undefined;

function syncPreferences() {
  if (preferencesSaving || Object.keys(pendingPreferences).length) return;
  const value = data.value;
  preferences.value = {
    prompt: typeof value.prompt === "string" ? value.prompt : "",
    promptModel: (value.promptModel ?? []) as PromptModel,
    model: typeof value.model === "string" ? value.model : "",
    selectedPlanId: typeof value.selectedPlanId === "string" ? value.selectedPlanId : "",
    anchors: (value.anchors ?? []) as CameraAnchor[], lighting: value.lighting as LightingSettings | undefined,
    sceneSettings: { gridVisible: true, skyVisible: true, ...(value.sceneSettings as Partial<SceneSettings> ?? {}) },
  };
}
function flushPreferences(): Promise<void> {
  clearTimeout(saveTimer);
  if (preferencesSaving) return preferencesSaving;
  if (!Object.keys(pendingPreferences).length) return Promise.resolve();
  preferencesSaving = (async () => {
    while (Object.keys(pendingPreferences).length) {
      const value = pendingPreferences;
      pendingPreferences = {};
      try { await execution.call("setPreferences", value); }
      catch (error) { pendingPreferences = { ...value, ...pendingPreferences }; throw error; }
    }
  })().finally(() => { preferencesSaving = undefined; syncPreferences(); });
  return preferencesSaving;
}
function updatePreferences(value: Partial<typeof preferences.value>) {
  preferences.value = { ...preferences.value, ...value };
  pendingPreferences = { ...pendingPreferences, ...value };
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => { void flushPreferences().catch(showError); }, 250);
}
function showError(error: unknown) { if (!disposed) ElMessage.error(error instanceof Error ? error.message : "操作失败"); }
const prompt = computed({ get: () => preferences.value.prompt, set: value => updatePreferences({ prompt: value }) });
const promptModel = computed({ get: () => preferences.value.promptModel, set: value => updatePreferences({ promptModel: value }) });
const model = computed({ get: () => preferences.value.model, set: value => updatePreferences({ model: value }) });
const anchors = computed({ get: () => preferences.value.anchors, set: value => updatePreferences({ anchors: value }) });
const lighting = computed({ get: () => ({ ...getSceneLighting(scene.value), ...preferences.value.lighting }), set: value => updatePreferences({ lighting: value }) });
const sceneSettings = computed({ get: () => preferences.value.sceneSettings, set: value => updatePreferences({ sceneSettings: value }) });
function selectPlan(value: string) { updatePreferences({ selectedPlanId: value }); }
function setPrompt(value: string) { updatePreferences({ prompt: value, promptModel: value ? value.split("\n").map(text => [{ type: "Write", text }]) : [] }); }

async function loadJobs() {
  clearTimeout(jobTimer);
  const current = scope.value;
  if (!current || disposed) return;
  const version = ++jobVersion;
  try {
    const value = await createExecutionClient(current.directory).listJobs(observer.signal);
    if (disposed || version !== jobVersion || scope.value !== current) return;
    jobs.value = value.filter(job => job.nodeId === node.id && job.canvasPath === current.canvasPath);
  } catch (error) { if (!observer.signal.aborted) showError(error); }
  finally { if (!disposed && (editing.value || jobs.value.some(running))) jobTimer = setTimeout(() => { void loadJobs(); }, 2000); }
}
async function loadDocument() {
  const version = ++modelVersion;
  modelLoading.value = true;
  modelError.value = "";
  try {
    const current = await execution.call<ModelSnapshot>("getDocument");
    const document = modelDocumentSchema.parse(current.document);
    if (disposed || version !== modelVersion) return;
    modelDocument.value = document;
    scope.value = current;
    syncPreferences();
    void loadJobs();
  } catch (error) { if (!disposed && version === modelVersion) modelError.value = error instanceof Error ? error.message : "模型加载失败"; }
  finally { if (!disposed && version === modelVersion) modelLoading.value = false; }
}
async function openEditor() {
  if (modelLoading.value || modelError.value) return;
  editing.value = true;
  await loadModels();
  void loadJobs();
}
async function loadModels() {
  if (modelsLoading.value) return;
  modelsLoading.value = true;
  try {
    const value = await ai.getModels();
    if (!disposed) {
      models.value = value;
      if (!preferences.value.model && value[0]) preferences.value.model = JSON.stringify([value[0].providerId, value[0].modelId]);
    }
  }
  catch (error) { showError(error); }
  finally { if (!disposed) modelsLoading.value = false; }
}
async function addMannequin() {
  if (addingMannequin.value) return;
  addingMannequin.value = true;
  try { await flushPreferences(); await execution.call("addMannequin"); await loadDocument(); }
  catch (error) { showError(error); }
  finally { if (!disposed) addingMannequin.value = false; }
}
async function generate() {
  const choice = selectedModel.value;
  const instruction = prompt.value.trim();
  if (!choice || !instruction || request.value || modelLoading.value || modelError.value) return;
  request.value = "generate";
  try {
    await flushPreferences();
    const job = await execution.call<NodeJobView>("generate", { instruction, providerId: choice.providerId, modelId: choice.modelId });
    if (disposed) return;
    instructions.set(job.jobId, instruction);
    jobs.value = [...jobs.value.filter(item => item.jobId !== job.jobId), job];
    ++jobVersion;
    void loadJobs();
  } catch (error) { showError(error); }
  finally { if (!disposed) request.value = ""; }
}
async function submitRender(name: "exportVideo" | "exportImage", args: Record<string, unknown>, kind: string) {
  if (request.value) return;
  request.value = kind;
  try {
    await flushPreferences();
    const job = await execution.call<NodeJobView>(name, args);
    if (disposed) return;
    renderKinds.set(job.jobId, kind);
    jobs.value = [...jobs.value.filter(item => item.jobId !== job.jobId), job];
    ++jobVersion;
    void loadJobs();
  } catch (error) { showError(error); }
  finally { if (!disposed) request.value = ""; }
}
function exportVideo(aspect: number) { return submitRender("exportVideo", { aspect }, "video"); }
function exportImage(anchor: CameraAnchor, aspect: number, time: number) { return submitRender("exportImage", { anchor: anchorSchema.parse(anchor), aspect, time }, `image:${anchor.id}`); }

async function renderPreview(document: ModelDocument, plan: DirectorPlan | undefined, light: LightingSettings, settings: SceneSettings) {
  const runtime = await createStage(window.document.createElement("canvas"), document.scene, undefined, undefined, light, settings);
  let player: ReturnType<typeof prepareSceneAnimation> | undefined;
  try {
    if (plan) { player = prepareSceneAnimation(runtime, plan); player.setTime(plan.duration); sampleMotion(runtime.camera, prepareMotion(plan.cameraFrames), plan.duration); }
    return capturePreview(runtime);
  } finally { player?.dispose(); disposeStage(runtime); }
}
watch(() => [data.value.modelPath, data.value.modelRevision], () => { void loadDocument(); }, { immediate: true });
watch(() => [data.value.prompt, data.value.model, data.value.selectedPlanId, data.value.anchors, data.value.lighting, data.value.sceneSettings], syncPreferences, { deep: true });
watch([modelDocument, selectedPlan, lighting, sceneSettings, modelLoading, previewReady], async ([document, plan, light, settings, loading, ready]) => {
  const version = ++previewVersion;
  if (!ready || loading || modelError.value) return;
  try { const image = await renderPreview(document, plan, light, settings); if (!disposed && version === previewVersion) preview.value = image; }
  catch (error) { showError(error); }
}, { immediate: true });
onBeforeUnmount(() => { disposed = true; observer.abort(); clearTimeout(saveTimer); clearTimeout(jobTimer); });

</script>

<style scoped lang="scss">
.directorContent {
  display: block;
  width: 100%;
  padding: 0;
  border: 0;
  cursor: pointer;
  aspect-ratio: 16 / 9;
  overflow: hidden;
  color: var(--el-text-color-regular);
  background: var(--el-fill-color-light);
  border-radius: var(--el-border-radius-base);
  &:focus-visible { outline: 2px solid var(--el-color-primary); outline-offset: 2px; }

  .scenePreview {
    display: block;
    width: 100%;
    height: 100%;
    object-fit: contain;
  }

  .emptyPreview {
    display: flex;
    height: 100%;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    color: var(--el-text-color-placeholder);
  }

}
</style>
