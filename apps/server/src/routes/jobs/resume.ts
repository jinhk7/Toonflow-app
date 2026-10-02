import { Router } from "express";
import { z } from "zod";
import u from "@/utils";
import { validateFields } from "@/lib/middleware";
import { success } from "@/lib/responseFormat";

export default Router().post("/", validateFields({
  directory: z.string().min(1).max(4096), jobId: z.uuid(), confirmed: z.literal(true),
}), async (req, res) => {
  const directory = await u.workspace.resolveWorkspace(req.body.directory);
  await u.jobs.ensureNodeJobsReady();
  const job = u.jobs.getNodeJob(req.body.jobId as string);
  if (!job || job.directory !== directory) throw Object.assign(new Error("任务不存在"), { status: 404 });
  res.status(202).set("Cache-Control", "no-store").json(success(u.jobs.resumeNodeJob(job.jobId)));
});
