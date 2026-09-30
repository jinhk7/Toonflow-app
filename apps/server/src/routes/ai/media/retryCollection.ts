import { Router } from "express";
import { z } from "zod";
import { validateFields } from "@/lib/middleware";
import { success, error } from "@/lib/responseFormat";
import { retryMediaJobCollection } from "@/utils/media/mediaJobs";
import u from "@/utils";

export default Router().post("/", validateFields({
  jobId: z.string().uuid(),
  directory: z.string().min(1).max(4096),
}), async (req, res) => {
  try {
    const directory = await u.workspace.resolveWorkspace(req.body.directory);
    res.json(success(await retryMediaJobCollection(req.body.jobId, directory)));
  } catch (err) {
    const status = typeof err === "object" && err && "status" in err ? Number((err as { status: number }).status) : 500;
    const message = err instanceof Error ? err.message : "重试收取失败";
    res.status(status >= 400 && status < 600 ? status : 500).json(error(message, null, status >= 400 ? status : 500));
  }
});
