import { listMediaModels } from "@/utils/media/generation";
import { submitAndWaitMediaJob } from "@/utils/media/mediaJobs";
import { createWorkspaceFfmpeg } from "@/utils/ffmpeg";
import { dirname, join, relative, resolve } from "node:path";
import {
  defineTool, createReadToolDefinition, createWriteToolDefinition, createEditToolDefinition, createLsToolDefinition,
  detectSupportedImageMimeTypeFromFile, type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { CanvasContext, QuestionContext, ToolContext } from "@toonflow/tools-scaffold/runtime";
import conf from "@/utils/conf";
import { isWithin, resolveWorkspacePath, writeWorkspaceFile, lockWorkspaceFiles, assertNoManagedGraph } from "@/utils/workspace/files";
import { createPluginTools, listTools } from "@/utils/plugins/tools";
import { createSkillContext } from "@/agent/skills";
import { registerServerTool } from "@/agent/runtime/toolExecution";
import { readVersionedContent, writeVersionedContent } from "@/utils/canvas/content";
import { isManagedResource } from "@/utils/canvas/store";

const apply = Reflect.apply;
const freeze = Object.freeze;
const clone = structuredClone;
const builtinWorkspaceExecutions = new WeakSet<ToolDefinition["execute"]>();

export function isBuiltinWorkspaceTool(tool: ToolDefinition) {
  return builtinWorkspaceExecutions.has(tool.execute);
}

function createCanvasView(canvas?: CanvasContext): CanvasContext | undefined {
  if (!canvas) return;
  const call = canvas.call;
  const getNodeLabel = canvas.getNodeLabel;
  const tools = clone(canvas.tools);
  for (let index = 0; index < tools.length; index++) freeze(tools[index]);
  freeze(tools);
  return freeze({
    get id() { return canvas.id; },
    tools,
    getNodeLabel: getNodeLabel ? (nodeId: string) => apply(getNodeLabel, canvas, [nodeId]) : undefined,
    call: (request: Parameters<CanvasContext["call"]>[0], signal?: AbortSignal) => apply(call, canvas, [request, signal]),
  });
}

export function createAgentToolContext(cwd: string, config: Record<string, unknown> = {}, canvas?: CanvasContext, question?: QuestionContext): ToolContext {
  const skillsDirectory = join(dirname(conf.path), "skills");
  const contentRevisions = new Map<string, string>();
  const resolveTarget = async (path: string, readOnly = false) => {
    const absolute = resolve(cwd, path);
    const root = readOnly && isWithin(skillsDirectory, absolute) ? skillsDirectory : cwd;
    return (await resolveWorkspacePath(root, relative(root, absolute), true)).path;
  };
  const resolvePath = async (path: string, readOnly = false) => {
    const target = await resolveTarget(path, readOnly);
    const pathInWorkspace = relative(cwd, target).replaceAll("\\", "/");
    if (isWithin(cwd, target) && isManagedResource(cwd, pathInWorkspace)) {
      contentRevisions.set(target, (await readVersionedContent(cwd, pathInWorkspace)).revision);
    }
    return target;
  };
  const writeFile = async (path: string, content: string) => {
    const target = await resolveTarget(path);
    const pathInWorkspace = relative(cwd, target).replaceAll("\\", "/");
    if (isManagedResource(cwd, pathInWorkspace)) {
      const expectedRevision = contentRevisions.get(target);
      if (!expectedRevision) throw Object.assign(new Error("请先读取节点正文或插件状态，再提交修改"), { status: 428 });
      const result = await writeVersionedContent({ directory: cwd, path: pathInWorkspace, content, expectedRevision, commandId: crypto.randomUUID() });
      contentRevisions.set(target, result.revision);
      return;
    }
    const release = lockWorkspaceFiles([target]);
    try { await assertNoManagedGraph(target); await writeWorkspaceFile(target, content); }
    finally { release(); }
  };
  const submitMedia = (type: "image" | "video" | "audio", request: Parameters<typeof submitAndWaitMediaJob>[2] & { idempotencyKey?: string }, signal?: AbortSignal) => {
    const { idempotencyKey, ...payload } = request;
    return submitAndWaitMediaJob(cwd, type, payload, { signal, idempotencyKey });
  };
  return {
    cwd, config, resolvePath, writeFile, canvas: createCanvasView(canvas), question, skills: createSkillContext(cwd),
    ffmpeg: signal => createWorkspaceFfmpeg(cwd, signal),
    media: {
      listModels: listMediaModels,
      generateImage: (request, signal) => submitMedia("image", request, signal),
      generateVideo: (request, signal) => submitMedia("video", request, signal),
      generateAudio: (request, signal) => submitMedia("audio", request, signal),
    },
    sdk: { defineTool, createReadToolDefinition, createWriteToolDefinition, createEditToolDefinition, createLsToolDefinition, detectSupportedImageMimeTypeFromFile },
  };
}

export async function createAgentTools(cwd: string, canvas?: CanvasContext, question?: QuestionContext): Promise<ToolDefinition[]> {
  const tools: ToolDefinition[] = [];
  const names = new Set<string>();
  const context = createAgentToolContext(cwd, {}, canvas, question);
  for (const item of await listTools()) {
    if (!item.enabled) continue;
    if (item.loadError) throw new Error(`${item.displayName}：${item.loadError}`);
    const { definitions, metadata } = await createPluginTools(item.name, { ...context, canvas: createCanvasView(context.canvas), config: item.config });
    for (const tool of definitions) {
      if (!tool.name || typeof tool.execute !== "function") throw new Error(`${item.displayName} 返回了无效的工具`);
      if (names.has(tool.name)) throw new Error(`工具名称重复：${tool.name}`);
      names.add(tool.name);
      if (item.builtin && item.name === "workspace") builtinWorkspaceExecutions.add(tool.execute);
      tools.push(registerServerTool({
        ...tool,
        promptGuidelines: [
          ...(metadata.prompt ? [metadata.prompt] : []),
          ...(tool.promptGuidelines ?? []),
        ],
      }, undefined, item.builtin && ["read", "ls", "skill", "question"].includes(tool.name)));
    }
  }
  return tools;
}
