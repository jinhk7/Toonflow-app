import { z } from "zod";
import type { NodeExecutionContext, NodeExecutionDefinition } from "@toonflow/nodes-scaffold/execution";
import type { NodeOutputs } from "@toonflow/nodes-scaffold/values";

function textPath(context: NodeExecutionContext) {
  if (!context.node.id || /[\\/]/.test(context.node.id) || context.node.id === "." || context.node.id === "..") throw new Error("节点 ID 不能作为文件夹名称");
  const path = `assets/${context.node.id}/content.md`;
  if (context.node.data.textPath != null && context.node.data.textPath !== path) throw new Error("文本文件路径无效");
  return path;
}

async function initialize(context: NodeExecutionContext) {
  const path = textPath(context);
  if (context.node.data.textPath) return;
  const jobId = context.node.data.generationJobId;
  // 新节点不能继承来源节点的任务；原 ID 的撤销恢复继续保留自己的绑定。
  if (typeof jobId === "string" && !await context.getJob(jobId)) await context.patchData({ generationJobId: null });
  const outputs = context.node.data.outputs as NodeOutputs | undefined;
  const content = context.node.data.textSnapshot ?? (outputs?.text?.dataType === "STRING" ? outputs.text.value : "");
  if (typeof content !== "string") throw new Error("文本内容无效");
  const current = await context.readText(path);
  // ACT: 成功落盘后才移除旧正文；失败时保留原画布数据供恢复。
  if (current.content && current.content !== content) throw new Error("文本文件已存在且与旧正文不同，请先核对");
  await context.writeText(path, content, current.revision);
  await context.setOutput("text", null);
  await context.patchData({ textPath: path, textSnapshot: null });
}

async function currentJob(context: NodeExecutionContext) {
  const id = context.node.data.generationJobId;
  return typeof id === "string" ? context.getJob(id) : undefined;
}

const definition: NodeExecutionDefinition = {
  protocolVersion: 2,
  name: "textNode",
  stateVersion: 2,
  handles: [
    { id: "in", type: "target", dataType: ["VIDEO", "IMAGE", "STRING"], label: "视频、图片、文本输入" },
    { id: "text", type: "source", dataType: "STRING", label: "文本输出" },
  ],
  defaultData: { label: "文本", prompt: "", promptModel: [], model: "" },
  layoutSize: { width: 320, height: 170 },
  initialize,
  async readOutputs(context) {
    if (!context.node.data.textPath) {
      const outputs = context.node.data.outputs as NodeOutputs | undefined;
      const content = context.node.data.textSnapshot ?? (outputs?.text?.dataType === "STRING" ? outputs.text.value : "");
      return { text: { dataType: "STRING", value: typeof content === "string" ? content : "" } };
    }
    const { content } = await context.readText(textPath(context));
    return { text: { dataType: "STRING", value: content } };
  },
  actions: [
    {
      name: "getCopyData",
      snapshotInputs: false,
      description: "读取权威文本生成独立复制快照，副本不继承来源节点的生成任务",
      parameters: z.strictObject({}),
      async execute(_args, context) {
        await initialize(context);
        const current = await context.readText(textPath(context));
        return { textPath: null, textSnapshot: current.content, generationJobId: null };
      },
    },
    {
      name: "getText",
      snapshotInputs: false,
      description: "加载文本正文，安全迁移旧节点的内联文本并返回正文版本",
      parameters: z.strictObject({}),
      async execute(_args, context) {
        await initialize(context);
        return context.readText(textPath(context));
      },
    },
    {
      name: "setText",
      snapshotInputs: false,
      description: "修改此节点的文本输出",
      parameters: z.strictObject({ text: z.string() }),
      async execute({ text }, context) {
        const job = await currentJob(context);
        if (job && ["accepted", "running"].includes(job.status)) throw new Error("文本生成中，请稍后修改");
        await initialize(context);
        const path = textPath(context);
        const current = await context.readText(path);
        const result = await context.writeText(path, text, current.revision);
        return { text, revision: result.revision };
      },
    },
    {
      name: "getConfig",
      snapshotInputs: false,
      description: "读取文本节点的当前模型和可选文本模型，不含密钥",
      parameters: z.strictObject({}),
      async execute(_args, context) {
        return { model: context.node.data.model ?? "", models: await context.getModels("text") };
      },
    },
    {
      name: "setConfig",
      snapshotInputs: false,
      description: "修改文本节点模型；providerId 与 modelId 使用 getConfig 返回的值，不启动生成",
      parameters: z.strictObject({ providerId: z.string().min(1), modelId: z.string().min(1) }),
      async execute({ providerId, modelId }, context) {
        const models = await context.getModels("text");
        if (!models.some(item => item.providerId === providerId && item.modelId === modelId)) throw new Error("请选择有效文本模型");
        await context.patchData({ model: JSON.stringify([providerId, modelId]) });
        return { providerId, modelId };
      },
    },
    {
      name: "setPrompt",
      snapshotInputs: false,
      description: "修改文本生成提示词，不启动生成",
      parameters: z.strictObject({ prompt: z.string() }),
      async execute({ prompt }, context) {
        await context.patchData({ prompt, promptModel: prompt.split("\n").map((text: string) => [{ type: "Write", text }]) });
        return { prompt };
      },
    },
    {
      name: "generateText",
      description: "使用当前模型、提示词和引用启动后台文本生成；立即返回任务，用 getGenerationStatus 查询结果",
      parameters: z.strictObject({}),
      async execute(_args, context) {
        const previous = await currentJob(context);
        if (previous && ["accepted", "running", "needsReview"].includes(previous.status)) throw new Error("已有未决文本任务，请先核对原任务");
        await initialize(context);
        const models = await context.getModels("text");
        const selected = models.find(item => JSON.stringify([item.providerId, item.modelId]) === context.node.data.model)
          ?? (!context.node.data.model ? models[0] : undefined);
        if (!selected) throw new Error("请先选择文本模型");
        const prompt = typeof context.node.data.prompt === "string" ? context.node.data.prompt.trim() : "";
        if (!prompt) throw new Error("请输入生成提示词");
        const inputs = await context.getInputs("in");
        if (inputs.some(item => item.value === undefined)) throw new Error("引用节点暂无内容，请先补充引用内容");
        const references = inputs.filter(item => ["STRING", "IMAGE", "VIDEO"].includes(String(item.dataType))).map(({ dataType, value }) => ({ dataType, value }));
        const path = textPath(context);
        const current = await context.readText(path);
        const job = await context.runJob({ kind: "text", input: { providerId: selected.providerId, modelId: selected.modelId, prompt, references, path, expectedRevision: current.revision } });
        return { status: "generating", jobId: job.jobId };
      },
    },
    {
      name: "getGenerationStatus",
      snapshotInputs: false,
      description: "查询后台文本生成状态和当前输出；重连或重新打开节点后仍可查询",
      parameters: z.strictObject({}),
      async execute(_args, context) {
        const job = await currentJob(context);
        return { status: job?.status ?? "idle", jobId: job?.jobId, result: job?.result, error: job?.errorMessage, outputs: await definition.readOutputs!(context) };
      },
    },
    {
      name: "abandonUnknownGeneration",
      snapshotInputs: false,
      description: "用户核对并确认后解除需要核对的文本任务绑定，保留任务历史与已生成结果；不修改正文、不启动新生成",
      parameters: z.strictObject({ confirmed: z.literal(true) }),
      async execute(_args, context) {
        const job = await currentJob(context);
        if (job?.status !== "needsReview") throw new Error("任务状态已变化，请重新核对");
        await context.patchData({ generationJobId: null });
        return { abandoned: true, jobId: job.jobId, result: job.result };
      },
    },
    {
      name: "cancelGeneration",
      snapshotInputs: false,
      description: "请求停止当前后台文本生成，保留已保存正文；停止状态由 getGenerationStatus 返回",
      parameters: z.strictObject({}),
      async execute(_args, context) {
        const job = await currentJob(context);
        const cancellationRequested = !!job && ["accepted", "running"].includes(job.status);
        if (cancellationRequested) await context.cancelJob(job!.jobId);
        return { cancellationRequested, jobId: job?.jobId };
      },
    },
  ],
};

export default definition;
