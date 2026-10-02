import { computed, getCurrentInstance, inject, readonly, type Component } from "vue";
import { useNode as useFlowNode, useVueFlow } from "@vue-flow/core";
import type { NodeData, NodeHandle } from "./connection";
import type { NodeOutputs } from "./values";
import { useNodeEvent } from "./nodeEvent";
import { nodeTools } from "./nodeTools";
import { useNodeFiles } from "./workspaceFiles";
import { useNodeAi } from "./nodeAi";
import { useNodeFfmpeg } from "./nodeFfmpeg";
import { useNodePreviewReady } from "./useNodePreviewReady";
import { useNodeExecution } from "./useNodeExecution";

export type NodeOptions<T extends NodeOutputs = NodeOutputs> = {
  label?: string;
  icon?: Component;
  handles?: NodeHandle[];
  outputs?: T;
};

export function useNode<T extends NodeOutputs = NodeOutputs>(options: NodeOptions<T> = {}) {
  const { id, node } = useFlowNode<NodeData>();
  const getNodeConfig = inject<((nodeType: string) => Record<string, unknown>) | undefined>("nodeConfig", undefined);
  const config = computed(() => readonly(getNodeConfig?.(node.type ?? "") ?? {}));
  const previewReady = useNodePreviewReady();
  const { updateNodeInternals } = useVueFlow();
  const defaults = getCurrentInstance()?.type as Pick<NodeOptions, "handles" | "icon"> | undefined;
  const execution = useNodeExecution(id);
  const handles = computed<NodeHandle[]>(() => execution.descriptor.value?.handles ?? node.data.handles ?? options.handles ?? defaults?.handles ?? []);
  const outputs = computed(() => readonly(node.data.outputs ?? {}) as T);
  const nodeProps = computed(() => ({
    previewReady: previewReady.value,
    label: node.data.label ?? options.label,
    icon: options.icon ?? defaults?.icon,
    handles: handles.value,
    outputs: outputs.value,
  }));
  const nodeEvent = useNodeEvent();
  const { getWorkspaceFiles, uploadFile, removeNodeFiles, useFileUrl } = useNodeFiles();

  return {
    id,
    node,
    config,
    previewReady,
    nodeProps,
    handles,
    outputs,
    nodeEvent,
    nodeTools,
    execution,
    ai: useNodeAi(),
    ffmpeg: useNodeFfmpeg(),
    files: {
      getWorkspaceFiles,
      useFileUrl,
      uploadFile: (file: File) => uploadFile(id, file),
      removeNodeFiles: () => removeNodeFiles(id),
    },
    updateNodeInternals: () => updateNodeInternals([id]),
  };
}
