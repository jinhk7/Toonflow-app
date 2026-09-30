import { Router } from "express";
import { z } from "zod";
import { validateFields } from "@/lib/middleware";
import { success, error } from "@/lib/responseFormat";
import { getAgentRunSnapshot } from "@/agent/runtime/runHost";
import u from "@/utils";

export default Router().get("/", validateFields({
  runId: z.uuid(),
}, "query"), async (req, res) => {
  const snapshot = getAgentRunSnapshot(req.query.runId as string);
  if (!snapshot) return res.status(404).json(error("运行不存在", null, 404));
  await u.workspace.resolveWorkspace(snapshot.cwd);
  res.set("Cache-Control", "no-store").json(success(snapshot));
});
