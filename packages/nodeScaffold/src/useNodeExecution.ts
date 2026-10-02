import { computed, inject, onScopeDispose } from "vue";
import { useNodeId } from "@vue-flow/core";
import type { CanvasCommandResult, NodeExecutionDescriptor } from "./execution";
import { createExecutionClient } from "./executionClient";

export type NodeExecutionTarget = { directory: string; canvasPath: string; version: number; descriptor: NodeExecutionDescriptor };
export type NodeExecutionHost = {
  getTarget(nodeId: string): NodeExecutionTarget;
  beforeCommand?(target: NodeExecutionTarget): Promise<void>;
  refresh?(target: NodeExecutionTarget): Promise<void>;
};
export type NodeActionOptions = { commandId?: string; signal?: AbortSignal; expectedVersion?: number };

export function useNodeExecution(nodeId = useNodeId()) {
  const host = inject<NodeExecutionHost | undefined>("nodeExecution", undefined);
  const lifetime = new AbortController();
  onScopeDispose(() => lifetime.abort());
  function target() {
    if (!host || !nodeId) throw new Error("节点未接入后端执行协议，请迁移插件");
    return host.getTarget(nodeId);
  }
  const descriptor = computed(() => { try { return target().descriptor; } catch { return undefined; } });

  async function command(name: string, args: Record<string, unknown> = {}, options: NodeActionOptions = {}) {
    const initial = target();
    const action = name.startsWith("node:") ? name : `node:${name}`;
    if (!initial.descriptor.actions.some(item => item.name === action || `node:${item.name}` === action)) throw new Error(`节点未注册后端动作：${action}`);
    await host!.beforeCommand?.(initial);
    const current = target();
    if (initial.directory !== current.directory || initial.canvasPath !== current.canvasPath || initial.descriptor.executionRevision !== current.descriptor.executionRevision) throw new Error("节点上下文已切换，请重新操作");
    const signal = options.signal ? AbortSignal.any([lifetime.signal, options.signal]) : lifetime.signal;
    const client = createExecutionClient(initial.directory);
    const result = await client.command({
      commandId: options.commandId,
      canvasPath: initial.canvasPath,
      name: "nodeTools",
      args: { nodeId, name: action, args, expectedNodeRevision: initial.descriptor.executionRevision },
      expectedVersions: { [nodeId]: options.expectedVersion ?? current.version },
    }, signal);
    await host!.refresh?.(initial);
    return result;
  }

  async function call<T = unknown>(name: string, args: Record<string, unknown> = {}, options: NodeActionOptions = {}): Promise<T> {
    const initial = target();
    let result: CanvasCommandResult = await command(name, args, options);
    const client = createExecutionClient(initial.directory);
    const signal = AbortSignal.any([lifetime.signal, AbortSignal.timeout(120_000), ...(options.signal ? [options.signal] : [])]);
    while (result.status === "accepted" || result.status === "running") {
      await new Promise<void>((resolve, reject) => {
        const cancel = () => { clearTimeout(timer); reject(signal.reason); };
        const timer = setTimeout(() => { signal.removeEventListener("abort", cancel); resolve(); }, 500);
        signal.addEventListener("abort", cancel, { once: true });
        if (signal.aborted) cancel();
      });
      signal.throwIfAborted();
      result = await client.getCommand(result.commandId, signal) ?? result;
    }
    await host!.refresh?.(initial);
    if (result.status !== "completed") throw new Error(result.errorMessage || "后端动作需要核对或已失败");
    return result.result as T;
  }

  return {
    descriptor, command, call,
    readText: (path: string) => createExecutionClient(target().directory).readContent(path, lifetime.signal),
    writeText: (path: string, content: string, expectedRevision: string, commandId?: string) => createExecutionClient(target().directory).writeContent(path, content, expectedRevision, commandId, lifetime.signal),
    getJob: (jobId: string) => createExecutionClient(target().directory).getJob(jobId, lifetime.signal),
  };
}
