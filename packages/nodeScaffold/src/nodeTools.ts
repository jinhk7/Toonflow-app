import { getCurrentInstance, getCurrentScope, onScopeDispose } from "vue";
import { z } from "zod";
import { useNodeId, useVueFlow } from "@vue-flow/core";
import type { NodeToolInfo, NodeToolsContext } from "@toonflow/tools-scaffold/runtime";

export { z };
export type { NodeToolCall, NodeToolInfo, NodeToolsContext } from "@toonflow/tools-scaffold/runtime";

export interface NodeToolDefinition<Schema extends z.ZodType = z.ZodType> {
  name: string;
  description: string;
  parameters: Schema;
  execute(args: z.output<Schema>, context: { signal?: AbortSignal }): unknown | Promise<unknown>;
}

type RegisteredNodeTool = NodeToolInfo & Pick<NodeToolDefinition, "execute"> & { component?: object };
type NodeToolsIndex = { nodes: Map<string, Map<string, RegisteredNodeTool>>; version: number };
// 来源只存宿主闭包；复制共享条目不能复制注册证明。
const nodeToolSources = new WeakMap<RegisteredNodeTool, { nodeId: string; name: RegisteredNodeTool["name"]; execute: RegisteredNodeTool["execute"]; component: object }>();
// ACT: 在插件执行前固定证明存取与调用能力，后续原型覆写不能读取或伪造宿主私有来源。
const getNodeToolSource = nodeToolSources.get.bind(nodeToolSources);
const setNodeToolSource = nodeToolSources.set.bind(nodeToolSources);
const deleteNodeToolSource = nodeToolSources.delete.bind(nodeToolSources);
const apply = Reflect.apply;
const defineProperty = Object.defineProperty;
const defineProperties = Object.defineProperties;
const freeze = Object.freeze;
const regExpExec = RegExp.prototype.exec;
const stringTrim = String.prototype.trim;
const toJSONSchema = z.toJSONSchema;
const mapConstructor = Map;
const mapGet = Map.prototype.get;
const mapSet = Map.prototype.set;
const mapDelete = Map.prototype.delete;
const mapClear = Map.prototype.clear;
const mapValues = Map.prototype.values;
const mapKeys = Map.prototype.keys;
const mapSize = Object.getOwnPropertyDescriptor(Map.prototype, "size")!.get!;
const setConstructor = Set;
const setHas = Set.prototype.has;
const promiseConstructor = Promise;
const promiseResolve = Promise.resolve;
const promiseThen = Promise.prototype.then;

// 共享 Vue Flow 实例上的注册表供各 UMD 访问，不进入画布 JSON。
const nodeToolsKey = Symbol.for("toonflow.nodeTools");
const nodeToolsIndexKey = Symbol.for("toonflow.nodeToolsIndex");

function getRegistry(flow: ReturnType<typeof useVueFlow>) {
  const host = flow as typeof flow & {
    [nodeToolsKey]?: Map<string, RegisteredNodeTool>;
    [nodeToolsIndexKey]?: NodeToolsIndex;
  };
  if (!host[nodeToolsKey]) defineProperty(host, nodeToolsKey, { value: new mapConstructor<string, RegisteredNodeTool>() });
  const registry = host[nodeToolsKey]!;
  if (!host[nodeToolsIndexKey]) {
    const index: NodeToolsIndex = { nodes: new mapConstructor(), version: 0 };
    const add = (entry: RegisteredNodeTool) => {
      let node = apply(mapGet, index.nodes, [entry.nodeId]);
      if (!node) apply(mapSet, index.nodes, [entry.nodeId, node = new mapConstructor()]);
      apply(mapSet, node, [entry.name, entry]);
    };
    const remove = (entry: RegisteredNodeTool) => {
      const node = apply(mapGet, index.nodes, [entry.nodeId]);
      if (!node || apply(mapGet, node, [entry.name]) !== entry) return;
      apply(mapDelete, node, [entry.name]);
      if (!apply(mapSize, node, [])) apply(mapDelete, index.nodes, [entry.nodeId]);
    };
    for (const entry of apply(mapValues, registry, [])) add(entry);
    // ACT: 旧 UMD 仍写原 Map；在共享 Map 上同步索引，避免每次读取扫描全部节点函数。
    defineProperties(registry, {
      set: { value(this: Map<string, RegisteredNodeTool>, key: string, entry: RegisteredNodeTool) {
        const previous = apply(mapGet, this, [key]);
        if (this === registry) {
          const component = getCurrentInstance()?.type;
          const { nodeId, name, execute } = entry;
          if (component && key === `${nodeId}:${name}` && typeof execute === "function")
            setNodeToolSource(entry, { nodeId, name, execute, component });
          else deleteNodeToolSource(entry);
        }
        apply(mapSet, this, [key, entry]);
        if (this === registry && previous !== entry) {
          if (previous) remove(previous);
          add(entry);
          index.version++;
        }
        return this;
      } },
      delete: { value(this: Map<string, RegisteredNodeTool>, key: string) {
        const entry = apply(mapGet, this, [key]);
        const deleted = apply(mapDelete, this, [key]);
        if (this === registry && deleted) {
          remove(entry!);
          index.version++;
        }
        return deleted;
      } },
      clear: { value(this: Map<string, RegisteredNodeTool>) {
        const size = apply(mapSize, this, []);
        apply(mapClear, this, []);
        if (this === registry && size) {
          apply(mapClear, index.nodes, []);
          index.version++;
        }
      } },
    });
    defineProperty(host, nodeToolsIndexKey, { value: index });
  }
  return { registry, index: host[nodeToolsIndexKey]! };
}

export const nodeTools = freeze({
  register<Schema extends z.ZodType>(definition: NodeToolDefinition<Schema>) {
    if (!getCurrentScope()) throw new Error("请在节点 setup 中注册 nodeTools");
    const nodeId = useNodeId();
    if (!nodeId) throw new Error("当前组件不属于画布节点");
    if (!apply(regExpExec, /^[a-z][a-zA-Z0-9]{0,63}$/, [definition.name])) throw new Error("节点函数名必须使用小驼峰，最多 64 个字符");
    const parameters = toJSONSchema(definition.parameters, { io: "input", target: "draft-07" });
    const description = apply(stringTrim, definition.description, []);
    if (!description || parameters.type !== "object" || typeof definition.execute !== "function") {
      throw new Error("节点函数需要描述、Zod 对象参数和 execute 方法");
    }
    const { registry } = getRegistry(useVueFlow());
    const name = `node:${definition.name}` as const;
    const key = `${nodeId}:${name}`;
    const entry: RegisteredNodeTool = {
      nodeId, name, description,
      parameters,
      async execute(args, context) {
        const parsed = await definition.parameters.parseAsync(args);
        context.signal?.throwIfAborted();
        return definition.execute(parsed, context);
      },
    };
    registry.set(key, entry);
    const unregister = () => { if (apply(mapGet, registry, [key]) === entry) registry.delete(key); };
    onScopeDispose(unregister);
    return unregister;
  },
});

// 在画布 setup 中创建，按需读取当前节点函数，不复制全量注册表。
export function useNodeToolsContext(resolveNodeRevision?: (component?: object) => string | undefined) {
  const flow = useVueFlow();
  const { registry, index } = getRegistry(flow);
  function* list(nodeIds: string[], names?: string[]): IterableIterator<NodeToolInfo> {
    const nameSet = names ? new setConstructor(names) : undefined;
    for (const nodeId of new setConstructor(nodeIds)) {
      const node = flow.findNode(nodeId);
      if (!node) continue;
      const tools = apply(mapGet, index.nodes, [nodeId]);
      for (const entry of tools ? apply(mapValues, tools, []) : []) {
        if (nameSet && !apply(setHas, nameSet, [entry.name])) continue;
        const { execute, component: _component, ...info } = entry;
        const source = getNodeToolSource(entry);
        const nodeRevision = source && source.nodeId === nodeId && source.nodeId === info.nodeId && source.name === info.name && source.execute === execute
          ? resolveNodeRevision?.(source.component) : undefined;
        yield { ...info, nodeLabel: String(node.data.label ?? node.label ?? nodeId), nodeRevision };
      }
    }
  }
  return (): NodeToolsContext => ({
    get tools() { return [...list([...apply(mapKeys, index.nodes, [])])]; },
    get version() { return index.version; },
    list,
    async call({ nodeId, name, args, expectedNodeRevision }, signal) {
      const timeout = AbortSignal.timeout(120000);
      const callSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
      callSignal.throwIfAborted();
      const key = `${nodeId}:${name}`;
      const entry: RegisteredNodeTool | undefined = apply(mapGet, registry, [key]);
      if (!entry) throw new Error(`节点未注册函数 ${name}，请先通过 getNodeTools 查询可用节点函数`);
      const { nodeId: entryNodeId, name: entryName, execute } = entry;
      const source = getNodeToolSource(entry);
      if (!flow.findNode(nodeId)) throw new Error("节点函数已卸载或不属于本轮画布");
      let cancel: () => void = () => {};
      try {
        const result = await new promiseConstructor((resolve, reject) => {
          cancel = () => reject(callSignal.reason);
          callSignal.addEventListener("abort", cancel, { once: true });
          try {
            callSignal.throwIfAborted();
            if (apply(mapGet, registry, [key]) !== entry || !flow.findNode(nodeId)) throw new Error("节点函数已卸载或不属于本轮画布");
            if (expectedNodeRevision !== undefined && (!source || source.nodeId !== nodeId || source.name !== name || source.execute !== execute
              || entryNodeId !== nodeId || entryName !== name || resolveNodeRevision?.(source.component) !== expectedNodeRevision))
              throw new Error("节点脚本版本已变化或无法确认，请重新查询节点函数");
            const pending = apply(promiseResolve, promiseConstructor, [apply(execute, entry, [args, { signal: callSignal }])]);
            apply(promiseThen, pending, [resolve, reject]);
          } catch (error) { reject(error); }
        });
        callSignal.throwIfAborted();
        return result ?? null;
      } finally {
        callSignal.removeEventListener("abort", cancel);
      }
    },
  });
}
