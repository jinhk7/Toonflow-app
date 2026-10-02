<template>
  <div
    ref="canvasElement"
    class="canvas"
    :class="{ edgesHidden: !showEdges, handMode, compositingEnabled: generalSettings.canvasCompositingEnabled }"
    :style="{ '--canvasEdgeColor': generalSettings.canvasEdgeColorMode === 'custom' ? generalSettings.canvasEdgeColor : 'var(--el-color-primary)' }"
    @dblclick="openNodeMenu"
    @wheel.capture="zoomCanvas"
    @gesturestart.capture="zoomCanvas"
    @gesturechange.capture="zoomCanvas"
    @gestureend.capture="zoomCanvas"
    @pointermove="pointerPosition = { x: $event.clientX, y: $event.clientY }"
    @pointerleave="pointerPosition = undefined"
    @dragover="dragFilesOver"
    @drop="dropFiles">
    <div v-if="canvasDraft" class="canvasConflict" role="status">
      <span>本地画布修改草稿已保留</span>
      <el-button size="small" @click="restoreCanvasDraft">恢复草稿</el-button>
      <el-button size="small" @click="exportCanvasDraft">导出草稿</el-button>
    </div>
    <vue-flow
      :id="runtimeKey"
      :only-render-visible-elements="false"
      :nodes-draggable="true"
      :node-types="nodeTypes"
      :snap-to-grid="snapEnabled"
      :snap-grid="[16, 16]"
      :min-zoom="0.2"
      :max-zoom="8"
      :nodes-connectable="true"
      :connection-mode="ConnectionMode.Strict"
      :nodes-focusable="false"
      :edges-focusable="false"
      :edges-updatable="false"
      :elevate-nodes-on-select="true"
      :elevate-edges-on-select="false"
      :disable-keyboard-a11y="true"
      :selectNodesOnDrag="false"
      :auto-pan-on-node-drag="false"
      :auto-pan-on-connect="false"
      :zoom-on-double-click="false"
      :zoomOnScroll="false"
      :zoomOnPinch="active && !settingsVisible"
      :panOnScroll="active && !settingsVisible"
      :panOnScrollSpeed="1"
      :panOnDrag="handMode ? true : [1]"
      :panOnScrollMode="PanOnScrollMode.Free"
      :delete-key-code="null"
      :selectionKeyCode="!handMode"
      :selectionMode="SelectionMode.Partial"
      :multi-selection-key-code="null"
      :zoomActivationKeyCode="zoomKeyPressed ? true : null"
      :pan-activation-key-code="null"
      v-model="flowData"
      @connect="addEdges"
      @edgeClick="showEdgeDisconnect"
      @paneClick="edgeDisconnect = undefined"
      @moveStart="edgeDisconnect = undefined"
      :default-edge-options="defaultEdgeOptions">
      <template v-for="type in remoteNodeTypes" :key="type" #[`node-${type}`]="nodeProps">
        <remoteNode
          v-bind="nodeProps"
          :component="nodeTypes[type]"
          :error="nodeErrors[type]"
          :loading="!canvasId || nodeLoads.has(type) || (nodeListLoading && !nodeTypes[type] && !nodeErrors[type])" />
      </template>
      <background :gap="16" pattern-color="var(--el-border-color)" />
      <canvasMenu ref="canvasMenuRef" v-model:canvasId="canvasId" :directory="project?.directory" :initialCanvasId="initialCanvasId" :activateCanvas="activateCanvas" :flushSave="flushCanvases ?? flushCanvasSave" :onGraphLoaded="rememberGraph" :onGraphRenamed="renameGraphSnapshot">
        <assetLibrary ref="assetLibraryRef" v-model="assetsVisible" :directory="project?.directory" />
      </canvasMenu>
      <canvasControls
        ref="canvasControlsRef"
        v-model:assetsVisible="assetsVisible"
        v-model:snapEnabled="snapEnabled"
        v-model:showEdges="showEdges"
        :canvasId="canvasId"
        :directory="project?.directory"
        :batchHistory="canvasHistory.batch"
        @update:showEdges="edgeDisconnect = undefined" />
      <nodeMenu
        :key="JSON.stringify([project?.directory, canvasId])"
        ref="nodeMenuRef"
        :remoteNodes="availableNodes"
        :addNode="addNodeFromMenu"
        :pasteNode="pasteClipboardNode"
        :uploadFiles="canvasId && project?.directory ? selectFiles : undefined"
        :canUndo="canUndo"
        :canRedo="canRedo"
        :selectionBusy="selectionToolbarRef?.busy"
        :batchHistory="canvasHistory.batch"
        @duplicateSelection="selectionToolbarRef?.operate('duplicate')"
        @history="canvasHistory.commit"
        @undo="changeHistory('undo')"
        @redo="changeHistory('redo')" />
      <selectionToolbar
        :key="JSON.stringify([project?.directory, canvasId])"
        ref="selectionToolbarRef"
        :batchHistory="canvasHistory.batch"
        :getSignal="() => canvasController.signal"
        :disabled="!canvasId || !project?.directory" />
      <nodeSearch ref="nodeSearchRef" :disabled="!active || settingsVisible || !canvasId || !project?.directory" />
    </vue-flow>
    <teleport to="body">
      <el-button
        v-if="edgeDisconnect && findEdge(edgeDisconnect.id)"
        class="edgeDisconnect"
        type="danger"
        circle
        aria-label="断开连接"
        title="断开连接"
        :style="{ left: `${edgeDisconnect.x}px`, top: `${edgeDisconnect.y}px` }"
        @click.stop="
          removeEdges(edgeDisconnect.id);
          edgeDisconnect = undefined;
        "
        @mouseleave="edgeDisconnect = undefined">
        <icon-unlink :size="16" />
      </el-button>
    </teleport>
  </div>
</template>

<script setup lang="ts">
import { computed, markRaw, nextTick, onBeforeUnmount, onMounted, onScopeDispose, provide, ref, shallowReactive, shallowRef, watch } from "vue";
import axios from "axios";
import { debounce } from "lodash-es";
import { ElMessage } from "element-plus";
import { storeToRefs } from "pinia";
import { IconUnlink } from "@tabler/icons-vue";
import * as vueRuntime from "vue";
import * as vueFlowRuntime from "@vue-flow/core";
import * as elementPlusRuntime from "element-plus";
import "element-plus/dist/index.css";
import {
  VueFlow,
  PanOnScrollMode,
  ConnectionMode,
  SelectionMode,
  useVueFlow,
  wheelDelta,
  isNode,
  type Node,
  type Edge,
  type GraphEdge,
  type EdgeMouseEvent,
  type NodeTypesObject,
  type XYPosition,
} from "@vue-flow/core";
import { Background } from "@vue-flow/background";
import { useCanvasTools } from "./useCanvasTools";
import { fetchNodeCatalog, getExecutionClientId, isExecutableNode, createExecutionClient, useNodeCopyData, type NodeExecutionHost } from "@toonflow/nodes-scaffold/runtime";
import type { NodeExecutionDescriptor } from "@toonflow/nodes-scaffold/execution";
import { useWorkspaceEvents } from "@/lib/workspaceEvents";
import { readWorkspaceDraft, removeWorkspaceDraft, saveWorkspaceDraft } from "@/lib/workspaceDrafts";
import type { CanvasContext } from "@toonflow/tool-canvas/runtime";
import { getLoadedNodeRevision, initializeNodeHost, loadNodeComponent, markUntrustedNodeRealm } from "./loadNodeComponent";
import { useCanvasHistory } from "./useCanvasHistory";
import { copyNodeToClipboard, nodeClipboardCommand, readClipboardNode } from "./nodeClipboard";
import { readClipboardText } from "@/lib/clipboard";
import nodeMenu from "./components/nodeMenu.vue";
import remoteNode from "./components/remoteNode.vue";
import canvasMenu from "./components/canvasMenu.vue";
import canvasControls from "./components/canvasControls.vue";
import assetLibrary from "./components/assetLibrary.vue";
import groupNode from "./components/groupNode.vue";
import selectionToolbar from "./components/selectionToolbar.vue";
import nodeSearch from "./components/nodeSearch.vue";
import { finishGroupDrag } from "./selectionNodes";
import type { NodeOutput } from "@toonflow/nodes-scaffold/values";
import type { NodeConnectionFeedback, NodeHandle } from "@toonflow/nodes-scaffold/connection";
import { useNodeEvent } from "@toonflow/nodes-scaffold/nodeEvent";
import { useWorkspaceStore } from "@/stores/workspace";
import { generalSettings } from "@/stores/settings";
import { getShortcutBindings, shortcutLabel, shortcutMatches, shortcutPressed } from "@/lib/canvasShortcuts";
import useWorkspaceFiles, { graphValueJson, type WorkspaceGraph } from "@/lib/workspaceFiles";
import anonymousData from "@/lib/anonymousData";
import saveFile from "@/lib/saveFile";
import { dropCanvasFiles, importCanvasFiles, isCanvasFileDrag } from "./canvasDrop";
import "@vue-flow/core/dist/style.css";
import "@vue-flow/core/dist/theme-default.css";
import "@vue-flow/minimap/dist/style.css";

const props = withDefaults(defineProps<{
  active?: boolean;
  settingsVisible?: boolean;
  runtimeKey?: string;
  initialCanvasId?: string;
  activateCanvas?: (canvasId: string, signal?: AbortSignal) => Promise<void>;
  resolveCanvasContext?: (canvasId: string) => CanvasContext | undefined;
  flushCanvases?: (action?: () => Promise<void>) => Promise<void>;
}>(), { active: true, settingsVisible: false });
const { project } = storeToRefs(useWorkspaceStore());

const canvasElement = ref<HTMLElement>();
const flowData = ref<(Node | Edge)[]>([]);
const canvasId = ref("");
const nodeMenuRef = ref<InstanceType<typeof nodeMenu>>();
const canvasMenuRef = ref<InstanceType<typeof canvasMenu>>();
const canvasControlsRef = ref<InstanceType<typeof canvasControls>>();
const selectionToolbarRef = ref<InstanceType<typeof selectionToolbar>>();
const nodeSearchRef = ref<InstanceType<typeof nodeSearch>>();
const nodeTypes = shallowRef<NodeTypesObject>({ canvasGroup: markRaw(groupNode) });
const nodeConfigs = shallowRef<Record<string, Record<string, unknown>>>({});
const nodeDescriptors = shallowRef<Record<string, NodeExecutionDescriptor>>({});
const nodeOptions = ref<{ type: string; label: string; handles: NodeHandle[] }[]>([]);
const nodeLoads = shallowReactive(new Map<string, Promise<void>>());
const nodeReloads = new Set<string>();
const nodeErrors = ref<Record<string, string>>({});
const availableNodes = computed(() => nodeOptions.value.filter(node => nodeTypes.value[node.type] && !nodeErrors.value[node.type]));
const nodeListLoading = ref(true);
const remoteNodeTypes = computed(() => [
  ...new Set((flowData.value as { type?: string }[]).map((item) => item.type).filter((type): type is string => !!type?.startsWith("remote-"))),
]);
let loadRequest = 0;
const snapEnabled = ref(false);
const zoomKeyPressed = ref(false);
const panKeyPressed = ref(false);
const selectedTool = ref<"move" | "hand">("move");
const handMode = computed(() => props.active && !props.settingsVisible && (selectedTool.value === "hand" || panKeyPressed.value));
let pointerPosition: XYPosition | undefined;
const pressedCodes = new Set<string>();
let gestureScale: number | undefined;
let nativePasteRequested = false;
const showEdges = ref(true);
const assetsVisible = ref(false);
const assetLibraryRef = ref<InstanceType<typeof assetLibrary>>();
const edgeDisconnect = ref<{ id: string; x: number; y: number }>();
const flow = useVueFlow(props.runtimeKey);
onScopeDispose(anonymousData.observeCanvas(() => props.active && canvasId.value
  ? { nodes: flow.nodes.value, edgeCount: flow.edges.value.length }
  : undefined));
let dragCopy: ReturnType<InstanceType<typeof selectionToolbar>["startDragCopy"]>;
flow.onNodeDragStart(({ event, nodes }) => {
  dragCopy = undefined;
  if (!props.active || props.settingsVisible) return;
  const shortcuts = generalSettings.value.canvasShortcuts;
  const withEdges = shortcutPressed(event, shortcuts.duplicateOnDrag, pressedCodes);
  if (withEdges || shortcutPressed(event, shortcuts.copyOnDrag, pressedCodes)) {
    dragCopy = selectionToolbarRef.value?.startDragCopy(nodes, withEdges);
  }
});
flow.onNodeDrag(() => dragCopy?.update());
flow.onNodeDragStop(({ nodes }) => {
  const copy = dragCopy;
  dragCopy = undefined;
  if (copy) copy.finish();
  else finishGroupDrag(flow.getNodes.value, nodes);
});
const canvasHistory = useCanvasHistory(flow, () =>
  project.value?.directory && canvasId.value ? JSON.stringify([project.value.directory, canvasId.value]) : ""
);
const { canUndo, canRedo } = canvasHistory;
provide("batchCanvasHistory", canvasHistory.batch);
const { addNodes, addEdges, removeEdges, findEdge, findNode, toObject, viewport, screenToFlowCoordinate } = flow;
provide("copyNodeToClipboard", (node: Parameters<typeof copyNodeToClipboard>[0]) => copyNodeToClipboard(node, project.value?.directory ?? ""));
provide("retainNodeFiles", true);
provide("selectionConnection", shallowRef<NodeConnectionFeedback>());
provide("saveNodeToAssets", (label: string, outputs: { label: string; output: NodeOutput }[]) => assetLibraryRef.value?.openSave(label, outputs));
let canvasController = new AbortController();
let workspaceController = new AbortController();
const createCanvasContext = useCanvasTools({
  availableNodes,
  flushSave: flushCanvasSave,
  refresh: refreshGraph,
  menu() {
    if (!canvasMenuRef.value) throw new Error("画布菜单尚未就绪");
    return canvasMenuRef.value;
  },
  getCanvasBinding: () => ({ id: canvasId.value, signal: canvasController.signal }),
  resolveCanvasContext: id => props.resolveCanvasContext?.(id),
});
function getCanvasContext() {
  return canvasId.value ? createCanvasContext(canvasId.value, canvasController.signal, workspaceController.signal) : undefined;
}
const canvasReady = computed(() => !!canvasId.value && !nodeListLoading.value && nodeLoads.size === 0);
provide("canvas", getCanvasContext);
provide<NodeExecutionHost>("nodeExecution", {
  getTarget(nodeId) {
    const directory = project.value?.directory;
    const path = canvasId.value;
    const node = findNode(nodeId);
    const descriptor = node?.type ? nodeDescriptors.value[node.type] : undefined;
    if (!directory || !path || !node || !descriptor) throw new Error("节点未接入后端执行协议，请迁移插件");
    return { directory, canvasPath: path, descriptor, version: graphSnapshots.get(path)?.toonflowGraph.nodes[nodeId] ?? 0 };
  },
  async beforeCommand(target) {
    if (target.directory !== project.value?.directory || target.canvasPath !== canvasId.value) throw new Error("画布上下文已切换");
    await flushCanvasSave();
  },
  async refresh(target) { if (target.directory === project.value?.directory && target.canvasPath === canvasId.value) await refreshGraph(); },
});
useNodeCopyData(async nodeId => {
  const node = findNode(nodeId);
  const descriptor = node?.type ? nodeDescriptors.value[node.type] : undefined;
  const action = descriptor?.actions.find(item => item.name === "getCopyData" || item.name === "node:getCopyData");
  if (!node || !descriptor || !action) return;
  const directory = project.value?.directory;
  const path = canvasId.value;
  const signal = canvasController.signal;
  if (!directory || !path) throw new Error("画布尚未就绪，无法复制节点");
  const checkBinding = () => {
    signal.throwIfAborted();
    if (project.value?.directory !== directory || canvasId.value !== path || findNode(nodeId)?.type !== node.type
      || nodeDescriptors.value[node.type!]?.executionRevision !== descriptor.executionRevision) throw new Error("节点上下文已切换，请重新复制");
  };
  await flushCanvasSave();
  checkBinding();
  const patch = await createExecutionClient(directory).execute<Record<string, unknown>>({
    canvasPath: path, name: "nodeTools",
    args: { nodeId, name: action.name.startsWith("node:") ? action.name : `node:${action.name}`, args: {}, expectedNodeRevision: descriptor.executionRevision },
    expectedVersions: { [nodeId]: graphSnapshots.get(path)?.toonflowGraph.nodes[nodeId] ?? 0 },
  }, signal);
  checkBinding();
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) throw new Error("节点复制数据无效");
  await refreshGraph();
  checkBinding();
  return patch;
}, flow);
defineExpose({ canvasId, canvasReady, getCanvasContext, readDocumentNode, saveDocumentNode, flushSave: flushCanvasSave, cancelSave: cancelCanvasSave,
  getSelectedNodeIds: () => flow.getSelectedNodes.value.map(node => node.id),
  getMentionNodes: () => flow.nodes.value, findMentionNode: flow.findNode,
  get saveBusy() { return savePaused; }, get loadError() { return canvasMenuRef.value?.loadError ?? ""; },
});

type DocumentNodeData = { label?: string; handles?: NodeHandle[]; outputs?: Record<string, NodeOutput | undefined>; textPath?: string };

function checkDocumentDirectory(directory: string) {
  if (!directory || directory !== project.value?.directory) throw new Error("工作目录已切换，请重新打开节点");
}

function documentHandles(node: Node<DocumentNodeData>) {
  const handles = node.data?.handles;
  if (Array.isArray(handles) && handles.length) {
    return handles.filter(
      (handle) =>
        handle &&
        typeof handle.id === "string" &&
        handle.type === "source" &&
        (Array.isArray(handle.dataType) ? handle.dataType.includes("STRING") : handle.dataType === "STRING")
    );
  }
  return Object.entries(node.data?.outputs ?? {}).flatMap(([id, output]) => (output?.dataType === "STRING" ? [{ id, label: id }] : []));
}

async function readDocumentCanvas(directory: string, canvasPath: string, nodeId: string) {
  checkDocumentDirectory(directory);
  const files = useWorkspaceFiles(directory);
  const canvas = await files.readGraph(canvasPath);
  checkDocumentDirectory(directory);
  if (canvas?.toonflowCanvas !== true || !Array.isArray(canvas.nodes)) throw new Error("文件不是有效画布");
  const node = (canvas.nodes as Node<DocumentNodeData>[]).find((item) => item && item.id === nodeId);
  if (!node) throw new Error("节点已删除，请刷新文件树");
  if (node.data !== undefined && (!node.data || typeof node.data !== "object" || Array.isArray(node.data))) throw new Error("节点数据无效");
  const liveNode = canvasId.value === canvasPath ? findNode(nodeId) : undefined;
  if (canvasId.value === canvasPath && !liveNode) throw new Error("节点已删除，请刷新文件树");
  const textPath = node.data?.textPath;
  if (
    textPath !== undefined &&
    (typeof textPath !== "string" ||
      !textPath.trim() ||
      /^(?:[a-z][a-z\d+.-]*:|[\\/])/i.test(textPath) ||
      textPath.includes("\0") ||
      textPath.split(/[\\/]/).includes(".."))
  )
    throw new Error("文本文件路径必须位于工作区内");
  return { files, canvas, node, liveNode, textPath };
}

async function readDocumentNode(directory: string, canvasPath: string, nodeId: string) {
  checkDocumentDirectory(directory);
  await flushCanvasSave();
  const { canvas, node, textPath } = await readDocumentCanvas(directory, canvasPath, nodeId);
  const handles = documentHandles(node);
  if (!handles.length) throw new Error("节点没有文本输出，请刷新文件树");
  const stored = textPath === undefined ? undefined : await createExecutionClient(directory).readContent(textPath);
  checkDocumentDirectory(directory);
  return {
    label: typeof node.data?.label === "string" ? node.data.label : nodeId,
    outputs: handles.map(handle => {
      const output = node.data?.outputs?.[handle.id];
      return {
        id: handle.id, label: handle.label || handle.id,
        text: stored?.content ?? (output?.dataType === "STRING" && typeof output.value === "string" ? output.value : ""),
        revision: stored?.revision ?? String(canvas.toonflowGraph.outputs[JSON.stringify([nodeId, handle.id])] ?? 0),
      };
    }),
  };
}
async function addNodeFromMenu(type: string, label: string, position: XYPosition) {
  const directory = project.value?.directory;
  const path = canvasId.value;
  if (!directory || !path) throw new Error("请先打开画布");
  await flushCanvasSave();
  const sent = toObject();
  const created = await createExecutionClient(directory).execute<{ node: { id: string } }>({ canvasPath: path, name: "addNode", args: { type, label, position } });
  const graph = await useWorkspaceFiles(directory).readGraph(path);
  if (project.value?.directory !== directory || canvasId.value !== path) throw new Error("画布已切换，节点已在原画布创建");
  rememberGraph(path, graph);
  mergeSavedGraph(sent, graph);
  await nextTick();
  return created.node.id;
}

async function saveDocumentNode(directory: string, canvasPath: string, nodeId: string, handleId: string, text: string, expectedRevision?: string) {
  checkDocumentDirectory(directory);
  let revision = "";
  await flushCanvasSave(async () => {
    const { files, canvas, node, textPath } = await readDocumentCanvas(directory, canvasPath, nodeId);
    if (!documentHandles(node).some(handle => handle.id === handleId)) throw new Error("文本输出已删除，请重新打开节点");
    const descriptor = node.type ? nodeDescriptors.value[node.type] : undefined;
    const setter = descriptor?.actions.find(action => action.name === "setText" || action.name === "node:setText");
    const properties = setter?.parameters.properties as Record<string, unknown> | undefined;
    const client = createExecutionClient(directory);
    if (setter && descriptor && (textPath === undefined || properties?.expectedRevision)) {
      if (textPath !== undefined && expectedRevision === undefined) throw new Error("正文缺少版本，请重新打开节点");
      if (textPath === undefined && expectedRevision !== String(canvas.toonflowGraph.outputs[JSON.stringify([nodeId, handleId])] ?? 0)) throw new Error("其他设备已修改正文，本地草稿已保留");
      const response = await client.execute<{ revision?: string }>({
        canvasPath, name: "nodeTools", args: { nodeId, name: setter.name.startsWith("node:") ? setter.name : `node:${setter.name}`,
          args: { text, ...(properties?.expectedRevision && textPath !== undefined ? { expectedRevision } : {}) }, expectedNodeRevision: descriptor.executionRevision },
        expectedVersions: { [nodeId]: canvas.toonflowGraph.nodes[nodeId] ?? 0 },
      }, canvasController.signal);
      revision = response?.revision ?? "";
    } else if (textPath !== undefined) {
      if (expectedRevision === undefined) throw new Error("正文缺少版本，请重新打开节点");
      revision = (await client.writeContent(textPath, text, expectedRevision)).revision;
    } else {
      const version = canvas.toonflowGraph.outputs[JSON.stringify([nodeId, handleId])] ?? 0;
      if (expectedRevision !== String(version)) throw new Error("其他设备已修改正文，本地草稿已保留");
      const output = node.data?.outputs?.[handleId];
      await files.modifyGraph(canvasPath, [{ kind: "output", nodeId, slot: handleId, expectedVersion: version,
        value: output?.dataType === "STRING" ? { ...output, value: text } : { dataType: "STRING", value: text } }]);
    }
    checkDocumentDirectory(directory);
    const updated = await files.readGraph(canvasPath);
    rememberGraph(canvasPath, updated);
    if (canvasId.value === canvasPath) mergeSavedGraph(canvas, updated);
    if (textPath === undefined) {
      const output = updated.nodes.find(item => item.id === nodeId)?.data?.outputs?.[handleId];
      if (output?.dataType !== "STRING" || output.value !== text) throw new Error("正文提交后已被其他设备修改，本地草稿已保留");
      revision = String(updated.toonflowGraph.outputs[JSON.stringify([nodeId, handleId])] ?? 0);
    } else if (!revision) {
      const stored = await client.readContent(textPath);
      if (stored.content !== text) throw new Error("正文提交后已被其他设备修改，本地草稿已保留");
      revision = stored.revision;
    }
    canvasMenuRef.value?.syncDocumentNode(canvasPath, nodeId, handleId, text, textPath === undefined);
  });
  return revision;
}

function showEdgeDisconnect({ event, edge }: EdgeMouseEvent) {
  if (!(event instanceof MouseEvent)) return;
  event.stopPropagation();
  edgeDisconnect.value = { id: edge.id, x: event.clientX, y: event.clientY };
}

function dragFilesOver(event: DragEvent) {
  if (!props.active || props.settingsVisible || !canvasId.value || !project.value?.directory || !isCanvasFileDrag(event)) return;
  if (!(event.target instanceof Element) || !event.target.closest(".vue-flow__pane")) return;
  event.preventDefault();
  event.dataTransfer!.dropEffect = "copy";
  return true;
}

async function dropFiles(event: DragEvent) {
  const directory = project.value?.directory;
  if (!directory || !dragFilesOver(event)) return;
  try {
    await canvasHistory.batch(() => dropCanvasFiles(event, fileImportContext(directory, canvasId.value)));
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : "文件导入失败");
  }
}

function selectFiles(position: { x: number; y: number }) {
  const directory = project.value?.directory;
  if (!props.active || props.settingsVisible || !canvasId.value || !directory) return;
  const context = fileImportContext(directory, canvasId.value);
  const input = document.createElement("input");
  input.type = "file";
  input.multiple = true;
  input.onchange = async () => {
    const files = Array.from(input.files ?? []);
    if (!files.length || context.signal.aborted) return;
    try {
      await canvasHistory.batch(() => importCanvasFiles(files, position, context));
    } catch (error) {
      ElMessage.error(error instanceof Error ? error.message : "文件导入失败");
    }
  };
  input.click();
}

function fileImportContext(directory: string, path: string) {
  const signal = canvasController.signal;
  const checkBinding = () => {
    signal.throwIfAborted();
    if (project.value?.directory !== directory || canvasId.value !== path) throw new Error("画布已切换，请在原画布查看已提交的导入");
  };
  return {
    directory, signal, flow,
    availableNodes: availableNodes.value.map(node => ({ ...nodeDescriptors.value[node.type]!, type: node.type })),
    async addNode(type: string, label: string, position: XYPosition) {
      checkBinding();
      return addNodeFromMenu(type, label, position);
    },
    async execute(nodeId: string, name: string, args: Record<string, unknown>, revision: string) {
      checkBinding();
      await flushCanvasSave();
      checkBinding();
      const sent = toObject();
      const result = await createExecutionClient(directory).execute({ canvasPath: path, name: "nodeTools",
        args: { nodeId, name: name.startsWith("node:") ? name : `node:${name}`, args, expectedNodeRevision: revision },
        expectedVersions: { [nodeId]: graphSnapshots.get(path)?.toonflowGraph.nodes[nodeId] ?? 0 },
      }, signal);
      const graph = await useWorkspaceFiles(directory).readGraph(path);
      checkBinding();
      rememberGraph(path, graph);
      mergeSavedGraph(sent, graph);
      return result;
    },
  };
}

function openNodeMenu(event: MouseEvent) {
  if (event.target instanceof Element && event.target.classList.contains("vue-flow__pane")) nodeMenuRef.value?.openMenu(event, true);
}

function addNodeAtPointer() {
  const rect = canvasElement.value?.getBoundingClientRect();
  if (!rect) return;
  const position = pointerPosition ?? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  void nodeMenuRef.value?.openMenu(new MouseEvent("contextmenu", { clientX: position.x, clientY: position.y }), true);
}

async function changeHistory(direction: "undo" | "redo") {
  try {
    await canvasHistory[direction]();
    edgeDisconnect.value = undefined;
  } catch (error) {
    ElMessage.error(
      axios.isAxiosError<{ message?: string }>(error)
        ? error.response?.data.message || "恢复画布失败"
        : error instanceof Error
        ? error.message
        : "恢复画布失败"
    );
  }
}

let saving = Promise.resolve();
let flushing = Promise.resolve();
let saveError: unknown;
let savePaused = false;
let saveCancelled = false;
let changedWhilePaused = false;
let saveRevision = 0;
const graphSnapshots = new Map<string, WorkspaceGraph>();
type CanvasDraft = { draftId: string; baseline: WorkspaceGraph; flow: Pick<WorkspaceGraph, "nodes" | "edges" | "viewport"> };
const canvasDraft = ref<CanvasDraft>();
function persistCanvasDraft(directory: string, path: string, baseline: WorkspaceGraph, snapshot = toObject()) {
  const draft: CanvasDraft = { draftId: crypto.randomUUID(), baseline, flow: { nodes: snapshot.nodes as Node[], edges: snapshot.edges as Edge[], viewport: snapshot.viewport } };
  saveWorkspaceDraft(directory, path, "canvasGraph", draft);
  return draft;
}
async function restoreCanvasDraft() {
  const draft = canvasDraft.value;
  const path = canvasId.value;
  if (!draft || !path) return;
  const paused = savePaused;
  savePaused = true;
  try {
    flow.setNodes(JSON.parse(JSON.stringify(draft.flow.nodes)));
    flow.setEdges(JSON.parse(JSON.stringify(draft.flow.edges)));
    await flow.setViewport(draft.flow.viewport);
    await nextTick();
    graphSnapshots.set(path, JSON.parse(JSON.stringify(draft.baseline)));
  } finally { savePaused = paused; }
  scheduleCanvasSave();
}
async function exportCanvasDraft() {
  const draft = canvasDraft.value;
  if (!draft) return;
  try { await saveFile(new Blob([JSON.stringify(draft, null, 2)], { type: "application/json" }), `${canvasId.value.replace(/\.json$/i, "")}.draft.json`); }
  catch (error) { ElMessage.error(error instanceof Error ? error.message : "导出草稿失败"); }
}
function rememberGraph(path: string, graph: WorkspaceGraph) {
  if (!graphSnapshots.has(path) && project.value?.directory) {
    const draft = readWorkspaceDraft<CanvasDraft>(project.value.directory, path, "canvasGraph");
    if (draft && Array.isArray(draft.flow?.nodes) && Array.isArray(draft.flow?.edges) && draft.baseline?.toonflowCanvas === true) canvasDraft.value = draft;
  }
  // 保存基线必须与 Vue Flow 的可变节点数据隔离，否则修改 pending 会同时篡改基线而被漏写。
  graphSnapshots.set(path, JSON.parse(JSON.stringify(graph)) as WorkspaceGraph);
}
function renameGraphSnapshot(previous: string, target: string) {
  const graph = graphSnapshots.get(previous);
  if (!graph) return;
  graphSnapshots.delete(previous);
  graphSnapshots.set(target, graph);
}
function mergeSavedGraph(sent: Pick<WorkspaceGraph, "nodes" | "edges" | "viewport">, server: WorkspaceGraph) {
  const current = toObject();
  const merge = (kind: "nodes" | "edges") => {
    const sentItems = new Map(sent[kind].map(item => [item.id, item]));
    const currentItems = new Map(current[kind].map(item => [item.id, item]));
    const result = server[kind].map(item => {
      const live = currentItems.get(item.id);
      currentItems.delete(item.id);
      if (!live || graphValueJson(live) === graphValueJson(sentItems.get(item.id))) return item;
      if (kind === "nodes") {
        const before = sentItems.get(item.id) as Node | undefined;
        const local = live as Node;
        const remote = item as Node;
        const outputs = { ...remote.data?.outputs };
        for (const slot of new Set([...Object.keys(before?.data?.outputs ?? {}), ...Object.keys(local.data?.outputs ?? {})])) {
          const value = local.data?.outputs?.[slot];
          if (graphValueJson(value) === graphValueJson(before?.data?.outputs?.[slot])) continue;
          if (value === undefined) delete outputs[slot];
          else outputs[slot] = value;
        }
        return { ...local, data: { ...local.data, outputs } };
      }
      return live;
    });
    for (const item of currentItems.values()) {
      if (graphValueJson(item) !== graphValueJson(sentItems.get(item.id))) result.push(item);
    }
    return result;
  };
  const nodes = merge("nodes");
  const edges = merge("edges");
  if (graphValueJson(nodes) !== graphValueJson(current.nodes)) flow.setNodes(nodes as Node[]);
  if (graphValueJson(edges) !== graphValueJson(current.edges)) flow.setEdges(edges as Edge[]);
  if (graphValueJson(current.viewport) === graphValueJson(sent.viewport) && graphValueJson(server.viewport) !== graphValueJson(current.viewport)) void flow.setViewport(server.viewport);
}
let refreshingGraph = false;
let lastConflictRevision = -1;
async function refreshGraph() {
  if (refreshingGraph || document.hidden || savePaused) return false;
  const directory = project.value?.directory;
  const path = canvasId.value;
  const baseline = path && graphSnapshots.get(path);
  if (!directory || !path) return true;
  if (!baseline) return false;
  refreshingGraph = true;
  try {
    await saving;
    const remote = await useWorkspaceFiles(directory).readGraph(path);
    if (canvasId.value !== path || project.value?.directory !== directory || graphSnapshots.get(path) !== baseline) return false;
    if (remote.toonflowGraph.revision === baseline.toonflowGraph.revision) {
      rememberGraph(path, remote);
      return true;
    }
    const current = toObject();
    const overlapping = (["nodes", "edges"] as const).some(kind => {
      const oldItems = new Map(baseline[kind].map(item => [item.id, item]));
      const liveItems = new Map(current[kind].map(item => [item.id, item]));
      const remoteItems = new Map(remote[kind].map(item => [item.id, item]));
      return [...new Set([...oldItems.keys(), ...liveItems.keys(), ...remoteItems.keys()])].some(id => {
        const oldValue = graphValueJson(oldItems.get(id));
        const liveValue = graphValueJson(liveItems.get(id));
        const remoteValue = graphValueJson(remoteItems.get(id));
        return liveValue !== oldValue && remoteValue !== oldValue && liveValue !== remoteValue;
      });
    }) || (graphValueJson(current.viewport) !== graphValueJson(baseline.viewport)
      && graphValueJson(remote.viewport) !== graphValueJson(baseline.viewport)
      && graphValueJson(current.viewport) !== graphValueJson(remote.viewport));
    if (overlapping) {
      canvasDraft.value = persistCanvasDraft(directory, path, baseline, current);
      if (lastConflictRevision !== remote.toonflowGraph.revision) ElMessage.warning("其他设备修改了同一画布元素，请重新打开画布处理冲突");
      lastConflictRevision = remote.toonflowGraph.revision;
      return false;
    }
    rememberGraph(path, remote);
    mergeSavedGraph(baseline, remote);
    return true;
  } finally { refreshingGraph = false; }
}
const saveCanvas = debounce((directory: string, fileName: string) => {
  const queuedFlow = toObject();
  const queuedBaseline = graphSnapshots.get(fileName);
  // 排队完成后一起读取当前图和基线，不能用旧图搭配更新后的输出版本。
  saving = saving.then(async () => {
    const active = canvasId.value === fileName && project.value?.directory === directory;
    const flow = active ? toObject() : queuedFlow;
    try {
      const baseline = active ? graphSnapshots.get(fileName) : queuedBaseline;
      if (!baseline) throw new Error("画布快照尚未加载，无法安全保存");
      const draft = persistCanvasDraft(directory, fileName, baseline, flow);
      const updated = await useWorkspaceFiles(directory).saveGraph(fileName, baseline, { nodes: flow.nodes as WorkspaceGraph["nodes"], edges: flow.edges as WorkspaceGraph["edges"], viewport: flow.viewport });
      if (readWorkspaceDraft<CanvasDraft>(directory, fileName, "canvasGraph")?.draftId === draft.draftId) removeWorkspaceDraft(directory, fileName, "canvasGraph");
      if (active) canvasDraft.value = undefined;
      rememberGraph(fileName, updated);
      if (canvasId.value === fileName && project.value?.directory === directory) mergeSavedGraph(flow, updated);
      saveError = undefined;
    } catch (err) {
      saveError = err;
      if (active) canvasDraft.value = readWorkspaceDraft<CanvasDraft>(directory, fileName, "canvasGraph");
      ElMessage.error(
        axios.isAxiosError<{ message?: string }>(err)
          ? err.response?.data.message || "画布保存失败"
          : err instanceof Error
          ? err.message
          : "画布保存失败"
      );
    }
  });
}, 500);

function scheduleCanvasSave() {
  if (saveCancelled) return;
  saveRevision++;
  if (savePaused) {
    changedWhilePaused = true;
    return;
  }
  const directory = project.value?.directory;
  if (directory && canvasId.value) saveCanvas(directory, canvasId.value);
}

function scheduleCanvasChange() {
  scheduleCanvasSave();
  canvasHistory.record();
}

const elementSaveWatchers = new Map<Node | Edge, () => void>();
const nodeRuntimeFields = new Set([
  "data",
  "computedPosition",
  "handleBounds",
  "selected",
  "dimensions",
  "isParent",
  "resizing",
  "dragging",
  "events",
]);
const edgeRuntimeFields = new Set(["data", "selected", "sourceNode", "targetNode", "sourceX", "sourceY", "targetX", "targetY", "events"]);
// ACT: 仅增删、替换元素时扫描列表；位移与 data 各自监听，单个节点变化不遍历其余节点。
watch(
  () => [...flow.nodes.value, ...flow.edges.value],
  (elements) => {
    const current = new Set<Node | Edge>(elements);
    for (const [element, stop] of elementSaveWatchers) {
      if (!current.has(element)) {
        stop();
        elementSaveWatchers.delete(element);
      }
    }
    for (const element of elements) {
      if (elementSaveWatchers.has(element)) continue;
      // 与 toObject 排除的运行态字段保持一致，其他自定义持久字段仍参与自动保存。
      const runtimeFields = isNode(element) ? nodeRuntimeFields : edgeRuntimeFields;
      const stopFields = watch(
        () =>
          Object.keys(element)
            .filter((key) => !runtimeFields.has(key))
            .map((key) => Reflect.get(element, key)),
        scheduleCanvasChange,
        { deep: true, flush: "post" }
      );
      const stopData = watch(() => element.data, scheduleCanvasSave, { deep: true, flush: "post" });
      const stopName = isNode(element)
        ? watch(
            () => element.data?.label,
            () => canvasHistory.record(),
            { flush: "post" }
          )
        : () => {};
      elementSaveWatchers.set(element, () => {
        stopFields();
        stopData();
        stopName();
      });
    }
    scheduleCanvasChange();
  },
  { immediate: true, flush: "post" }
);
onScopeDispose(() => elementSaveWatchers.forEach((stop) => stop()));
watch(() => [viewport.value.x, viewport.value.y, viewport.value.zoom], scheduleCanvasSave, { flush: "post" });

watch(
  [() => project.value?.directory, canvasId],
  ([directory, fileName], [previousDirectory, previousFileName]) => {
    if (directory !== previousDirectory) {
      workspaceController.abort(new Error("工作区已切换，本轮画布操作已停止"));
      workspaceController = new AbortController();
    }
    edgeDisconnect.value = undefined;
    dragCopy = undefined;
    pointerPosition = undefined;
    resetCanvasKeys();
    // 同一实例只在重新装载画布时失效；重命名仅更新保存路径。
    if (directory !== previousDirectory || !fileName || !previousFileName) {
      canvasController.abort(new Error("画布已重新加载，本次画布调用已停止"));
      canvasController = new AbortController();
    }
    if (!savePaused) saveCanvas.flush();
  },
  { flush: "sync" }
);

// ACT: 切换显示面板不会卸载画布；仅清理交互，不中断本轮工具调用。
watch(() => props.active, (active) => {
  if (!active) assetsVisible.value = false;
  edgeDisconnect.value = undefined;
  dragCopy = undefined;
  pointerPosition = undefined;
  resetCanvasKeys();
}, { flush: "sync" });

function flushCanvasSave(action?: () => Promise<void>): Promise<void> {
  // ACT: 完整保存及其文件操作串行执行，重命名暂停期间的显式保存也必须等待。
  const next = flushing.then(() => saveCanvasState(action));
  flushing = next.catch(() => {});
  return next;
}

async function saveCanvasState(action?: () => Promise<void>) {
  if (saveCancelled) throw new Error("画布保存已取消");
  await Promise.all(flow.getNodes.value.map((node) => useNodeEvent(node.id, flow).emit("save")));
  await nextTick();
  if (saveCancelled) throw new Error("画布保存已取消");
  if (saveError && project.value?.directory && canvasId.value) saveCanvas(project.value.directory, canvasId.value);
  if (action) savePaused = true;
  try {
    let revision: number;
    do {
      if (saveCancelled) throw new Error("画布保存已取消");
      revision = saveRevision;
      if (changedWhilePaused && project.value?.directory && canvasId.value) {
        saveCanvas(project.value.directory, canvasId.value);
        changedWhilePaused = false;
      }
      saveCanvas.flush();
      await saving;
      if (saveError) throw saveError;
      // 画布写入期间节点可能完成生成，等新增落盘后重新保存变化。
      await Promise.all(flow.getNodes.value.map((node) => useNodeEvent(node.id, flow).emit("save")));
      await nextTick();
    } while (revision !== saveRevision);
    if (saveCancelled) throw new Error("画布保存已取消");
    await action?.();
  } finally {
    if (action && !saveCancelled) {
      savePaused = false;
      if (changedWhilePaused && project.value?.directory && canvasId.value) saveCanvas(project.value.directory, canvasId.value);
      changedWhilePaused = false;
    }
  }
}

function cancelCanvasSave() {
  saveCancelled = true;
  savePaused = true;
  changedWhilePaused = false;
  saveCanvas.cancel();
}
async function pasteNode(event: ClipboardEvent) {
  if (!nativePasteRequested) return;
  nativePasteRequested = false;
  const target = event.target;
  if (!props.active || event.defaultPrevented || props.settingsVisible || !canvasId.value || !project.value?.directory) return;
  if (
    target instanceof Element &&
    (target.closest("input, textarea, select, [contenteditable]:not([contenteditable='false']), [role='textbox'], [role='dialog'], #agentPanel") ||
      (target !== document.body && target !== document.documentElement && !canvasElement.value?.contains(target)))
  )
    return;
  const command = event.clipboardData?.getData("text/plain") ?? "";
  if (!nodeClipboardCommand.test(command)) return;
  event.preventDefault();
  await pasteNodeAtCenter(command);
}

async function pasteNodeAtCenter(command?: string) {
  const rect = canvasElement.value?.getBoundingClientRect();
  if (!rect) return;
  const position = screenToFlowCoordinate({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 });
  await pasteClipboardNode(position, command);
}

async function pasteClipboardNode(position: { x: number; y: number }, command?: string) {
  if (!props.active || !canvasId.value || !project.value?.directory) return false;
  const canvasSignal = canvasController.signal;
  try {
    const directory = project.value.directory;
    const node = await readClipboardNode(command ?? (await readClipboardText()), directory);
    if (canvasSignal.aborted) return false;
    if (!node) throw new Error("剪贴板中没有可粘贴的节点命令");
    if (!availableNodes.value.some((item) => item.type === node.type)) throw new Error("请先安装并启用对应的节点插件");
    addNodes({ id: crypto.randomUUID(), type: node.type, data: node.data, position });
    return true;
  } catch (error) {
    const pasteShortcut = generalSettings.value.canvasShortcuts.paste;
    const clipboardMessage = getShortcutBindings(pasteShortcut).some(binding => /^(Ctrl|Meta)\+KeyV$/.test(binding))
      ? `无法读取剪贴板，请在画布上按 ${shortcutLabel(pasteShortcut)} 粘贴`
      : "无法读取剪贴板，请允许浏览器访问剪贴板";
    if (!canvasSignal.aborted)
      ElMessage.error(
        error instanceof DOMException && error.name === "NotAllowedError" ? clipboardMessage : error instanceof Error ? error.message : "节点粘贴失败"
      );
    return false;
  }
}

function zoomCanvas(event: WheelEvent | (Event & { scale: number })) {
  if (event.type === "gestureend") gestureScale = undefined;
  if (!props.active || props.settingsVisible || document.fullscreenElement || flow.userSelectionActive.value) return;
  if (!(event.target instanceof Element) || !event.target.closest(".vue-flow__pane, .vue-flow__node, .vue-flow__edge, .vue-flow__nodesselection")) return;
  let factor: number;
  let point = pointerPosition;
  if ("scale" in event) {
    if (!Number.isFinite(event.scale) || event.scale <= 0) return;
    factor = event.type === "gesturechange" && gestureScale !== undefined ? event.scale / gestureScale : 1;
    gestureScale = event.type === "gestureend" ? undefined : event.scale;
  } else {
    // ACT: Chromium 捏合发送 Ctrl+wheel，但不发送 Control 按键；WebKit 使用上方原生 gesture 事件。
    const pinching = event.ctrlKey && !pressedCodes.has("ControlLeft") && !pressedCodes.has("ControlRight");
    if (!pinching && !shortcutPressed(event, generalSettings.value.canvasShortcuts.zoom, pressedCodes)) {
      if (!event.ctrlKey) return;
      // 实体 Ctrl 未绑定缩放时，阻止 Vue Flow 和节点骨架将它误判为捏合。
      factor = 1;
    } else {
      factor = pinching && gestureScale !== undefined ? 1 : 2 ** (pinching ? -event.deltaY * 0.02 : wheelDelta(event));
    }
    point = { x: event.clientX, y: event.clientY };
  }
  const zoom = flow.d3Zoom.value;
  const selection = flow.d3Selection.value;
  if (!zoom || !selection) return;
  event.preventDefault();
  event.stopPropagation();
  if (factor === 1) return;
  const bounds = selection.node()?.getBoundingClientRect();
  if (!bounds) return;
  point ??= { x: bounds.left + bounds.width / 2, y: bounds.top + bounds.height / 2 };
  selection.call<[number, [number, number], Event]>(zoom.scaleBy, factor, [point.x - bounds.left, point.y - bounds.top], event);
}

function updateCanvasKeys(event: KeyboardEvent) {
  if (event.type === "keydown") {
    pressedCodes.add(event.code);
    nativePasteRequested = false;
  } else pressedCodes.delete(event.code);
  if (!props.active || props.settingsVisible) return resetCanvasKeys();
  const target = event.target;
  const shortcuts = generalSettings.value.canvasShortcuts;
  const inCanvas =
    target instanceof Element &&
    !target.closest("[role='dialog'], #agentPanel") &&
    (target === document.body || target === document.documentElement || canvasElement.value?.contains(target));
  zoomKeyPressed.value = !event.isComposing && shortcutPressed(event, shortcuts.zoom, pressedCodes);
  const editing =
    !(target instanceof Element) ||
    !!target.closest("input, textarea, select, button, [contenteditable]:not([contenteditable='false']), [role='textbox'], [role='slider']");
  panKeyPressed.value = !!inCanvas && !editing && !event.isComposing && shortcutPressed(event, shortcuts.pan, pressedCodes);
  if (event.type === "keyup" || event.defaultPrevented || event.isComposing || !inCanvas || editing) return;
  const action = ([
    "group", "mergeGroup", "ungroup", "addNode", "moveTool", "handTool", "arrange", "search",
    "delete", "paste", "undo", "redo", "zoomIn", "zoomOut", "fitView",
  ] as const).find((action) =>
    shortcutMatches(event, shortcuts[action])
  );
  if (!action) {
    if (panKeyPressed.value) event.preventDefault();
    return;
  }
  if (!canvasId.value || !project.value?.directory) return;
  if (action === "paste" && event.code === "KeyV" && (event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey) {
    nativePasteRequested = true;
    return;
  }
  event.preventDefault();
  if (event.repeat) return;
  if (action === "delete") {
    const nodes = [...flow.getSelectedNodes.value];
    const menu = nodeMenuRef.value;
    if (!menu || !nodes.some((node) => node.deletable !== false)) return;
    void canvasHistory
      .batch(() => menu.deleteSelection(nodes))
      .catch((error) => {
        ElMessage.error(error instanceof Error ? error.message : "节点删除失败");
      });
    return;
  }
  if (action === "paste") void pasteNodeAtCenter();
  else if (action === "undo" || action === "redo") void changeHistory(action);
  else if (action === "group" || action === "mergeGroup" || action === "ungroup") {
    void selectionToolbarRef.value?.operate(action);
  } else if (action === "addNode") addNodeAtPointer();
  else if (action === "moveTool" || action === "handTool") selectedTool.value = action === "handTool" ? "hand" : "move";
  else if (action === "arrange") void canvasControlsRef.value?.arrangeNodes();
  else if (action === "search") nodeSearchRef.value?.open();
  else void flow[action]();
}

function resetCanvasKeys() {
  pressedCodes.clear();
  gestureScale = undefined;
  nativePasteRequested = false;
  zoomKeyPressed.value = false;
  panKeyPressed.value = false;
}

watch([() => props.settingsVisible, () => generalSettings.value.canvasShortcuts], resetCanvasKeys, { deep: true, flush: "sync" });

function refreshInstalled(event: WindowEventMap["toonflow:plugin-installed"]) {
  if (event.detail.type === "node") void loadRemoteNodes(event.detail.name);
}

const refreshNodeConfig = () => { void loadRemoteNodes(); };
useWorkspaceEvents({
  directory: () => project.value?.directory,
  context: () => canvasId.value,
  refresh: refreshGraph,
  cursor: () => graphSnapshots.get(canvasId.value)?.cursor ?? 0,
  async receive(event) {
    if (event.type === "pluginsChanged") { await loadRemoteNodes(); return; }
    if (event.type === "graphChanged") {
      const previous = event.payload.renamedFrom;
      const target = event.payload.path;
      if (event.payload.created || typeof previous === "string") await canvasMenuRef.value?.refreshCanvases(typeof previous === "string" && typeof target === "string" ? { previous, target } : undefined);
      if (!event.canvasId || event.canvasId === canvasId.value) return refreshGraph();
    }
    if (event.type !== "uiIntent" || event.canvasId && event.canvasId !== canvasId.value) return;
    if (typeof event.payload.clientId === "string" && event.payload.clientId !== getExecutionClientId()) return;
    const nodeIds = Array.isArray(event.payload.nodeIds) ? event.payload.nodeIds.filter((id): id is string => typeof id === "string") : undefined;
    if (event.payload.name === "selectNodes" && nodeIds) {
      flow.removeSelectedElements();
      flow.addSelectedNodes(nodeIds.map(findNode).filter((node): node is NonNullable<typeof node> => !!node));
    } else if (event.payload.name === "fitCanvas") await flow.fitView({ nodes: nodeIds, padding: 0.2 });
  },
});

onMounted(() => {
  // 在捕获阶段同步修饰键，避免节点编辑器截断 keydown/keyup 后缩放状态丢失或卡住。
  window.addEventListener("keydown", updateCanvasKeys, true);
  window.addEventListener("keyup", updateCanvasKeys, true);
  window.addEventListener("blur", resetCanvasKeys);
  window.addEventListener("toonflow:plugin-installed", refreshInstalled);
  window.addEventListener("toonflow:node-config-updated", refreshNodeConfig);
  document.addEventListener("paste", pasteNode);
  void loadRemoteNodes();
});
onBeforeUnmount(() => {
  window.removeEventListener("keydown", updateCanvasKeys, true);
  window.removeEventListener("keyup", updateCanvasKeys, true);
  window.removeEventListener("blur", resetCanvasKeys);
  window.removeEventListener("toonflow:plugin-installed", refreshInstalled);
  window.removeEventListener("toonflow:node-config-updated", refreshNodeConfig);
  document.removeEventListener("paste", pasteNode);
  workspaceController.abort(new Error("工作区已关闭"));
  canvasController.abort(new Error("画布已关闭"));
  saveCanvas.flush();
  loadRequest++;
});

initializeNodeHost({ vue: vueRuntime, vueFlow: vueFlowRuntime, elementPlus: elementPlusRuntime, ai: {} });
provide("nodeConfig", (nodeType: string) => nodeConfigs.value[nodeType] ?? {});
provide("workspaceFiles", () => {
  const directory = project.value?.directory;
  if (!directory) throw new Error("请先选择工作目录");
  return useWorkspaceFiles(directory);
});
provide("workspaceDirectory", () => {
  const directory = project.value?.directory;
  if (!directory) throw new Error("请先选择工作目录");
  return directory;
});
provide("reloadRemoteNode", (type: string) => {
  const name = type.replace(/^remote-/, "");
  if (!type.startsWith("remote-") || !/^[a-z][a-zA-Z0-9]*$/.test(name)) throw new Error("节点类型无效");
  return loadNode(name, `/api/nodes/files?name=${name}`, true);
});

async function loadNode(name: string, url: string, force = false, revision?: string, builtin = false): Promise<void> {
  if (!revision) {
    const node = (await fetchNodeCatalog()).find(node => node.name === name && node.url === url);
    if (!node || !isExecutableNode(node)) throw new Error("节点缺少后端执行协议，请迁移插件");
    nodeDescriptors.value = { ...nodeDescriptors.value, [`remote-${name}`]: node };
    revision = node?.revision;
    builtin = node?.builtin === true;
  }
  if (!nodeDescriptors.value[`remote-${name}`]) throw new Error("节点缺少后端执行描述，请迁移插件");
  if (!revision || !/^[a-f0-9]{64}$/.test(revision)) throw new Error("节点脚本版本无效");
  if (builtin !== true) markUntrustedNodeRealm();
  const nodeType = `remote-${name}`;
  const signal = canvasController.signal;
  const pending = nodeLoads.get(nodeType);
  if (pending) await pending.catch(() => {});
  if (!force && nodeTypes.value[nodeType] && !nodeErrors.value[nodeType] && getLoadedNodeRevision(nodeTypes.value[nodeType]) === revision) return;
  if (force || (nodeTypes.value[nodeType] && getLoadedNodeRevision(nodeTypes.value[nodeType]) !== revision)) {
    signal.throwIfAborted();
    // ACT: 复用画布修订号收敛等待期间的编辑；持续修改画布时延后刷新，不额外维护节点修订状态。
    let savedRevision: number;
    do {
      savedRevision = saveRevision;
      await Promise.all(flow.getNodes.value.filter(node => node.type === nodeType).map(node => useNodeEvent(node.id, flow).emit("save", "reload")));
      await nextTick();
      signal.throwIfAborted();
    } while (savedRevision !== saveRevision);
    const loading = nodeLoads.get(nodeType);
    if (loading) return loading;
  }
  delete nodeErrors.value[nodeType];
  const expectedRevision = revision;
  const nodeLoad = loadNodeComponent(name, url, expectedRevision, force, builtin)
    .then((remoteNode) => {
      // 同类型节点共享组件，运行错误由每个节点自己的边界显示。
      nodeTypes.value = { ...nodeTypes.value, [nodeType]: markRaw(remoteNode) };
    })
    .catch((error) => {
      nodeErrors.value[nodeType] = error instanceof Error ? error.message : String(error);
      throw error;
    })
    .finally(() => nodeLoads.delete(nodeType));
  nodeLoads.set(nodeType, nodeLoad);
  return nodeLoad;
}

async function loadRemoteNodes(reloadName?: string) {
  if (reloadName) nodeReloads.add(reloadName);
  const requestId = ++loadRequest;
  const signal = canvasController.signal;
  nodeListLoading.value = true;
  try {
    const catalog = await fetchNodeCatalog();
    if (requestId !== loadRequest) return;
    const nodes = catalog.filter(isExecutableNode);
    nodeDescriptors.value = Object.fromEntries(nodes.map(node => [`remote-${node.name}`, node]));
    for (const node of catalog.filter(node => !isExecutableNode(node))) nodeErrors.value[`remote-${node.name}`] = typeof node.executionStatus === "object" ? node.executionStatus.message || "节点需要迁移后端执行协议" : "节点需要迁移后端执行协议";
    nodeConfigs.value = Object.fromEntries(nodes.map(node => [`remote-${node.name}`, node.config ?? {}]));
    const enabledNodes = nodes.filter(node => node.enabled !== false);
    // 节点各自加载完成后即可出现在菜单中，不等待其他节点的脚本。
    nodeOptions.value = enabledNodes.map(node => ({ type: `remote-${node.name}`, label: node.displayName, handles: node.handles }))
      .sort((left, right) => left.type.localeCompare(right.type));
    // ACT: 安装事件合并到最新列表请求，避免连续更新不同节点时丢失较早的刷新名称。
    const reloadNames = new Set(nodeReloads);
    nodeReloads.clear();
    await Promise.all(
      enabledNodes.map(async (node) => {
        const nodeType = `remote-${node.name}`;
        try {
          await loadNode(node.name, node.url, reloadNames.has(node.name), node.revision, node.builtin === true);
        } catch (error) {
          console.error("加载远端节点失败", node, error);
          // 保存拒绝时旧组件仍可用，不从节点菜单中移除；脚本加载错误仍排除。
          if (nodeTypes.value[nodeType] && !nodeErrors.value[nodeType]) {
            if (reloadNames.has(node.name) && !signal.aborted) ElMessage.warning({
              message: `${node.displayName}已安装，但当前节点无法刷新。请等待任务结束后，点击节点右上角的刷新按钮。`,
              grouping: true,
            });
          }
        }
      })
    );
  } catch (error) {
    if (requestId === loadRequest) console.error("获取远端节点列表失败", error);
  } finally {
    if (requestId === loadRequest) nodeListLoading.value = false;
  }
}

const defaultEdgeOptions = markRaw({
  type: "simple-bezier",
  animated: false,
  class: ({ sourceNode, targetNode }: GraphEdge) => {
    if (!sourceNode.selected && !sourceNode.dragging && !targetNode.selected && !targetNode.dragging) return "";
    return [generalSettings.value.canvasEdgeColorMode !== "none" && "edgeActive", generalSettings.value.canvasEdgeAnimationEnabled && "animated"].filter(Boolean).join(" ");
  },
  focusable: false,
  selectable: false,
  updatable: false,
  interactionWidth: 40,
});
</script>

<style lang="scss" scoped>
.canvas {
  width: 100%;
  height: 100%;
  .canvasConflict {
    position: absolute; top: 8px; left: 50%; transform: translateX(-50%); z-index: 10;
    display: flex; align-items: center; gap: 8px; padding: 8px; max-width: 90%;
    background: var(--el-bg-color); border: 1px solid var(--el-color-warning); border-radius: var(--ui-radius);
  }

  &.compositingEnabled :deep(.vue-flow__transformationpane) {
    will-change: transform;
  }

  &.handMode :deep(.vue-flow__transformationpane),
  &.handMode :deep(.vue-flow__transformationpane *) {
    pointer-events: none !important;
  }

  &.handMode :deep(.vue-flow__pane) {
    cursor: grab;
  }

  &.edgesHidden :deep(.vue-flow__edges) {
    display: none;
  }
  &.edgesHidden :deep(.vue-flow__handle) {
    display: none !important;
  }

  :deep(.vue-flow__edge.edgeActive .vue-flow__edge-path) {
    stroke: var(--canvasEdgeColor);
  }

  &:has(.selectionConnection) :deep(.vue-flow__node:not(.selected) .nodeHandle.target .handleIcon) {
    opacity: 1;
  }

  :deep(.vue-flow__nodesselection-rect) {
    box-sizing: content-box;
    padding: 8px;
    margin: -8px;
    border-radius: 4px;
  }
}
.edgeDisconnect {
  position: fixed;
  z-index: 1000;
  width: 32px;
  height: 32px;
  padding: 0;
  transform: translate(-50%, -50%);
}
</style>
