import { Router } from "express";
import { z } from "zod";
import { validateFields } from "@/lib/middleware";
import { success, error } from "@/lib/responseFormat";
import { getAgentRun, grantAuthorization } from "@/agent/runtime/store";
import { getAgentRunSnapshot } from "@/agent/runtime/runHost";
import u from "@/utils";

export default Router().post("/", validateFields({
  runId: z.uuid(),
  toolCallId: z.string().min(1).max(256),
  remaining: z.number().int().min(1).max(1000).optional(),
}), async (req, res) => {
  const { runId, toolCallId, remaining } = req.body as { runId: string; toolCallId: string; remaining?: number };
  const run = getAgentRun(runId);
  if (!run) return res.status(404).json(error("运行不存在", null, 404));
  await u.workspace.resolveWorkspace(req, run.cwd);
  grantAuthorization(runId, toolCallId, remaining);
  res.json(success(getAgentRunSnapshot(runId)));
});
