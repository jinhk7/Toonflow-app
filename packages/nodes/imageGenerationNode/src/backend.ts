import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import type { NodeExecutionContext, NodeExecutionDefinition } from "@toonflow/nodes-scaffold/execution";
import type { NodeMediaModel } from "@toonflow/nodes-scaffold/nodeAi";
import type { NodeOutputs } from "@toonflow/nodes-scaffold/values";

const setConfigSchema = z.strictObject({ providerId: z.string().min(1).optional(), modelId: z.string().min(1).optional(), size: z.string().min(1).optional(), ratio: z.string().min(1).optional() })
  .refine(args => (args.providerId === undefined) === (args.modelId === undefined), "providerId 与 modelId 必须同时提供");

async function currentJob(context: NodeExecutionContext) {
  const id = context.node.data.generationJobId;
  return typeof id === "string" ? context.getJob(id) : undefined;
}

function mediaJobId(context: NodeExecutionContext, jobId?: string) {
  const pending = context.node.data.pendingMediaJob as { idempotencyKey?: unknown } | undefined;
  return jobId ?? (typeof pending?.idempotencyKey === "string" ? pending.idempotencyKey : undefined);
}
async function getGenerationState(context: NodeExecutionContext) {
  const job = await currentJob(context);
  const id = mediaJobId(context, job?.jobId);
  const mediaJob = id ? await context.getMediaJob(id) : undefined;
  const mediaRunning = !!mediaJob && ["prepared", "submitting", "tracking", "collecting"].includes(mediaJob.status);
  const mediaUnresolved = mediaRunning || mediaJob?.status === "unknown" || mediaJob?.status === "collectionFailed";
  const observerRunning = !!job && ["accepted", "running"].includes(job.status);
  const pendingMedia = !!context.node.data.pendingMediaJob;
  const mediaFinished = mediaJob?.status === "failed" || (mediaJob?.status === "completed" && mediaJob.linkStatus !== "pending" && !pendingMedia);
  return {
    status: mediaJob ? mediaRunning ? "running" : mediaJob.status : job?.status ?? "idle",
    jobId: job?.jobId,
    observerStatus: job?.status,
    observationCancelled: job?.status === "cancelled",
    canCancelObservation: observerRunning,
    controlsBlocked: !mediaFinished && (mediaUnresolved || pendingMedia || observerRunning || job?.status === "needsReview"),
    mediaJob,
    outputs: context.node.data.outputs ?? {},
    error: mediaJob ? mediaJob.errorMessage ?? undefined : job?.errorMessage,
  };
}
async function requireAvailable(context: NodeExecutionContext) {
  const job = await currentJob(context);
  const id = mediaJobId(context, job?.jobId);
  const media = context.node.data.pendingMediaJob && id ? await context.getMediaJob(id) : undefined;
  const definitivelyFailed = media?.status === "failed";
  if (definitivelyFailed) await context.patchData({ pendingMediaJob: null, generationJobId: null });
  if ((!definitivelyFailed && job && ["accepted", "running", "needsReview"].includes(job.status)) || context.node.data.pendingMediaJob) throw new Error("已有未决媒体任务，请先核对原任务，不能重复提交");
}

async function getConfig(context: NodeExecutionContext) {
  const models = await context.getModels("image") as NodeMediaModel[];
  const choice = models.find(item => JSON.stringify([item.providerId, item.modelId]) === context.node.data.model)
    ?? (!context.node.data.model ? models[0] : undefined);
  const sizes = choice?.imageSizes ?? [];
  const ratios = choice?.imageRatios ?? [];
  return {
    nodeVersion: context.node.version,
    config: {
      providerId: choice?.providerId ?? "", modelId: choice?.modelId ?? "",
      size: typeof context.node.data.size === "string" && sizes.includes(context.node.data.size) ? context.node.data.size
        : sizes.toSorted((left, right) => (Number.parseFloat(left) || Infinity) - (Number.parseFloat(right) || Infinity))[0] ?? "",
      ratio: typeof context.node.data.ratio === "string" && ratios.includes(context.node.data.ratio) ? context.node.data.ratio
        : ratios.includes("16:9") ? "16:9" : ratios[0] ?? "",
    },
    models,
  };
}

const definition: NodeExecutionDefinition = {
  protocolVersion: 2,
  name: "imageGenerationNode",
  stateVersion: 2,
  handles: [
    { id: "in", type: "target", dataType: ["IMAGE", "STRING"], label: "图片、文本输入" },
    { id: "image", type: "source", dataType: "IMAGE", label: "图片输出" },
  ],
  defaultData: { label: "图片生成", prompt: "", promptModel: [], model: "", size: "", ratio: "" },
  layoutSize: { width: 320, height: 190 },
  actions: [
    {
      name: "getConfig",
      snapshotInputs: false,
      description: "读取此图片生成节点的当前模型、分辨率、比例及可选图片模型能力，不含密钥；未声明的分辨率或比例不会发送给供应商",
      parameters: z.strictObject({}),
      execute: (_args, context) => getConfig(context),
    },
    {
      name: "setConfig",
      snapshotInputs: false,
      description: "修改此图片生成节点的模型、分辨率或比例；先用 getConfig 查询可选能力，providerId 与 modelId 必须同时提供；不修改提示词、不启动生成",
      editor: {
        label: "图片生成参数", readAction: "getConfig",
        values: { providerId: { result: "config.providerId" }, modelId: { result: "config.modelId" }, size: { result: "config.size" }, ratio: { result: "config.ratio" } },
        fields: {
          providerId: { hidden: true }, modelId: { label: "模型", model: { sourcePath: "models", providerField: "providerId" } },
          size: { label: "分辨率", choices: { sourcePath: "models", modelProperty: "imageSizes" } },
          ratio: { label: "比例", choices: { sourcePath: "models", modelProperty: "imageRatios" } },
        },
      },
      parameters: setConfigSchema,
      async execute(args: z.output<typeof setConfigSchema>, context) {
        await requireAvailable(context);
        const state = await getConfig(context);
        const choice = state.models.find(item => item.providerId === (args.providerId ?? state.config.providerId) && item.modelId === (args.modelId ?? state.config.modelId));
        if (!choice) throw new Error("请选择 getConfig 返回的有效图片模型");
        const sizes = choice.imageSizes ?? [];
        const ratios = choice.imageRatios ?? [];
        if (args.size !== undefined && !sizes.includes(args.size)) throw new Error(`当前模型不支持分辨率 ${args.size}，可选：${sizes.join("、")}`);
        if (args.ratio !== undefined && !ratios.includes(args.ratio)) throw new Error(`当前模型不支持比例 ${args.ratio}，可选：${ratios.join("、")}`);
        await context.patchData({ model: JSON.stringify([choice.providerId, choice.modelId]), ...(args.size === undefined ? {} : { size: args.size }), ...(args.ratio === undefined ? {} : { ratio: args.ratio }) });
        return getConfig(context);
      },
    },
    {
      name: "setPrompt",
      snapshotInputs: false,
      description: "修改此节点的图片生成提示词，支持 {{ref 1}} 等参考标记；只修改提示词，不启动生成",
      editor: { label: "生成提示词", values: { prompt: { node: "data.prompt" } }, fields: { prompt: { label: "提示词", multiline: true } } },
      parameters: z.strictObject({ prompt: z.string() }),
      async execute({ prompt }, context) {
        await context.patchData({ prompt, promptModel: prompt.split("\n").map((text: string) => [{ type: "Write", text }]) });
        return { prompt, nodeVersion: context.node.version };
      },
    },
    {
      name: "generateImage",
      description: "启动此节点的后台图片生成，使用当前提示词、模型、分辨率、比例和参考图片；立即返回已开始，用 getGenerationStatus 查询完成结果，cancelGeneration 仅取消本地等待",
      parameters: z.strictObject({}),
      async execute(_args, context) {
        await requireAvailable(context);
        const state = await getConfig(context);
        if (!state.config.modelId) throw new Error("请先选择图片模型");
        const inputs = await context.getInputs("in");
        if (inputs.some(item => item.value === undefined)) throw new Error("引用节点暂无内容，请先补充引用内容");
        const prompt = [typeof context.node.data.prompt === "string" ? context.node.data.prompt.trim() : "", ...inputs.flatMap((item, index) => item.dataType === "STRING" && typeof item.value === "string" && item.value.trim() ? [`参考 ${index + 1}：\n${item.value.trim()}`] : [])].filter(Boolean).join("\n\n");
        if (!prompt) throw new Error("请输入生成提示词");
        const images = inputs.flatMap(item => item.dataType === "IMAGE" && item.value ? [{ path: item.value.url, mimeType: item.value.mimeType }] : []);
        const job = await context.runJob({ kind: "media", input: { mediaType: "image", request: { ...state.config, prompt, size: state.config.size || undefined, ratio: state.config.ratio || undefined, outputDirectory: `assets/${context.node.id}`, images }, binding: { outputSlot: "image" } } });
        return { status: "generating", jobId: job.jobId };
      },
    },
    {
      name: "getGenerationStatus",
      snapshotInputs: false,
      description: "查询真实媒体任务状态、观察状态、当前输出和最近一次错误；取消观察不会改变供应商状态，completed 表示本次媒体生成完成",
      parameters: z.strictObject({}),
      async execute(_args, context) {
        return getGenerationState(context);
      },
    },
    {
      name: "cancelGeneration",
      snapshotInputs: false,
      description: "取消当前任务的本地等待和观察；cancellationRequested 仅表示已请求取消观察，不会停止供应商提交、追踪或收集。原媒体任务和结果保留，用 getGenerationStatus 查询真实状态",
      parameters: z.strictObject({}),
      async execute(_args, context) {
        const job = await currentJob(context);
        const cancellationRequested = !!job && ["accepted", "running"].includes(job.status);
        if (cancellationRequested) await context.cancelJob(job!.jobId);
        return { ...await getGenerationState(context), cancellationRequested, cancellationScope: "observer" };
      },
    },
    {
      name: "retryCollection",
      snapshotInputs: false,
      description: "仅重试归档原媒体任务的已有结果，不重新生成、不重复计费",
      parameters: z.strictObject({}),
      async execute(_args, context) {
        const job = await currentJob(context);
        const id = mediaJobId(context, job?.jobId);
        if (!id) throw new Error("未找到原任务");
        const mediaJob = await context.getMediaJob(id);
        if (mediaJob?.status !== "collectionFailed") throw new Error("原任务没有待重试的归档失败");
        return context.retryMediaCollection(id);
      },
    },
    {
      name: "abandonUnknownGeneration",
      snapshotInputs: false,
      description: "用户核对并确认后放弃未知任务的节点绑定；不删除历史结果、不启动新的生成。供应商可能仍在生成或已计费",
      parameters: z.strictObject({ confirmed: z.literal(true) }),
      async execute(_args, context) {
        const job = await currentJob(context);
        const id = mediaJobId(context, job?.jobId);
        const mediaJob = id ? await context.getMediaJob(id) : undefined;
        if (mediaJob && mediaJob.status !== "unknown") throw new Error("原任务状态已变化，请重新查询，不能放弃");
        if (!context.node.data.pendingMediaJob) throw new Error("节点没有待核对绑定");
        await context.patchData({ pendingMediaJob: null, generationJobId: null });
        return { abandoned: true };
      },
    },
    {
      name: "setImage",
      snapshotInputs: false,
      description: "选择工作区内已有的图片文件作为此节点的输出，保留生成历史",
      editor: { label: "图片素材", values: { path: { node: "data.outputs.image.value.url" }, mimeType: { node: "data.outputs.image.value.mimeType" }, expectedOutput: { node: "data.outputs.image" } }, fields: { path: { label: "工作区图片路径" }, mimeType: { label: "媒体类型" }, expectedOutput: { hidden: true } } },
      parameters: z.strictObject({ path: z.string().min(1).max(4096), mimeType: z.string().regex(/^image\/[a-zA-Z0-9.+-]+$/), expectedOutput: z.json().optional().meta({ default: null }) }),
      async execute({ path, mimeType, expectedOutput }, context) {
        if (expectedOutput !== undefined && !isDeepStrictEqual(expectedOutput, (context.node.data.outputs as NodeOutputs | undefined)?.image ?? null)) throw Object.assign(new Error("图片输出已被其他操作修改，请保留草稿并核对当前输出"), { status: 409 });
        await requireAvailable(context);
        const content = await context.read(path);
        if (!content.byteLength || content.byteLength > 100 * 1024 * 1024) throw new Error("图片不能为空且不能超过 100 MB");
        const output = { dataType: "IMAGE" as const, value: { url: path, mimeType } };
        await context.setOutput("image", output);
        return { ...output, nodeVersion: context.node.version };
      },
    },
    {
      name: "uploadImage",
      snapshotInputs: false,
      description: "校验临时上传的图片并归档为此节点输出，保留历史文件",
      parameters: z.strictObject({ stagedPath: z.string().max(4096).regex(/^assets\/uploads\/[a-zA-Z0-9.-]+$/), name: z.string().min(1).max(255), mimeType: z.string().regex(/^image\/[a-zA-Z0-9.+-]+$/) }),
      async execute({ stagedPath, name, mimeType }, context) {
        context.signal.throwIfAborted();
        await requireAvailable(context);
        context.signal.throwIfAborted();
        if (!context.node.id || /[\\/]/.test(context.node.id) || context.node.id === "." || context.node.id === "..") throw new Error("节点 ID 不能作为文件夹名称");
        const content = await context.read(stagedPath);
        context.signal.throwIfAborted();
        if (!content.byteLength || content.byteLength > 100 * 1024 * 1024) throw new Error("图片不能为空且不能超过 100 MB");
        const extension = name.match(/\.[a-zA-Z0-9]{1,12}$/)?.[0].toLowerCase() ?? "";
        const fileId = createHash("sha256").update(context.commandId).digest("hex");
        const path = `assets/${context.node.id}/${fileId}${extension}`;
        await context.write(path, content);
        context.signal.throwIfAborted();
        const output = { dataType: "IMAGE" as const, value: { url: path, mimeType } };
        await context.setOutput("image", output);
        return { ...output, nodeVersion: context.node.version };
      },
    },
  ],
};

export default definition;
