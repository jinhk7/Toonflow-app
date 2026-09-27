import { Router } from "express";
import { z } from "zod";
import { validateFields } from "@/lib/middleware";
import { success, error } from "@/lib/responseFormat";
import { reviewInterruptedToolCalls, getAgentRunSnapshot } from "@/agent/runtime/runHost";
import { acknowledgeRunReview } from "@/agent/runtime/store";
import u from "@/utils";

export default Router().post("/", validateFields({ runId: z.uuid(), toolCallId: z.string().min(1).max(256) }), async (req, res) => {
  const { runId, toolCallId } = req.body as { runId: string; toolCallId: string };
  const snapshot = getAgentRunSnapshot(runId);
  if (!snapshot) return res.status(404).json(error("运行不存在", null, 404));
  await u.workspace.resolveWorkspace(req, snapshot.cwd);
  reviewInterruptedToolCalls(runId);
  acknowledgeRunReview(runId, toolCallId);
  res.json(success(getAgentRunSnapshot(runId)));
});
