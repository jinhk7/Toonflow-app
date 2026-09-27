import { Router } from "express";
import { z } from "zod";
import { validateFields } from "@/lib/middleware";
import { success, error } from "@/lib/responseFormat";
import { getAgentRun, listAuthorizations } from "@/agent/runtime/store";
import u from "@/utils";

export default Router().get("/", validateFields({ runId: z.uuid() }, "query"), async (req, res) => {
  const runId = req.query.runId as string;
  const run = getAgentRun(runId);
  if (!run) return res.status(404).json(error("运行不存在", null, 404));
  await u.workspace.resolveWorkspace(req, run.cwd);
  res.set("Cache-Control", "no-store").json(success(listAuthorizations(runId)));
});
