import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import type { NodeExecutionContext, NodeExecutionDefinition } from "@toonflow/nodes-scaffold/execution";
import type { NodeMediaModel } from "@toonflow/nodes-scaffold/nodeAi";
import type { NodeInputValue, NodeOutputs } from "@toonflow/nodes-scaffold/values";

const ratioOptions = ["16:9", "9:16", "1:1", "4:3", "3:4"] as const;

function getMatchingModes(choice: NodeMediaModel | undefined, inputs: NodeInputValue[]) {
  const counts = { image: inputs.filter(item => item.dataType === "IMAGE").length, video: inputs.filter(item => item.dataType === "VIDEO").length, audio: inputs.filter(item => item.dataType === "AUDIO").length };
  return (choice?.mode ?? []).filter(mode => {
    const { image, video, audio } = counts;
    if (Array.isArray(mode)) return image + video + audio > 0 && Object.entries(counts).every(([type, count]) => count <= Number(mode.find(item => item.startsWith(`${type}Reference:`))?.split(":")[1] ?? 0));
    if (mode === "text") return image + video + audio === 0;
    if (video || audio) return false;
    if (mode === "singleImage") return image === 1;
    if (mode === "startEndRequired") return image === 2;
    return ["endFrameOptional", "startFrameOptional"].includes(mode) && image >= 1 && image <= 2;
  });
}

function getDurations(choice?: NodeMediaModel) {
  return [...new Set((choice?.durationResolutionMap ?? []).flatMap(item => item.duration))].sort((left, right) => left - right);
}

function getResolutions(choice: NodeMediaModel | undefined, duration?: number) {
  // ACT: 现有分辨率使用 p 单位；出现其他单位时再统一换算。
  return [...new Set((choice?.durationResolutionMap ?? []).filter(item => item.duration.includes(duration!)).flatMap(item => item.resolution))]
    .sort((left, right) => (Number.parseFloat(left) || Infinity) - (Number.parseFloat(right) || Infinity));
}

const setConfigSchema = z.strictObject({ providerId: z.string().min(1).optional(), modelId: z.string().min(1).optional(), duration: z.number().positive().optional(), resolution: z.string().min(1).optional(), ratio: z.enum(ratioOptions).optional(), mode: z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]).optional(), generateAudio: z.boolean().optional() })
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
  const models = await context.getModels("video") as NodeMediaModel[];
  const choice = models.find(item => JSON.stringify([item.providerId, item.modelId]) === context.node.data.model) ?? (!context.node.data.model ? models[0] : undefined);
  const inputs = await context.getInputs("in");
  const matches = getMatchingModes(choice, inputs);
  const durations = getDurations(choice);
  const duration = typeof context.node.data.duration === "number" && durations.includes(context.node.data.duration) ? context.node.data.duration : durations[0];
  const resolutions = getResolutions(choice, duration);
  const mode = matches.find(item => JSON.stringify(item) === context.node.data.mode) ?? matches.find(Array.isArray) ?? matches.find(item => item === "singleImage") ?? matches.find(item => item === "endFrameOptional") ?? matches[0];
  return {
    nodeVersion: context.node.version,
    config: {
      providerId: choice?.providerId ?? "", modelId: choice?.modelId ?? "", duration,
      resolution: typeof context.node.data.resolution === "string" && resolutions.includes(context.node.data.resolution) ? context.node.data.resolution : resolutions[0] ?? "",
      ratio: typeof context.node.data.ratio === "string" && ratioOptions.includes(context.node.data.ratio as typeof ratioOptions[number]) ? context.node.data.ratio : "9:16",
      mode, generateAudio: choice?.audio === "optional" ? context.node.data.generateAudio !== false : choice?.audio === true,
    },
    models: models.map(model => ({ ...model, matchingModes: getMatchingModes(model, inputs), audioChoices: model.audio === "optional" ? [true, false] : [model.audio === true] })), ratios: [...ratioOptions], matchingModes: matches,
  };
}

const definition: NodeExecutionDefinition = {
  protocolVersion: 2,
  name: "videoGenerationNode",
  stateVersion: 2,
  handles: [
    { id: "in", type: "target", dataType: ["IMAGE", "VIDEO", "AUDIO", "STRING"], label: "图片、视频、音频、文本输入" },
    { id: "video", type: "source", dataType: "VIDEO", label: "视频输出" },
  ],
  defaultData: { label: "视频生成", prompt: "", promptModel: [], model: "", resolution: "", mode: "", generateAudio: true, ratio: "9:16" },
  layoutSize: { width: 320, height: 190 },
  actions: [
    {
      name: "getConfig",
      description: "读取此视频生成节点的当前配置、可选视频模型能力、通用比例及适合当前引用的模式，不含密钥；时长与分辨率须符合 durationResolutionMap",
      parameters: z.strictObject({}),
      execute: (_args, context) => getConfig(context),
    },
    {
      name: "setConfig",
      description: "修改此视频生成节点的模型、时长、分辨率、比例、模式或声音；先用 getConfig 查询能力，providerId 与 modelId 必须同时提供；mode 使用返回的原始字符串或数组，须匹配当前引用；不修改提示词、不启动生成",
      editor: {
        label: "视频生成参数", readAction: "getConfig",
        values: { providerId: { result: "config.providerId" }, modelId: { result: "config.modelId" }, duration: { result: "config.duration" }, resolution: { result: "config.resolution" }, ratio: { result: "config.ratio" }, mode: { result: "config.mode" }, generateAudio: { result: "config.generateAudio" } },
        fields: {
          providerId: { hidden: true }, modelId: { label: "模型", model: { sourcePath: "models", providerField: "providerId" } },
          duration: { label: "时长（秒）", choices: { sourcePath: "models", modelProperty: "durationResolutionMap", valueProperty: "duration" } },
          resolution: { label: "分辨率", choices: { sourcePath: "models", modelProperty: "durationResolutionMap", valueProperty: "resolution", dependentField: "duration", dependentProperty: "duration" } },
          ratio: { label: "比例", choices: { sourcePath: "ratios" } },
          mode: { label: "生成模式", choices: { sourcePath: "models", modelProperty: "matchingModes" } },
          generateAudio: { label: "生成声音", choices: { sourcePath: "models", modelProperty: "audioChoices" } },
        },
      },
      parameters: setConfigSchema,
      async execute(args: z.output<typeof setConfigSchema>, context) {
        await requireAvailable(context);
        const state = await getConfig(context);
        const choice = state.models.find(item => item.providerId === (args.providerId ?? state.config.providerId) && item.modelId === (args.modelId ?? state.config.modelId));
        if (!choice) throw new Error("请选择 getConfig 返回的有效视频模型");
        const durations = getDurations(choice);
        if (args.duration !== undefined && !durations.includes(args.duration)) throw new Error(`当前模型不支持时长 ${args.duration}，可选：${durations.join("、")}`);
        const duration = args.duration ?? (durations.includes(state.config.duration!) ? state.config.duration : durations[0]);
        const resolutions = getResolutions(choice, duration);
        if (args.resolution !== undefined && !resolutions.includes(args.resolution)) throw new Error(`当前时长不支持分辨率 ${args.resolution}，可选：${resolutions.join("、")}`);
        const inputs = await context.getInputs("in");
        const matchingModes = getMatchingModes(choice, inputs);
        if (args.mode !== undefined && !matchingModes.some(item => JSON.stringify(item) === JSON.stringify(args.mode))) throw new Error("所选模式不受当前模型支持或不适用于当前引用，请根据模型能力及已连接素材选择");
        if (args.generateAudio !== undefined && choice.audio !== "optional" && args.generateAudio !== (choice.audio === true)) throw new Error("当前模型不支持切换声音，请查看 getConfig 返回的 audio 能力");
        const mode = args.mode ?? matchingModes.find(item => JSON.stringify(item) === context.node.data.mode) ?? matchingModes.find(Array.isArray) ?? matchingModes[0];
        await context.patchData({ model: JSON.stringify([choice.providerId, choice.modelId]), duration, resolution: args.resolution ?? (resolutions.includes(state.config.resolution) ? state.config.resolution : resolutions[0] ?? ""), ratio: args.ratio ?? state.config.ratio, mode: mode === undefined ? "" : JSON.stringify(mode), generateAudio: choice.audio === "optional" ? args.generateAudio ?? state.config.generateAudio : choice.audio === true });
        return getConfig(context);
      },
    },
    {
      name: "setPrompt",
      snapshotInputs: false,
      description: "修改此节点的视频生成提示词，支持 {{ref 1}} 等参考标记；只修改提示词，不启动生成",
      editor: { label: "生成提示词", values: { prompt: { node: "data.prompt" } }, fields: { prompt: { label: "提示词", multiline: true } } },
      parameters: z.strictObject({ prompt: z.string() }),
      async execute({ prompt }, context) {
        await context.patchData({ prompt, promptModel: prompt.split("\n").map((text: string) => [{ type: "Write", text }]) });
        return { prompt, nodeVersion: context.node.version };
      },
    },
    {
      name: "generateVideo",
      description: "启动此节点的后台视频生成，使用当前提示词、模型、模式、时长、分辨率、比例和参考素材；立即返回已开始，用 getGenerationStatus 查询完成结果，cancelGeneration 仅取消本地等待",
      parameters: z.strictObject({}),
      async execute(_args, context) {
        await requireAvailable(context);
        const state = await getConfig(context);
        const choice = state.models.find(item => item.providerId === state.config.providerId && item.modelId === state.config.modelId);
        if (!choice) throw new Error("请先选择视频模型");
        const inputs = await context.getInputs("in");
        if (inputs.some(item => item.value === undefined)) throw new Error("引用节点暂无内容，请先补充引用内容");
        if (choice.mode?.length && !state.matchingModes.length) throw new Error("当前模型没有适合这些参考素材的生成模式，请更换模型或调整引用");
        const prompt = [typeof context.node.data.prompt === "string" ? context.node.data.prompt.trim() : "", ...inputs.flatMap((item, index) => item.dataType === "STRING" && typeof item.value === "string" && item.value.trim() ? [`参考 ${index + 1}：\n${item.value.trim()}`] : [])].filter(Boolean).join("\n\n");
        if (!prompt) throw new Error("请输入生成提示词");
        const images = inputs.flatMap(item => item.dataType === "IMAGE" && item.value ? [{ path: item.value.url, mimeType: item.value.mimeType }] : []);
        const mode = state.config.mode;
        const frameMode = ["startEndRequired", "endFrameOptional", "startFrameOptional"].includes(String(mode));
        const request = { ...state.config, prompt, resolution: state.config.resolution || undefined, outputDirectory: `assets/${context.node.id}`,
          images: frameMode ? undefined : images,
          firstFrame: frameMode && (mode !== "startFrameOptional" || images.length > 1) ? images[0] : undefined,
          lastFrame: frameMode ? images[mode === "startFrameOptional" && images.length === 1 ? 0 : 1] : undefined,
          videos: inputs.flatMap(item => item.dataType === "VIDEO" && item.value ? [{ path: item.value.url, mimeType: item.value.mimeType }] : []),
          audios: inputs.flatMap(item => item.dataType === "AUDIO" && item.value ? [{ path: item.value.url, mimeType: item.value.mimeType }] : []),
        };
        const job = await context.runJob({ kind: "media", input: { mediaType: "video", request, binding: { outputSlot: "video" } } });
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
      name: "setVideo",
      snapshotInputs: false,
      description: "选择工作区内已有的视频文件作为此节点的输出，保留生成历史",
      editor: { label: "视频素材", values: { path: { node: "data.outputs.video.value.url" }, mimeType: { node: "data.outputs.video.value.mimeType" }, expectedOutput: { node: "data.outputs.video" } }, fields: { path: { label: "工作区视频路径" }, mimeType: { label: "媒体类型" }, expectedOutput: { hidden: true } } },
      parameters: z.strictObject({ path: z.string().min(1).max(4096), mimeType: z.string().regex(/^video\/[a-zA-Z0-9.+-]+$/), expectedOutput: z.json().optional().meta({ default: null }) }),
      async execute({ path, mimeType, expectedOutput }, context) {
        if (expectedOutput !== undefined && !isDeepStrictEqual(expectedOutput, (context.node.data.outputs as NodeOutputs | undefined)?.video ?? null)) throw Object.assign(new Error("视频输出已被其他操作修改，请保留草稿并核对当前输出"), { status: 409 });
        await requireAvailable(context);
        const content = await context.read(path);
        if (!content.byteLength || content.byteLength > 100 * 1024 * 1024) throw new Error("视频不能为空且不能超过 100 MB");
        const output = { dataType: "VIDEO" as const, value: { url: path, mimeType } };
        await context.setOutput("video", output);
        return { ...output, nodeVersion: context.node.version };
      },
    },
    {
      name: "uploadVideo",
      snapshotInputs: false,
      description: "校验临时上传的视频并归档为此节点输出，保留历史文件",
      parameters: z.strictObject({ stagedPath: z.string().max(4096).regex(/^assets\/uploads\/[a-zA-Z0-9.-]+$/), name: z.string().min(1).max(255), mimeType: z.string().regex(/^video\/[a-zA-Z0-9.+-]+$/) }),
      async execute({ stagedPath, name, mimeType }, context) {
        context.signal.throwIfAborted();
        await requireAvailable(context);
        context.signal.throwIfAborted();
        if (!context.node.id || /[\\/]/.test(context.node.id) || context.node.id === "." || context.node.id === "..") throw new Error("节点 ID 不能作为文件夹名称");
        const content = await context.read(stagedPath);
        context.signal.throwIfAborted();
        if (!content.byteLength || content.byteLength > 100 * 1024 * 1024) throw new Error("视频不能为空且不能超过 100 MB");
        const extension = name.match(/\.[a-zA-Z0-9]{1,12}$/)?.[0].toLowerCase() ?? "";
        const fileId = createHash("sha256").update(context.commandId).digest("hex");
        const path = `assets/${context.node.id}/${fileId}${extension}`;
        await context.write(path, content);
        context.signal.throwIfAborted();
        const output = { dataType: "VIDEO" as const, value: { url: path, mimeType } };
        await context.setOutput("video", output);
        return { ...output, nodeVersion: context.node.version };
      },
    },
  ],
};

export default definition;
