import { runAgentLoop, type AgentTool } from "@earendil-works/pi-agent-core";
import type { Message, Model, Api } from "@earendil-works/pi-ai";
import { z } from "zod";
import { createDirectorDraft } from "./agentTools";
import { directorPrompt } from "./agentPrompt";
import { anchorSchema, modelDocumentSchema } from "./document";

export const directorReferencesSchema = z.array(z.discriminatedUnion("dataType", [
  z.strictObject({ dataType: z.literal("STRING"), value: z.string() }),
  z.strictObject({ dataType: z.literal("IMAGE"), value: z.strictObject({ url: z.string().min(1), mimeType: z.string().startsWith("image/") }) }),
  z.strictObject({ dataType: z.literal("VIDEO"), value: z.strictObject({ url: z.string().min(1), mimeType: z.string().startsWith("video/") }) }),
])).max(32);

export const directorDraftInputSchema = z.strictObject({
  id: z.string().min(1).max(100), instruction: z.string().trim().min(1).max(100000),
  providerId: z.string().min(1), modelId: z.string().min(1),
  document: modelDocumentSchema, modelPath: z.string().min(1), modelRevision: z.string().min(1),
  selectedPlanId: z.string().max(100), anchors: z.array(anchorSchema).max(120),
  references: directorReferencesSchema,
});

/** 核心提供现有 streamAi 适配后的 stream 函数；此处不读取设置、不执行 HTTP、不持有画布。 */
export async function generateDirectorDraft(value: unknown, model: Model<Api>, stream: NonNullable<Parameters<typeof runAgentLoop>[5]>, signal: AbortSignal) {
  const input = directorDraftInputSchema.parse(value);
  if (model.id !== input.modelId) throw new Error("导演任务快照与已配置模型不一致");
  const selected = input.document.plans.find(plan => plan.id === input.selectedPlanId);
  const plan = selected ? { name: selected.name, duration: selected.duration, tracks: selected.tracks, cameraFrames: selected.cameraFrames } : undefined;
  const draft = createDirectorDraft(input.document.scene, plan, input.document.plans);
  const callSignal = AbortSignal.any([signal, AbortSignal.timeout(600000)]);
  const tools: AgentTool[] = draft.tools.map(tool => ({
    name: tool.name, label: tool.name, description: tool.description, parameters: tool.parameters,
    async execute(_id, args, toolSignal) {
      callSignal.throwIfAborted();
      if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error("导演工具参数必须是对象");
      const result = await tool.execute(args as Record<string, unknown>, toolSignal);
      return { content: [{ type: "text", text: JSON.stringify(result ?? null) }], details: undefined };
    },
  }));
  const references = input.anchors.map(({ camera, controls }, index) => ({ order: index + 1, camera, controls }));
  let turns = 0;
  await runAgentLoop([{ role: "user", content: JSON.stringify({ instruction: input.instruction, references, selectedPlanId: input.selectedPlanId, document: draft.summary() }), timestamp: Date.now() }], {
    systemPrompt: directorPrompt, messages: [], tools,
  }, {
    model, convertToLlm: messages => messages as Message[], toolExecution: "sequential",
    shouldStopAfterTurn: ({ message }) => ++turns >= 40 || message.stopReason === "length",
  }, () => callSignal.throwIfAborted(), callSignal, stream);
  callSignal.throwIfAborted();
  if (!draft.edited) throw new Error("Agent 未修改方案，原方案未修改，请重试");
  const result = draft.read();
  const objects = new Map(result.scene.objectList.map(object => [object.threeJsonId, object]));
  const previousPlans = draft.sceneChanged ? input.document.plans.map(item => ({
    ...item, tracks: item.tracks.filter(track => objects.has(track.objectId) && (!track.joint || objects.get(track.objectId)?.objType === "mannequin")),
  })) : input.document.plans;
  const document = modelDocumentSchema.parse({ version: 1, scene: result.scene,
    plans: [...previousPlans, { ...result.plan, id: input.id, instruction: input.instruction }],
  });
  return { document, modelPath: input.modelPath, expectedRevision: input.modelRevision, selectedPlanId: input.id, basePlanId: input.selectedPlanId };
}
