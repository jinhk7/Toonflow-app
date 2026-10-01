import type { NodeTypesObject } from "@vue-flow/core";

type NodeComponent = Exclude<NodeTypesObject[string], string>;
type NodeHost = { vue: object; vueFlow: object; elementPlus: object; ai: object };

// ACT: UMD 与宿主共享 realm；来源证明只使用加载首个 UMD 前捕获的原生能力。
const apply = Reflect.apply;
const defineProperty = Object.defineProperty;
const createObject = Object.create;
const freezeObject = Object.freeze;
const isFrozen = Object.isFrozen;
const getDescriptors = Object.getOwnPropertyDescriptors;
const hasOwnProperty = Object.prototype.hasOwnProperty;
const ownKeys = Reflect.ownKeys;
const getProperty = Reflect.get;
const functionToString = Function.prototype.toString;
const regexpExec = RegExp.prototype.exec;
const weakSet = WeakSet;
const weakSetHas = WeakSet.prototype.has;
const weakSetAdd = WeakSet.prototype.add;
const encodeBase64 = window.btoa;
const fromCharCode = String.fromCharCode;
const parseHex = parseInt;
const createElement = Document.prototype.createElement;
const setAttribute = Element.prototype.setAttribute;
const appendChild = Node.prototype.appendChild;
const removeChild = Node.prototype.removeChild;
const addEventListener = EventTarget.prototype.addEventListener;
const currentScript = Object.getOwnPropertyDescriptor(Document.prototype, "currentScript")!.get!;
const documentHead = Object.getOwnPropertyDescriptor(Document.prototype, "head")!.get!;
const parentNode = Object.getOwnPropertyDescriptor(Node.prototype, "parentNode")!.get!;
const revisionPattern = /^[a-f0-9]{64}$/;
const nativeFunctionPattern = /^function\b[^{}]*\{\s*\[native code\]\s*\}$/;

const components = new Map<string, NodeComponent>();
const componentRevisions = new WeakMap<object, string>();
const requests = new Map<string, { revision: string; promise: Promise<NodeComponent> }>();
const nodeExports = new Map<string, PropertyDescriptor>();
const getComponent = components.get.bind(components);
const setComponent = components.set.bind(components);
const deleteComponent = components.delete.bind(components);
const getRevision = componentRevisions.get.bind(componentRevisions);
const setRevision = componentRevisions.set.bind(componentRevisions);
const getRequest = requests.get.bind(requests);
const setRequest = requests.set.bind(requests);
const deleteRequest = requests.delete.bind(requests);
const setExport = nodeExports.set.bind(nodeExports);
const deleteExport = nodeExports.delete.bind(nodeExports);
const forEachExport = nodeExports.forEach.bind(nodeExports);
let namespace: NodeTypesObject = freezeObject(createObject(null));
let nodeHost: NodeHost | undefined;

const browserWindow = window as typeof window & { define?: unknown; module?: unknown; exports?: unknown };
const ambientModules = ["define", "module", "exports"] as const;
for (let index = 0; index < ambientModules.length; index++) {
  const name = ambientModules[index]!;
  if (browserWindow[name] !== undefined) throw new Error("节点脚本不支持模块加载器");
  defineProperty(window, name, { value: undefined, configurable: false, writable: false });
}
defineProperty(window, "toonflowNodes", { get: () => namespace, set: () => {}, configurable: false });

export function initializeNodeHost(host: NodeHost) {
  if (nodeHost) return;
  freezeObject(host.ai);
  freezeObject(host);
  defineProperty(window, "toonflowNodeHost", { value: host, configurable: false, writable: false });
  nodeHost = host;
}

function refreshNodeExports() {
  const nextNamespace: NodeTypesObject = createObject(null);
  forEachExport((descriptor, name) => defineProperty(nextNamespace, name, descriptor));
  namespace = freezeObject(nextNamespace);
}

function freezeNodeComponent(component: NodeComponent) {
  const seen = new weakSet<object>();
  function freeze(value: unknown) {
    if (!value || (typeof value !== "object" && typeof value !== "function") || apply(weakSetHas, seen, [value])) return;
    // ACT: 只固化组件自身可达选项，不沿原型链或调用访问器；保留 String/Object 等原生构造器的宿主行为。
    if (typeof value === "function" && apply(regexpExec, nativeFunctionPattern, [apply(functionToString, value, [])])) return;
    apply(weakSetAdd, seen, [value]);
    const descriptors = getDescriptors(value);
    freezeObject(value);
    const keys = ownKeys(descriptors);
    for (let index = 0; index < keys.length; index++) {
      const descriptor: PropertyDescriptor = getProperty(descriptors, keys[index]!);
      if (apply(hasOwnProperty, descriptor, ["value"])) freeze(descriptor.value);
      else { freeze(descriptor.get); freeze(descriptor.set); }
    }
  }
  freeze(component);
  if (!isFrozen(component)) throw new Error("节点组件无法固化");
}

export function getLoadedNodeRevision(component?: object | string) {
  return component && typeof component !== "string" ? getRevision(component) : undefined;
}

export function loadNodeComponent(name: string, url: string, revision: string, force = false): Promise<NodeComponent> {
  if (!apply(regexpExec, revisionPattern, [revision])) return Promise.reject(new Error("节点脚本版本无效"));
  const pending = getRequest(name);
  if (pending) return pending.revision === revision ? pending.promise : pending.promise.catch(() => {}).then(() => loadNodeComponent(name, url, revision, force));
  const key = `${name}:${revision}`;
  const cached = getComponent(key);
  if (!force && cached && (typeof cached === "object" || typeof cached === "function")) {
    return Promise.resolve(cached);
  }
  deleteComponent(key);
  // ACT: 同名节点只加载一份脚本，所有画布共享进行中的重载，避免互相清除全局导出。
  const request = new Promise<NodeComponent>((resolve, reject) => {
    let component: NodeComponent | undefined;
    const script = apply(createElement, document, ["script"]);
    let digest = "";
    for (let index = 0; index < revision.length; index += 2) digest += fromCharCode(parseHex(revision[index]! + revision[index + 1]!, 16));
    apply(setAttribute, script, ["src", force ? `${url}${url.includes("?") ? "&" : "?"}reload=${crypto.randomUUID()}` : url]);
    apply(setAttribute, script, ["integrity", `sha256-${apply(encodeBase64, window, [digest])}`]);
    apply(setAttribute, script, ["crossorigin", "anonymous"]);
    setExport(name, {
      enumerable: true,
      get: () => component,
      set(value: NodeTypesObject[string]) {
        if (apply(currentScript, document, []) !== script) return;
        component = undefined;
        if (!value || (typeof value !== "object" && typeof value !== "function")) return;
        freezeNodeComponent(value);
        setRevision(value, revision);
        component = value;
      },
    });
    refreshNodeExports();
    function removeScript() {
      const parent: Node | null = apply(parentNode, script, []);
      if (parent) apply(removeChild, parent, [script]);
    }
    apply(addEventListener, script, ["load", () => {
      removeScript();
      if (!component) {
        reject(new Error(`节点脚本未导出 ${name} 组件`));
        return;
      }
      resolve(component);
    }, { once: true }]);
    apply(addEventListener, script, ["error", () => {
      removeScript();
      deleteExport(name);
      refreshNodeExports();
      reject(new Error("节点脚本加载失败"));
    }, { once: true }]);
    apply(appendChild, apply(documentHead, document, []), [script]);
  }).then(component => {
    setComponent(key, component);
    return component;
  }).finally(() => deleteRequest(name));
  setRequest(name, { revision, promise: request });
  return request;
}
