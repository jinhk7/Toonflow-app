import type { Ref } from "vue";
import { useVueFlow } from "@vue-flow/core";
import type { CanvasContext } from "@toonflow/tool-canvas/runtime";
import useWorkspaceExecution from "@/lib/workspaceExecution";
import { getExecutionClientId } from "@toonflow/nodes-scaffold/runtime";

export function useCanvasTools(options: {
  availableNodes: Ref<{ type: string; label: string }[]>;
  flushSave(): Promise<void>;
  refresh?(): Promise<void | boolean>;
  menu(): {
    getCanvases(): { id: string; name: string }[];
    refreshCanvases(rename?: { previous: string; target: string }): Promise<void>;
    addCanvas(name?: string, signal?: AbortSignal): Promise<string>;
    switchCanvas(canvasId: string, signal?: AbortSignal): Promise<void>;
    renameCanvas(canvasId: string, name: string, signal?: AbortSignal): Promise<void>;
  };
  getCanvasBinding(): { id: string; signal: AbortSignal };
  resolveCanvasContext?(id: string): CanvasContext | undefined;
}) {
  const flow = useVueFlow();
  const getClient = useWorkspaceExecution();
  return (id: string, canvasSignal: AbortSignal, workspaceSignal: AbortSignal): CanvasContext => {
    const client = getClient();
    let redirected: CanvasContext | undefined;
    return {
      get id() { return redirected?.id ?? id; },
      tools: [],
      getNodeLabel(nodeId) {
        if (redirected) return redirected.getNodeLabel?.(nodeId);
        const node = flow.findNode(nodeId);
        const label = node?.data.label ?? node?.label;
        return typeof label === "string" && label.trim() ? label : undefined;
      },
      async call(request, signal) {
        if (redirected) return redirected.call(request, signal);
        const callSignal = AbortSignal.any([canvasSignal, workspaceSignal, ...(signal ? [signal] : [])]);
        callSignal.throwIfAborted();
        await options.flushSave();
        callSignal.throwIfAborted();
        const result = await client.execute({
          canvasPath: id, name: request.name, args: request.args,
          clientContext: { clientId: getExecutionClientId(), selectedNodeIds: flow.getSelectedNodes.value.map(node => node.id) },
        }, callSignal);
        if (["addCanvas", "switchCanvas", "renameCanvas"].includes(request.name)) {
          const target = (result as { canvasId?: unknown })?.canvasId;
          if (typeof target === "string") {
            await options.menu().refreshCanvases(request.name === "renameCanvas" ? { previous: id, target } : undefined);
            await options.menu().switchCanvas(target);
            id = target;
            redirected = options.resolveCanvasContext?.(target);
          }
        }
        await options.refresh?.();
        return result;
      },
    };
  };
}
