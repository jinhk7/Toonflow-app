import { Router } from "express";
import { z } from "zod";
import { validateFields } from "@/lib/middleware";
import { success } from "@/lib/responseFormat";
import { ensureAgentRuntimeReady } from "@/agent/runtime/runHost";
import { listAgentRunsForWorkspace } from "@/agent/runtime/store";
import u from "@/utils";

export default Router().get("/", validateFields({ directory: z.string().min(1).max(4096) }, "query"), async (req, res) => {
  const cwd = await u.workspace.resolveWorkspace(req.query.directory as string);
  await ensureAgentRuntimeReady();
  res.set("Cache-Control", "no-store").json(success(listAgentRunsForWorkspace(cwd)));
});
