import { mkdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";
import type { generateDirectorDraft } from "@toonflow/node-director3d/backend";
import { renderJobSchema } from "@toonflow/node-director3d/render";
import { registerNodeJobHandler, getNodeJob, type NodeJobContext } from "@/utils/jobs";
import { createConfiguredAiModel, getConfiguredModel, streamAi } from "@/utils/ai";
import { createRenderer } from "@/utils/render";
import { createWorkspaceFfmpeg } from "@/utils/ffmpeg";
import { getNodeExecutionArtifact, getNodeExecutionModule, loadNodeExecution } from "@/utils/plugins/nodeExecution";
import { getNodeConfig, readNode } from "@/utils/plugins/nodes";
import { readGraph, modifyGraph, type GraphChange } from "@/utils/workspace/graph";
import { resolveWorkspacePath, writeWorkspaceFile } from "@/utils/workspace/files";
import { readVersionedContent, writeVersionedContent } from "@/utils/canvas/content";
import { getGraphWrite, requestDigest } from "@/utils/canvas/store";

const revisionSchema = z.string().regex(/^[a-f0-9]{64}$/);
const hostSchema = z.strictObject({
  commandId: z.string().min(1), nodeId: z.string().min(1), canvasPath: z.string().min(1),
  nodeType: z.string().min(1), pluginRevision: revisionSchema, canvasId: z.string().min(1),
  expectedNodeVersion: z.number().int().positive(), configRevision: revisionSchema,
  position: z.strictObject({ x: z.number().finite(), y: z.number().finite() }), sourceWidth: z.number().positive(),
  parentNode: z.string().optional(), parentVersion: z.number().int().nonnegative().optional(),
  ai: z.strictObject({ configuredRevision: revisionSchema,
    referenceContents: z.array(z.strictObject({ dataType: z.enum(["STRING", "IMAGE", "VIDEO"]), value: z.string() })).max(32),
  }).optional(),
  artifactRevision: revisionSchema.optional(), outputNodeType: z.string().optional(), outputNodeRevision: revisionSchema.optional(),
});
const envelopeSchema = z.strictObject({ payload: z.record(z.string(), z.unknown()), host: hostSchema });
type Host = z.infer<typeof hostSchema>;
type DraftResult = Awaited<ReturnType<typeof generateDirectorDraft>>;
type Artifact = { path: string; mimeType: string };

function needsReview(message: string): never {
  throw Object.assign(new Error(message), { code: "JOB_NEEDS_REVIEW" });
}

function publishId(host: Host, kind: string) {
  return requestDigest([host.commandId, kind, "publish"]).slice(0, 32);
}

async function readTarget(host: Host, context: NodeJobContext, kind: "directorDraft" | "render") {
  const { path } = await resolveWorkspacePath(context.directory, host.canvasPath);
  const graph = await readGraph(path, context.directory);
  if (graph.toonflowGraph!.id !== host.canvasId) needsReview("目标画布已变化，产物保留供核对");
  const node = graph.nodes.find(item => item.id === host.nodeId);
  const jobField = kind === "render" ? "renderJobId" : "generationJobId";
  if (!node || (node.type?.replace(/^remote-/, "") !== host.nodeType)
    || node.data?.executionRevision !== host.pluginRevision || node.data?.[jobField] !== context.jobId
    || graph.toonflowGraph!.nodes[node.id] !== host.expectedNodeVersion) {
    needsReview("目标节点已变化，产物保留供核对");
  }
  if (host.parentNode && (node.parentNode !== host.parentNode || graph.toonflowGraph!.nodes[host.parentNode] !== host.parentVersion)) {
    needsReview("目标分组已变化，产物保留供核对");
  }
  return { graph, node, path };
}

async function checkConfig(host: Host) {
  await loadNodeExecution(host.nodeType, host.pluginRevision);
  if (requestDigest(getNodeConfig(await readNode(host.nodeType))) !== host.configRevision) {
    needsReview("节点配置已变化，请核对固定输入后重试");
  }
}

async function saveCheckpoint(context: NodeJobContext, result: Record<string, unknown>) {
  await writeWorkspaceFile(join(context.scratchDirectory, "result.json"), JSON.stringify(result, null, 2));
  context.saveResult(result);
  return result;
}

async function published(host: Host, context: NodeJobContext, kind: string) {
  const path = (await resolveWorkspacePath(context.directory, host.canvasPath)).path;
  await readGraph(path, context.directory);
  const receipt = getGraphWrite(context.directory, `graph:${publishId(host, kind)}`);
  return receipt && receipt.status !== "accepted" ? receipt.result : undefined;
}

async function draftHandler(raw: Record<string, unknown>, context: NodeJobContext) {
  const { payload, host } = envelopeSchema.parse(raw);
  const prior = getNodeJob(context.jobId)?.result as Record<string, unknown> | undefined;
  const receipt = await published(host, context, "directorDraft");
  if (receipt) return { ...prior, kind: "directorDraft", phase: "published", graph: receipt };
  const module = await getNodeExecutionModule(host.nodeType, host.pluginRevision);
  const schema = module.directorDraftInputSchema as z.ZodType<Parameters<typeof generateDirectorDraft>[0]> | undefined;
  const generate = module.generateDirectorDraft as typeof generateDirectorDraft | undefined;
  if (!schema || typeof schema.parse !== "function" || typeof generate !== "function" || !host.ai) {
    needsReview("固定版本缺少导演草稿协议");
  }
  const input = schema.parse(payload);
  let result: DraftResult;
  if (prior?.kind === "directorDraft" && (prior.phase === "generated" || prior.phase === "contentPublished")) {
    const saved = z.object({ document: z.unknown(), modelPath: z.string(), expectedRevision: z.string(), selectedPlanId: z.string(), basePlanId: z.string() }).parse(prior);
    schema.parse({ ...payload, document: saved.document });
    result = saved as DraftResult;
  } else {
    await checkConfig(host);
    const parsed = z.object({ providerId: z.string(), modelId: z.string() }).parse(input);
    const configured = getConfiguredModel(parsed.providerId, parsed.modelId);
    if (requestDigest(configured) !== host.ai.configuredRevision) needsReview("导演模型配置已变化，请核对后重试");
    const model = createConfiguredAiModel(configured);
    result = await generate(input, model, (_model, llmContext, options) => streamAi(configured, llmContext,
      options?.signal ? AbortSignal.any([context.signal, options.signal]) : context.signal, host.ai!.referenceContents), context.signal);
  }
  const checkpoint = await saveCheckpoint(context, { kind: "directorDraft", phase: "generated", ...result, scratchDirectory: context.scratchDirectory });
  context.signal.throwIfAborted();
  try {
    const target = await readTarget(host, context, "directorDraft");
    if (target.node.data?.modelPath !== result.modelPath || String(target.node.data?.selectedPlanId ?? "") !== result.basePlanId) {
      needsReview("导演模型路径或当前方案已变化，草稿保留供核对");
    }
    context.beginCommit();
    const saved = await writeVersionedContent({ directory: context.directory, path: result.modelPath,
      content: JSON.stringify(result.document, null, 2), expectedRevision: result.expectedRevision, commandId: `${host.commandId}:model` });
    context.saveResult({ ...checkpoint, phase: "contentPublished", modelRevision: saved.revision });
    if ((await readVersionedContent(context.directory, result.modelPath)).revision !== saved.revision) {
      needsReview("导演正文在提交后已被修改，保留草稿，未覆盖后续编辑或发布旧方案");
    }
    await modifyGraph(target.path, publishId(host, "directorDraft"), [{ kind: "node", id: host.nodeId,
      ...(host.parentNode ? { dependencies: { [host.parentNode]: host.parentVersion! } } : {}),
      expectedVersion: host.expectedNodeVersion, value: { ...target.node, data: { ...target.node.data,
        modelRevision: saved.revision, modelSnapshot: null, selectedPlanId: result.selectedPlanId } } }], context.directory);
    return { ...checkpoint, phase: "published", modelRevision: saved.revision };
  } catch (error) {
    if ((error as { status?: number }).status === 409 || (error as NodeJS.ErrnoException).code === "ENOENT") {
      needsReview("导演模型或节点已变化，生成草稿保留在任务中，请核对后保存");
    }
    throw error;
  }
}

async function renderHandler(raw: Record<string, unknown>, context: NodeJobContext) {
  const { payload, host } = envelopeSchema.parse(raw);
  const input = renderJobSchema.parse(payload);
  const prior = getNodeJob(context.jobId)?.result as Record<string, unknown> | undefined;
  const receipt = await published(host, context, "render");
  if (receipt) return { ...prior, kind: "render", phase: "published", graph: receipt };
  await checkConfig(host);
  const artifact = await getNodeExecutionArtifact(host.nodeType, host.pluginRevision, "director3dNode.render.js");
  if (artifact.revision !== host.artifactRevision || !host.outputNodeType || !host.outputNodeRevision) {
    needsReview("固定渲染入口或输出节点版本不可用");
  }
  const output = await loadNodeExecution(host.outputNodeType, host.outputNodeRevision);
  if (host.outputNodeType !== (input.format === "image" ? "imageNode" : "videoNode")) needsReview("输出节点类型不符合固定渲染格式");
  let result: { artifacts: Artifact[]; metadata?: Record<string, unknown> };
  let scratchDirectory = context.scratchDirectory;
  if (prior?.kind === "render" && (prior.phase === "generated" || prior.phase === "artifactsPublished") && typeof prior.scratchDirectory === "string") {
    scratchDirectory = resolve(prior.scratchDirectory);
    if (dirname(scratchDirectory) !== dirname(context.scratchDirectory)) needsReview("保存的渲染产物目录不属于此任务");
    result = z.object({ artifacts: z.array(z.object({ path: z.string(), mimeType: z.string() })).min(1).max(8), metadata: z.record(z.string(), z.unknown()).optional() }).parse(prior);
  } else {
    result = await createRenderer({ entryPath: artifact.path, createFfmpeg: createWorkspaceFfmpeg }).execute(input, {
      directory: context.scratchDirectory, signal: context.signal, reportProgress: context.reportProgress,
    });
  }
  const checkpoint = await saveCheckpoint(context, { kind: "render", phase: "generated", ...result, scratchDirectory });
  context.signal.throwIfAborted();
  try {
    const target = await readTarget(host, context, "render");
    const mimeType = input.format === "image" ? "image/png" : "video/mp4";
    const slot = input.format === "image" ? "image" : "video";
    const files = await Promise.all(result.artifacts.map(async (item, index) => {
      if (item.mimeType !== mimeType) needsReview("渲染产物类型不符合固定输入");
      const source = await resolveWorkspacePath(scratchDirectory, item.path);
      const bytes = await readFile(source.path);
      if (!bytes.length || bytes.length > 100 * 1024 * 1024) throw new Error("渲染产物为空或超过 100 MB");
      const nodeId = requestDigest([context.jobId, "renderOutput", index]).slice(0, 32);
      const path = `assets/${nodeId}/${input.format === "image" ? "render.png" : "render.mp4"}`;
      return { nodeId, path, bytes };
    }));
    context.beginCommit();
    for (const file of files) {
      const destination = await resolveWorkspacePath(context.directory, file.path, true);
      await mkdir(dirname(destination.path), { recursive: true });
      try { await writeWorkspaceFile(destination.path, file.bytes, true); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        if (!Buffer.from(await readFile(destination.path)).equals(file.bytes)) needsReview("渲染目标文件已变化，未覆盖已有产物");
      }
    }
    context.saveResult({ ...checkpoint, phase: "artifactsPublished", files: files.map(({ nodeId, path }) => ({ nodeId, path })) });
    const changes: GraphChange[] = files.map((file, index) => ({ kind: "node", id: file.nodeId, expectedVersion: 0,
      dependencies: { [host.nodeId]: host.expectedNodeVersion, ...(host.parentNode ? { [host.parentNode]: host.parentVersion! } : {}) },
      value: { id: file.nodeId, type: `remote-${host.outputNodeType}`, ...(host.parentNode ? { parentNode: host.parentNode } : {}),
        position: { x: host.position.x + host.sourceWidth + 80, y: host.position.y + index * (output.definition.layoutSize.height + 40) },
        data: { ...structuredClone(output.definition.defaultData), label: input.format === "image" ? "导演关键帧" : "导演视频",
          executionRevision: host.outputNodeRevision, stateVersion: output.definition.stateVersion,
          outputs: { [slot]: { dataType: input.format === "image" ? "IMAGE" : "VIDEO", value: { url: file.path, mimeType } } } },
      },
    }));
    await modifyGraph(target.path, publishId(host, "render"), changes, context.directory);
    return { ...checkpoint, phase: "published", files: files.map(({ nodeId, path }) => ({ nodeId, path })) };
  } catch (error) {
    if ((error as { status?: number }).status === 409 || (error as NodeJS.ErrnoException).code === "ENOENT") {
      needsReview("目标画布或节点已变化，渲染产物保留在任务中，请核对后导入");
    }
    throw error;
  }
}

export function registerDirectorNodeJobHandlers() {
  const sharedRevision = [checkConfig.toString(), readTarget.toString(), published.toString(), saveCheckpoint.toString(), z.toJSONSchema(hostSchema)];
  // 镜头 ID 的随机默认值属于入参规范化，不能让相同执行器每次启动产生不同版本。
  const renderSchema = z.toJSONSchema(renderJobSchema, { override(context) { delete context.jsonSchema.default; } });
  // 仅已有生成成果可手动继续发布；没有 checkpoint 的审核型任务仍禁止重调模型。
  const canResumeDraft = (result: unknown) => z.object({ kind: z.literal("directorDraft"), phase: z.enum(["generated", "contentPublished"]), document: z.record(z.string(), z.unknown()) }).safeParse(result).success;
  registerNodeJobHandler("directorDraft", draftHandler, "review", requestDigest([...sharedRevision, draftHandler.toString(), streamAi.toString(), createConfiguredAiModel.toString(), canResumeDraft.toString()]), canResumeDraft);
  registerNodeJobHandler("render", renderHandler, "safe", requestDigest([...sharedRevision, renderHandler.toString(), createRenderer.toString(), renderSchema]));
}
