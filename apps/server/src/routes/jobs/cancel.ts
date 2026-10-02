import { Router } from "express";
import { z } from "zod";
import { validateFields } from "@/lib/middleware";
import { error, success } from "@/lib/responseFormat";
import u from "@/utils";

export default Router().post("/", validateFields({ directory: z.string().min(1).max(4096), jobId: z.uuid() }), async (req, res) => {
  const directory = await u.workspace.resolveWorkspace(req.body.directory);
  await u.jobs.ensureNodeJobsReady();
  const job = u.jobs.getNodeJob(req.body.jobId as string);
  if (!job || job.directory !== directory) return res.status(404).json(error("任务不存在", null, 404));
  res.json(success(u.jobs.cancelNodeJob(job.jobId)));
});
