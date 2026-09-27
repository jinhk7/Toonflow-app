import { Router } from "express";
import { z } from "zod";
import { validateFields } from "@/lib/middleware";
import { success, error } from "@/lib/responseFormat";
import type { CanvasInfo } from "@toonflow/tools-scaffold/runtime";
import { controlAgentRun, getAgentRunSnapshot, stopAgentGeneration } from "@/agent/runtime/runHost";
import u from "@/utils";

export default Router().post("/", validateFields({
  runId: z.uuid(),
  action: z.enum(["pause", "resume", "terminate", "stopGeneration"]),
  canvas: z.strictObject({
    id: z.string().min(1).max(256),
    tools: z.array(z.strictObject({
      nodeId: z.string().min(1).max(256),
      name: z.string().max(101).regex(/^node:[a-z][a-zA-Z0-9]*$/),
      nodeLabel: z.string().max(200).optional(),
      description: z.string().max(4000),
      parameters: z.record(z.string(), z.json()).refine(value => value.type === "object", "函数参数必须是 object JSON Schema"),
    })).max(1000),
  }).optional(),
}), async (req, res) => {
  const { runId, action, canvas } = req.body as { runId: string; action: "pause" | "resume" | "terminate" | "stopGeneration"; canvas?: CanvasInfo };
  const snapshot = getAgentRunSnapshot(runId);
  if (!snapshot) return res.status(404).json(error("运行不存在", null, 404));
  await u.workspace.resolveWorkspace(req, snapshot.cwd);
  try {
    if (action === "stopGeneration") {
      stopAgentGeneration(runId);
      return res.json(success(getAgentRunSnapshot(runId)));
    }
    res.json(success(await controlAgentRun(runId, action, { canvas })));
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : "操作失败";
    const status = (cause as { status?: number }).status ?? 400;
    res.status(status).json(error(message, null, status));
  }
});
