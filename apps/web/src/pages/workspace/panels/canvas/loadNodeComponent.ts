import type { NodeTypesObject } from "@vue-flow/core";

type NodeComponent = Exclude<NodeTypesObject[string], string>;

const components = new Map<string, NodeComponent>();
const componentRevisions = new WeakMap<object, string>();
const requests = new Map<string, { revision: string; promise: Promise<NodeComponent> }>();

function freezeNodeComponent(component: NodeComponent) {
  const seen = new WeakSet<object>();
  function freeze(value: unknown) {
    if (!value || (typeof value !== "object" && typeof value !== "function") || seen.has(value)) return;
    // ACT: 只固化组件自身可达选项，不沿原型链或调用访问器；保留 String/Object 等原生构造器的宿主行为。
    if (typeof value === "function" && /^function\b[^{}]*\{\s*\[native code\]\s*\}$/.test(Reflect.apply(Function.prototype.toString, value, []))) return;
    seen.add(value);
    const descriptors = Object.getOwnPropertyDescriptors(value);
    Object.freeze(value);
    for (const key of Reflect.ownKeys(descriptors)) {
      const descriptor: PropertyDescriptor = Reflect.get(descriptors, key);
      if ("value" in descriptor) freeze(descriptor.value);
      else { freeze(descriptor.get); freeze(descriptor.set); }
    }
  }
  freeze(component);
  if (!Object.isFrozen(component)) throw new Error("节点组件无法固化");
}

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
    const namespace = nodeWindow.toonflowNodes ?? (nodeWindow.toonflowNodes = {});
    let component: NodeComponent | undefined;
    const script = document.createElement("script");
    script.src = force ? `${url}${url.includes("?") ? "&" : "?"}reload=${crypto.randomUUID()}` : url;
    script.integrity = `sha256-${btoa(String.fromCharCode(...revision.match(/../g)!.map(byte => parseInt(byte, 16))))}`;
    script.crossOrigin = "anonymous";
    Object.defineProperty(namespace, name, {
      configurable: true,
      enumerable: true,
      get: () => component,
      set(value: NodeTypesObject[string]) {
        if (document.currentScript !== script) return;
        component = undefined;
        if (!value || (typeof value !== "object" && typeof value !== "function")) return;
        freezeNodeComponent(value);
        component = value;
      },
    });
    script.onload = () => {
      script.remove();
      if (!component) {
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
