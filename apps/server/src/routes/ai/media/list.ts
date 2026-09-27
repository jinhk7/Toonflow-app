import { Router } from "express";
import { z } from "zod";
import { validateFields } from "@/lib/middleware";
import { success } from "@/lib/responseFormat";
import u from "@/utils";
import { listProjectMediaJobs } from "@/utils/media/jobLedger";
import { toMediaJobView } from "@/utils/media/mediaJobs";

export default Router().get("/", validateFields({ directory: z.string().min(1).max(4096) }, "query"), async (req, res) => {
  const directory = await u.workspace.resolveWorkspace(String(req.query.directory));
  res.set("Cache-Control", "no-store").json(success(listProjectMediaJobs(directory).map(toMediaJobView)));
});
