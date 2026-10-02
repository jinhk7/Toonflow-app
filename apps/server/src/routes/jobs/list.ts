import { Router } from "express";
import { z } from "zod";
import { validateFields } from "@/lib/middleware";
import { success } from "@/lib/responseFormat";
import u from "@/utils";

export default Router().get("/", validateFields({ directory: z.string().min(1).max(4096), snapshot: z.literal("1").optional() }, "query"), async (req, res) => {
  await u.jobs.ensureNodeJobsReady();
  const directory = await u.workspace.resolveWorkspace(req.query.directory as string);
  // 游标先于同步列表读取，订阅至少重放快照读取之后的变化。
  const cursor = u.canvasStore.getWorkspaceCursor(directory);
  const jobs = u.jobs.listNodeJobs(directory);
  res.set("Cache-Control", "no-store").json(success(req.query.snapshot === "1" ? { jobs, cursor } : jobs));
});
