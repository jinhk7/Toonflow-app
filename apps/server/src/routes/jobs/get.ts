import { Router } from "express";
import { z } from "zod";
import { validateFields } from "@/lib/middleware";
import { error, success } from "@/lib/responseFormat";
import u from "@/utils";

export default Router().get("/", validateFields({ jobId: z.uuid() }, "query"), async (req, res) => {
  await u.jobs.ensureNodeJobsReady();
  const job = u.jobs.getNodeJob(req.query.jobId as string);
  if (!job) return res.status(404).json(error("任务不存在", null, 404));
  const latest = u.jobs.getNodeJob(job.jobId)!;
  res.json(success({ ...latest, cursor: u.jobs.getNodeJobCursor(job.jobId) }));
});
