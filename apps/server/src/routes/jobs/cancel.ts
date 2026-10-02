import { Router } from "express";
import { z } from "zod";
import { validateFields } from "@/lib/middleware";
import { error, success } from "@/lib/responseFormat";
import u from "@/utils";

export default Router().post("/", validateFields({ jobId: z.uuid() }), async (req, res) => {
  await u.jobs.ensureNodeJobsReady();
  const job = u.jobs.getNodeJob(req.body.jobId as string);
  if (!job) return res.status(404).json(error("任务不存在", null, 404));
  res.json(success(u.jobs.cancelNodeJob(job.jobId)));
});
