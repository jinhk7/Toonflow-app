import axios from "axios";
import * as vueRuntime from "vue";
import * as vueFlowRuntime from "@vue-flow/core";
import * as elementPlusRuntime from "element-plus";
import { runAgentLoop } from "@earendil-works/pi-agent-core";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { initializeNodeHost, loadNodeComponent } from "../../panels/canvas/loadNodeComponent";

export type MobileNodeType = { type: string; label: string; name: string; url: string; revision: string; builtin: boolean };

export async function fetchEnabledNodeTypes(): Promise<MobileNodeType[]> {
  const { data } = await axios.get<{
    code: number;
    data: { name: string; displayName: string; url: string; revision: string; builtin?: boolean; enabled?: boolean }[];
  }>("/api/nodes/get", { headers: { "Cache-Control": "no-cache" } });
  if (data.code !== 200 || !Array.isArray(data.data)) throw new Error("节点列表格式错误");
  return data.data
    .filter(node => node.enabled !== false && /^[a-z][a-zA-Z0-9]*$/.test(node.name) && node.url === `/api/nodes/files?name=${node.name}` && /^[a-f0-9]{64}$/.test(node.revision))
    .map(node => ({ type: `remote-${node.name}`, label: node.displayName, name: node.name, url: node.url, revision: node.revision, builtin: node.builtin === true }))
    .sort((a, b) => a.label.localeCompare(b.label, "zh-CN"));
}
export async function loadNodeHandles(node: MobileNodeType) {
  initializeNodeHost({ vue: vueRuntime, vueFlow: vueFlowRuntime, elementPlus: elementPlusRuntime, ai: { runAgentLoop, createAssistantMessageEventStream } });
  const component = await loadNodeComponent(node.name, node.url, node.revision, false, node.builtin);
  const handles = (component as { handles?: unknown }).handles;
  if (!Array.isArray(handles)) return [];
  return handles.filter(handle => handle && typeof handle.id === "string" && ["source", "target"].includes(handle.type)
    && (typeof handle.dataType === "string" || Array.isArray(handle.dataType) && handle.dataType.every((type: unknown) => typeof type === "string")))
    .map(handle => ({ id: handle.id as string, type: handle.type as "source" | "target", dataType: handle.dataType as string | string[] }));
}
