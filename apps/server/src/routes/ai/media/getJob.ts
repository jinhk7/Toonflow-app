import { Router } from "express";
import { z } from "zod";
import { validateFields } from "@/lib/middleware";
import { success, error } from "@/lib/responseFormat";
import u from "@/utils";
import { getMediaJob, getMediaJobByIdempotency } from "@/utils/media/mediaJobs";

export default Router().get("/", validateFields({
  directory: z.string().min(1).max(4096),
  jobId: z.string().uuid().optional(),
  idempotencyKey: z.string().min(1).max(256).optional(),
}, "query"), async (req, res) => {
  const { directory, jobId, idempotencyKey } = req.query as {
    directory: string;
    jobId?: string;
    idempotencyKey?: string;
  };
  if (!jobId && !idempotencyKey) {
    res.status(400).json(error("请提供 jobId 或 idempotencyKey", null, 400));
    return;
  }
  const cwd = await u.workspace.resolveWorkspace(req, directory);
  const job = jobId ? getMediaJob(jobId) : getMediaJobByIdempotency(cwd, idempotencyKey!);
  if (job && job.workspaceDirectory !== cwd) {
    res.status(404).json(error("媒体任务不存在", null, 404));
    return;
  }
  res.json(success(job));
});
