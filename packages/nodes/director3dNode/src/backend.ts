import { z } from "zod";
import type { NodeExecutionAction, NodeExecutionContext, NodeExecutionDefinition } from "@toonflow/nodes-scaffold/execution";
import { anchorSchema, createEmptyScene, createMannequinObject, modelDocumentSchema, type ModelDocument } from "./document";
import { getRenderSize, lightingSchema, renderJobSchema, sceneSettingsSchema } from "./renderJob";
import { directorDraftInputSchema, directorReferencesSchema } from "./draftRunner";
export { directorDraftInputSchema, generateDirectorDraft } from "./draftRunner";

function getModelPath(context: NodeExecutionContext) {
  const id = context.node.id;
  if (!id || /[\\/\x00-\x1f]/.test(id) || id === "." || id === "..") throw new Error("节点 ID 不能作为模型文件目录");
  const path = `assets/${id}/model.json`;
  if (context.node.data.modelPath && context.node.data.modelPath !== path) throw new Error("导演模型文件路径无效");
  return path;
}

async function readModel(context: NodeExecutionContext) {
  const path = getModelPath(context);
  const { content, revision, exists } = await context.readText(path);
  if (exists === false) throw Object.assign(new Error("导演模型文件不存在"), { code: "ENOENT" });
  if (new TextEncoder().encode(content).byteLength > 2000000) throw new Error("导演模型文件不能超过 2 MB");
  return { path, revision, document: modelDocumentSchema.parse(JSON.parse(content)), directory: context.directory, canvasPath: context.canvasPath };
}

async function writeModel(context: NodeExecutionContext, document: ModelDocument, expectedRevision?: string) {
  const value = modelDocumentSchema.parse(document);
  const content = JSON.stringify(value, null, 2);
  if (new TextEncoder().encode(content).byteLength > 2000000) throw new Error("导演模型文件不能超过 2 MB");
  const path = getModelPath(context);
  const { revision } = await context.writeText(path, content, expectedRevision);
  await context.patchData({ modelPath: path, modelRevision: revision, modelSnapshot: null });
  return { path, revision, document: value };
}

function action<Schema extends z.ZodType>(name: string, description: string, parameters: Schema,
  execute: (args: z.output<Schema>, context: NodeExecutionContext) => unknown | Promise<unknown>, snapshotInputs = false): NodeExecutionAction {
  return { name, description, parameters, snapshotInputs, execute: (args, context) => execute(parameters.parse(args), context) };
}

const preferencesSchema = z.strictObject({
  prompt: z.string().max(100000).optional(), model: z.string().max(1000).optional(),
  promptModel: z.json().optional(),
  selectedPlanId: z.string().max(100).optional(), anchors: z.array(anchorSchema).max(120).optional(),
  lighting: lightingSchema.optional(), sceneSettings: sceneSettingsSchema.optional(),
});
const aspectSchema = z.number().min(0.1).max(10);

const definition: NodeExecutionDefinition = {
  protocolVersion: 2, name: "director3dNode", stateVersion: 1,
  handles: [{ id: "in", type: "target", dataType: ["STRING", "IMAGE", "VIDEO"], label: "文本、图片、视频输入" }],
  defaultData: { label: "3D导演台", prompt: "", model: "", anchors: [], selectedPlanId: "" },
  layoutSize: { width: 320, height: 240 },
  async initialize(context) {
    if (context.node.data.modelPath) { await readModel(context); return; }
    const path = getModelPath(context);
    const current = await context.readText(path);
    if (current.exists !== false) {
      // 撤销恢复或落盘后重试沿用此节点的权威文件，不用旧复制快照覆盖后续编辑。
      modelDocumentSchema.parse(JSON.parse(current.content));
      await context.patchData({ modelPath: path, modelRevision: current.revision, modelSnapshot: null });
      return;
    }
    const snapshot = context.node.data.modelSnapshot;
    const document = snapshot ? modelDocumentSchema.parse(snapshot) : { version: 1 as const, scene: createEmptyScene(), plans: [] };
    await writeModel(context, document, current.revision);
  },
  actions: [
    action("getDocument", "读取导演模型和文件版本", z.strictObject({}), (_args, context) => readModel(context)),
    action("getCopyData", "从后台模型文件生成独立节点复制快照，不共享原节点文件", z.strictObject({}), async (_args, context) => {
      const current = await readModel(context);
      return { modelPath: null, modelRevision: null, modelSnapshot: structuredClone(current.document) };
    }),
    action("saveDocument", "按原文件版本提交导演模型，冲突时保留原文件", z.strictObject({
      document: modelDocumentSchema, expectedRevision: z.string().min(1),
    }), (args, context) => writeModel(context, args.document, args.expectedRevision)),
    action("setPreferences", "保存导演指令、模型、镜头锚点、灯光和显示设置", preferencesSchema, async (args, context) => {
      if (args.selectedPlanId) {
        const current = await readModel(context);
        if (!current.document.plans.some(plan => plan.id === args.selectedPlanId)) throw new Error("选择的导演方案不存在");
      }
      return context.patchData(args);
    }),
    action("addMannequin", "向当前导演模型添加内置关节人偶", z.strictObject({}), async (_args, context) => {
      const current = await readModel(context);
      if (current.document.scene.objectList.length >= 200) throw new Error("场景物体最多 200 个");
      current.document.scene.objectList.push(createMannequinObject(crypto.randomUUID()));
      return writeModel(context, current.document, current.revision);
    }),
    action("generate", "接受固定模型快照的后台导演草稿任务", z.strictObject({
      instruction: z.string().trim().min(1).max(100000), providerId: z.string().min(1), modelId: z.string().min(1),
    }), async (args, context) => {
      const current = await readModel(context);
      const inputs = await context.getInputs("in");
      if (inputs.some(input => input.value === undefined)) throw new Error("参考节点尚未提供输出，请先完成参考内容");
      const references = directorReferencesSchema.parse(inputs.map(({ dataType, value }) => ({ dataType, value })));
      const input = directorDraftInputSchema.parse({ ...args, id: context.commandId, document: current.document, modelPath: current.path,
        modelRevision: current.revision, selectedPlanId: context.node.data.selectedPlanId ?? "", anchors: context.node.data.anchors ?? [], references });
      return context.runJob({
        kind: "directorDraft", pluginRevision: context.revision, nodeId: context.node.id, canvasPath: context.canvasPath,
        input,
      });
    }, true),
    action("exportVideo", "按固定时间采样接受后台无音轨 MP4 渲染任务", z.strictObject({ aspect: aspectSchema }), async (args, context) => {
      const current = await readModel(context);
      const plan = current.document.plans.find(item => item.id === context.node.data.selectedPlanId);
      if (!plan) throw new Error("请先选择导演方案");
      const input = renderJobSchema.parse({ format: "video", scene: current.document.scene, plan: {
        name: plan.name, duration: plan.duration, tracks: plan.tracks, cameraFrames: plan.cameraFrames,
      }, aspect: args.aspect, ...getRenderSize(args.aspect), frameRate: 30,
        lighting: context.node.data.lighting, settings: context.node.data.sceneSettings });
      return context.runJob({ kind: "render", input, pluginRevision: context.revision, nodeId: context.node.id, canvasPath: context.canvasPath });
    }),
    action("exportImage", "接受指定镜头和时点的后台 PNG 渲染任务", z.strictObject({
      aspect: aspectSchema, anchor: anchorSchema, time: z.number().min(0).max(300),
    }), async (args, context) => {
      const current = await readModel(context);
      const plan = current.document.plans.find(item => item.id === context.node.data.selectedPlanId);
      const input = renderJobSchema.parse({ format: "image", scene: current.document.scene,
        plan: plan ? { name: plan.name, duration: plan.duration, tracks: plan.tracks, cameraFrames: plan.cameraFrames } : undefined,
        ...args, ...getRenderSize(args.aspect), frameRate: 30,
        lighting: context.node.data.lighting, settings: context.node.data.sceneSettings });
      return context.runJob({ kind: "render", input, pluginRevision: context.revision, nodeId: context.node.id, canvasPath: context.canvasPath });
    }),
  ],
};
export default definition;
