import { getCurrentScope, inject } from "vue";
import { z } from "zod";
import { useVueFlow } from "@vue-flow/core";
import type { NodeToolInfo, NodeToolsContext } from "@toonflow/tools-scaffold/runtime";
import type { NodeExecutionHost } from "./useNodeExecution";
import { createExecutionClient } from "./executionClient";

export { z };
export type { NodeToolCall, NodeToolInfo, NodeToolsContext } from "@toonflow/tools-scaffold/runtime";

export interface NodeToolDefinition<Schema extends z.ZodType = z.ZodType> {
  name: string;
  description: string;
  parameters: Schema;
  execute(args: z.output<Schema>, context: { signal?: AbortSignal }): unknown | Promise<unknown>;
}

export const nodeTools = Object.freeze({
  register<Schema extends z.ZodType>(definition: NodeToolDefinition<Schema>) {
    if (!getCurrentScope()) throw new Error("请在节点 setup 中注册 nodeTools");
    if (!/^[a-z][a-zA-Z0-9]{0,63}$/.test(definition.name)) throw new Error("节点函数名必须使用小驼峰，最多 64 个字符");
    if (!definition.description.trim() || z.toJSONSchema(definition.parameters, { io: "input", target: "draft-07" }).type !== "object") throw new Error("节点函数需要描述与 Zod 对象参数");
    // ACT: 保留旧 UI 的注册调用形状；执行与来源证明只存在后端，客户端不保存或执行回调。
    return () => {};
  },
});

// 节点动作只从后端描述发现；Vue 注册表不再承担业务执行或来源授权。
export function useNodeToolsContext(_resolveNodeRevision?: (component?: object) => string | undefined) {
  const flow = useVueFlow();
  const host = inject<NodeExecutionHost | undefined>("nodeExecution", undefined);
  function* list(nodeIds: string[], names?: string[]): IterableIterator<NodeToolInfo> {
    for (const nodeId of new Set(nodeIds)) {
      const node = flow.findNode(nodeId);
      if (!node || !host) continue;
      let target;
      try { target = host.getTarget(nodeId); } catch { continue; }
      for (const action of target.descriptor.actions) {
        const name = (action.name.startsWith("node:") ? action.name : `node:${action.name}`) as NodeToolInfo["name"];
        if (names && !names.includes(name)) continue;
        yield { nodeId, name, description: action.description, parameters: action.parameters,
          nodeLabel: String(node.data.label ?? nodeId), nodeRevision: target.descriptor.executionRevision };
      }
    }
  }
  return (): NodeToolsContext => ({
    get tools() { return [...list(flow.getNodes.value.map(node => node.id))]; },
    get version() { return flow.getNodes.value.reduce((version, node) => { try { return version + (host?.getTarget(node.id).version ?? 0); } catch { return version; } }, 0); },
    list,
    async call({ nodeId, name, args, expectedNodeRevision }, signal) {
      if (!host) throw new Error("当前画布未接入后端执行协议");
      const initial = host.getTarget(nodeId);
      if (expectedNodeRevision && expectedNodeRevision !== initial.descriptor.executionRevision) throw new Error("节点执行版本已变化，请重新查询");
      await host.beforeCommand?.(initial);
      const current = host.getTarget(nodeId);
      if (initial.directory !== current.directory || initial.canvasPath !== current.canvasPath || initial.descriptor.executionRevision !== current.descriptor.executionRevision) throw new Error("节点上下文已切换");
      const result = await createExecutionClient(initial.directory).execute({
        canvasPath: initial.canvasPath, name: "nodeTools",
        args: { nodeId, name, args, expectedNodeRevision: initial.descriptor.executionRevision },
        expectedVersions: { [nodeId]: current.version },
      }, signal);
      await host.refresh?.(initial);
      return result;
    },
  });
}
