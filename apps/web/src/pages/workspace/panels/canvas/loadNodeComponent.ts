import type { NodeTypesObject } from "@vue-flow/core";

type NodeComponent = Exclude<NodeTypesObject[string], string>;

const components = new Map<string, NodeComponent>();
const componentRevisions = new WeakMap<object, string>();
const requests = new Map<string, { revision: string; promise: Promise<NodeComponent> }>();

export function getLoadedNodeRevision(component?: object | string) {
  return component && typeof component !== "string" ? componentRevisions.get(component) : undefined;
}

export function loadNodeComponent(name: string, url: string, revision: string, force = false): Promise<NodeComponent> {
  if (!/^[a-f0-9]{64}$/.test(revision)) return Promise.reject(new Error("节点脚本版本无效"));
  const pending = requests.get(name);
  if (pending) return pending.revision === revision ? pending.promise : pending.promise.catch(() => {}).then(() => loadNodeComponent(name, url, revision, force));
  const key = `${name}:${revision}`;
  const nodeWindow = window as typeof window & { toonflowNodes?: NodeTypesObject };
  const cached = components.get(key);
  if (!force && cached && (typeof cached === "object" || typeof cached === "function")) {
    return Promise.resolve(cached);
  }
  components.delete(key);
  // ACT: 同名节点只加载一份脚本，所有画布共享进行中的重载，避免互相清除全局导出。
  const request = new Promise<NodeComponent>((resolve, reject) => {
    delete nodeWindow.toonflowNodes?.[name];
    const script = document.createElement("script");
    script.src = force ? `${url}${url.includes("?") ? "&" : "?"}reload=${crypto.randomUUID()}` : url;
    script.integrity = `sha256-${btoa(String.fromCharCode(...revision.match(/../g)!.map(byte => parseInt(byte, 16))))}`;
    script.crossOrigin = "anonymous";
    script.onload = () => {
      script.remove();
      const component = nodeWindow.toonflowNodes?.[name];
      if (!Object.hasOwn(nodeWindow.toonflowNodes ?? {}, name) || !component || (typeof component !== "object" && typeof component !== "function")) {
        reject(new Error(`节点脚本未导出 ${name} 组件`));
        return;
      }
      resolve(component);
    };
    script.onerror = () => {
      script.remove();
      delete nodeWindow.toonflowNodes?.[name];
      reject(new Error("节点脚本加载失败"));
    };
    document.head.append(script);
  }).then(component => {
    components.set(key, component);
    componentRevisions.set(component, revision);
    return component;
  }).finally(() => requests.delete(name));
  requests.set(name, { revision, promise: request });
  return request;
}
