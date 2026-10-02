import axios from "axios";
import { toValue, type MaybeRefOrGetter } from "vue";
import type { Node, Edge } from "@vue-flow/core";
import { useWorkspaceStore } from "@/stores/workspace";

type WorkspaceEntry = { name: string; path: string; type: "file" | "directory" };
export type WorkspaceGraph = { toonflowCanvas: true; cursor?: number; nodes: Node[]; edges: Edge[]; viewport: { x: number; y: number; zoom: number }; toonflowGraph: { id: string; revision: number; nodes: Record<string, number>; edges: Record<string, number>; outputs: Record<string, number>; viewport: number } };
export type GraphChange = { kind: "node" | "edge"; id: string; expectedVersion: number; dependencies?: Record<string, number>; value: Node | Edge | null } | { kind: "output"; nodeId: string; slot: string; expectedVersion: number; value: unknown } | { kind: "viewport"; expectedVersion: number; value: WorkspaceGraph["viewport"] };
const client = axios.create({ baseURL: "/api/workspaces", headers: { "X-Toonflow-Protocol": "2" } });
const fileUrls = new Map<string, { directory: string; path: string; url: Promise<string>; users: number }>();

export function graphValueJson(value: unknown, withoutOutputs = false) {
  // 对象键顺序不属于图内容；后端规范化与 Vue Flow 导出的键顺序可能不同。
  return JSON.stringify(value, (key, item) => {
    if (withoutOutputs && key === "outputs") return undefined;
    return item && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(Object.keys(item).sort().map(name => [name, item[name]]))
      : item;
  });
}

function cachePath(path: string) {
  return path.replaceAll("\\", "/").split("/").filter(part => part && part !== ".").join("/").toLowerCase();
}

function invalidateUrls(directory: string, path: string) {
  // ACT: 仅失效时保守合并路径写法；实际读取仍交服务端校验，区分大小写的文件最多多读一次。
  directory = cachePath(directory);
  path = cachePath(path);
  for (const [key, entry] of fileUrls) {
    const entryPath = cachePath(entry.path);
    if (cachePath(entry.directory) === directory && (entryPath === path || entryPath.startsWith(`${path}/`))) fileUrls.delete(key);
  }
}

export default function useWorkspaceFiles(directory?: MaybeRefOrGetter<string | undefined>) {
  const workspace = directory === undefined ? useWorkspaceStore() : undefined;
  function getDirectory() {
    const path = directory === undefined ? workspace?.project?.directory : toValue(directory);
    if (!path) throw new Error("请先选择工作目录");
    return path;
  }

  async function list(path = "") {
    const { data } = await client.get<{ data: { directory: string; empty: boolean; entries: WorkspaceEntry[] } }>("/files/list", { params: { directory: getDirectory(), path } });
    return data.data;
  }

  async function read(path: string) {
    const { data } = await client.get<ArrayBuffer>("/files/read", { params: { directory: getDirectory(), path }, responseType: "arraybuffer" });
    return data;
  }

  function acquireUrl(path: string, mimeType?: string) {
    const directory = getDirectory();
    const key = JSON.stringify([directory, path, mimeType]);
    let entry = fileUrls.get(key);
    if (!entry) {
      const url = client.get<Blob>("/files/read", { params: { directory, path }, responseType: "blob" })
        .then(({ data }) => URL.createObjectURL(mimeType ? new Blob([data], { type: mimeType }) : data));
      entry = { directory, path, url, users: 0 };
      fileUrls.set(key, entry);
      const current = entry;
      void url.catch(() => { if (fileUrls.get(key) === current) fileUrls.delete(key); });
    }
    const current = entry;
    current.users++;
    let released = false;
    return {
      url: current.url,
      release() {
        if (released) return;
        released = true;
        if (--current.users) return;
        if (fileUrls.get(key) === current) fileUrls.delete(key);
        // 等待中的读取也要在最后一个使用者离开后释放，不撤销其他节点仍使用的 URL。
        void current.url.then(url => URL.revokeObjectURL(url), () => {});
      },
    };
  }

  async function readText(path: string, maxBytes?: number) {
    if (maxBytes !== undefined && (!Number.isSafeInteger(maxBytes) || maxBytes < 1)) throw new Error("读取字节数必须为正整数");
    try {
      const { data } = await client.get<string>("/files/read", {
        params: { directory: getDirectory(), path }, responseType: "text", transformResponse: [],
        headers: maxBytes === undefined ? undefined : { Range: `bytes=0-${maxBytes - 1}` },
      });
      return data;
    } catch (error) {
      if (maxBytes !== undefined && axios.isAxiosError(error) && error.response?.status === 416 && error.response.headers["content-range"] === "bytes */0") return "";
      throw error;
    }
  }

  async function readJson<T = unknown>(path: string): Promise<T> {
    return JSON.parse(await readText(path));
  }

  async function readGraph(path: string) {
    const { data } = await client.get<{ data: WorkspaceGraph }>("/canvas/get", { params: { directory: getDirectory(), path } });
    return data.data;
  }

  async function modifyGraph(path: string, changes: GraphChange[], operationId = crypto.randomUUID()) {
    const { data } = await client.post<{ data: WorkspaceGraph }>("/canvas/modify", { directory: getDirectory(), path, changes, operationId });
    return data.data;
  }

  async function saveGraph(path: string, baseline: WorkspaceGraph, flow: Pick<WorkspaceGraph, "nodes" | "edges" | "viewport">) {
    const changes: GraphChange[] = [];
    function dependencies(kind: "node" | "edge", item?: Node | Edge, previous?: Node | Edge) {
      const ids = kind === "edge"
        ? [((item ?? previous) as Edge)?.source, ((item ?? previous) as Edge)?.target]
        : [(previous as Node | undefined)?.parentNode, (item as Node | undefined)?.parentNode];
      return Object.fromEntries(ids.filter((id): id is string => !!id).map(id => [id, baseline.toonflowGraph.nodes[id] ?? 0]));
    }
    for (const kind of ["node", "edge"] as const) {
      const oldItems = new Map(baseline[kind === "node" ? "nodes" : "edges"].map(item => [item.id, item]));
      const items = flow[kind === "node" ? "nodes" : "edges"];
      for (const item of items) {
        const previous = oldItems.get(item.id);
        const node = kind === "node" ? item as WorkspaceGraph["nodes"][number] : undefined;
        const before = kind === "node" ? previous as WorkspaceGraph["nodes"][number] | undefined : undefined;
        if (graphValueJson(previous, true) !== graphValueJson(item, true)) changes.push({ kind, id: item.id, expectedVersion: baseline.toonflowGraph[kind === "node" ? "nodes" : "edges"][item.id] ?? 0, dependencies: dependencies(kind, item, previous), value: item });
        if (node && before) {
          const slots = new Set([...Object.keys(before.data?.outputs ?? {}), ...Object.keys(node.data?.outputs ?? {})]);
          for (const slot of slots) {
            const value = node.data?.outputs?.[slot] ?? null;
            if (graphValueJson(before.data?.outputs?.[slot] ?? null) !== graphValueJson(value)) changes.push({ kind: "output", nodeId: item.id, slot, expectedVersion: baseline.toonflowGraph.outputs[JSON.stringify([item.id, slot])] ?? 0, value });
          }
        }
        oldItems.delete(item.id);
      }
      for (const [id, previous] of oldItems) changes.push({ kind, id, expectedVersion: baseline.toonflowGraph[kind === "node" ? "nodes" : "edges"][id] ?? 0, dependencies: dependencies(kind, undefined, previous), value: null });
    }
    if (graphValueJson(flow.viewport) !== graphValueJson(baseline.viewport)) changes.push({ kind: "viewport", expectedVersion: baseline.toonflowGraph.viewport, value: flow.viewport });
    return changes.length ? modifyGraph(path, changes) : baseline;
  }

  async function write(path: string, content: string | Blob | ArrayBuffer, exclusive = false, signal?: AbortSignal) {
    const directory = getDirectory();
    await client.put("/files/write", content, { params: { directory, path, exclusive }, signal, headers: { "Content-Type": "application/octet-stream" } });
    invalidateUrls(directory, path);
  }

  function writeJson(path: string, data: unknown, exclusive = false) {
    return write(path, `${JSON.stringify(data, null, 2)}\n`, exclusive);
  }

  async function rename(path: string, target: string) {
    const directory = getDirectory();
    await client.post("/files/rename", { directory, path, target });
    invalidateUrls(directory, path);
    invalidateUrls(directory, target);
  }

  async function renameGraph(path: string, target: string) {
    const directory = getDirectory();
    await client.post("/canvas/rename", { directory, path, target });
    invalidateUrls(directory, path);
    invalidateUrls(directory, target);
  }

  async function removeGraph(path: string) {
    const directory = getDirectory();
    await client.delete("/canvas/remove", { data: { directory, path } });
    invalidateUrls(directory, path);
  }

  async function remove(path: string, recursive = false) {
    const directory = getDirectory();
    await client.delete("/files/remove", { data: { directory, path, recursive } });
    invalidateUrls(directory, path);
  }

  async function mkdir(path: string) {
    await client.post("/files/mkdir", { directory: getDirectory(), path });
  }

  // ACT: 当前目录逐次读取；跨 await 或防抖的操作传入目录字符串，固定本次目标。
  return { list, read, acquireUrl, readText, readJson, readGraph, modifyGraph, saveGraph, write, writeJson, rename, renameGraph, remove, removeGraph, mkdir };
}
