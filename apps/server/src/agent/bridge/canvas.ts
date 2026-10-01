import { canvasOperations } from "@toonflow/tool-canvas/runtime";
import type { CanvasInfo, CanvasContext } from "@toonflow/tools-scaffold/runtime";
import type { AgentEvent } from "@/agent/runtime/types";

type CanvasResult = { result?: unknown; error?: string };
type PendingCall = { cwd: string; finish(response: CanvasResult): void };

// ACT: 画布调用在运行存活期间持久等待；多进程部署需共享请求通道。
const pendingCalls = new Map<string, PendingCall>();

export function createCanvasContext(
  cwd: string,
  canvas: CanvasInfo,
  send: (event: Extract<AgentEvent, { type: "canvasCall" }>) => void,
  _options?: { runId?: string },
) {
  const activeCalls = new Set<string>();
  let queue = Promise.resolve();
  let disposed = false;
  const context: CanvasContext = {
    ...canvas,
    get id() { return canvas.id; },
    set id(id: string) { canvas.id = id; },
    async call(request, signal) {
      const pending = queue.then(() => {
        if (disposed) throw new Error("画布调用所属对话已结束");
        signal?.throwIfAborted();
        const operation = canvasOperations.find(item => item.name === request.name);
        if (!operation) throw new Error("画布操作不存在");
        const args = operation.parameters.parse(request.args);
        const callId = crypto.randomUUID();
        return new Promise((resolve, reject) => {
          const finish = ({ result, error }: CanvasResult) => {
            if (!pendingCalls.delete(callId)) return;
            activeCalls.delete(callId);
            clearTimeout(timer);
            signal?.removeEventListener("abort", abort);
            if (error !== undefined) reject(new Error(error || "画布调用失败"));
            else {
              if (["addCanvas", "switchCanvas", "renameCanvas"].includes(operation.name)) {
                context.id = result && typeof result === "object" && "id" in result && typeof result.id === "string" ? result.id : "";
              }
              resolve(result);
            }
          };
          const abort = () => finish({ error: "画布调用已取消" });
          const timer = setTimeout(() => finish({ error: "画布调用超时，请确认画布仍然打开" }), 120000);
          pendingCalls.set(callId, { cwd, finish });
          activeCalls.add(callId);
          signal?.addEventListener("abort", abort, { once: true });
          try { send({ type: "canvasCall", callId, name: operation.name, args }); }
          catch (error) { finish({ error: (error instanceof Error ? error.message : "") || "发送画布调用失败" }); }
        });
      });
      queue = pending.then(() => {}, () => {});
      return pending;
    },
  };
  return {
    context,
    dispose() {
      disposed = true;
      for (const callId of activeCalls) pendingCalls.get(callId)?.finish({ error: "画布调用所属对话已结束" });
    },
    detach() {
      // HTTP 断开时不取消画布调用，等待页面回传结果。
    },
  };
}

export function finishCanvasCall(cwd: string, callId: string, response: CanvasResult) {
  const pending = pendingCalls.get(callId);
  if (!pending) return;
  if (pending.cwd !== cwd) throw Object.assign(new Error("画布调用不存在或已结束"), { status: 404 });
  pending.finish(response);
}
