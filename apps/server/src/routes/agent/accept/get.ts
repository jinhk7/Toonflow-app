import { Router } from "express";
import { z } from "zod";
import { validateFields } from "@/lib/middleware";
import { error, success } from "@/lib/responseFormat";
import { ensureAgentRuntimeReady, getAgentAcceptanceSnapshot } from "@/agent/runtime/runHost";
import u from "@/utils";

export default Router().get("/", validateFields({
  directory: z.string().min(1).max(4096),
  clientMessageId: z.string().min(1).max(128),
}, "query"), async (req, res) => {
  const cwd = await u.workspace.resolveWorkspace(req.query.directory as string);
  await ensureAgentRuntimeReady();
  const receipt = getAgentAcceptanceSnapshot(cwd, req.query.clientMessageId as string);
  if (!receipt) return res.status(404).json(error("消息尚未受理", null, 404));
  res.json(success(receipt));
});
