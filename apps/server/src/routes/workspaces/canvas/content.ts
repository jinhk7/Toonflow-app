import { Router } from "express";
import { z } from "zod";
import { validateFields } from "@/lib/middleware";
import { success } from "@/lib/responseFormat";
import u from "@/utils";

export default Router().get("/", validateFields({ directory: z.string().min(1), path: z.string().min(1).max(4096) }, "query"), async (req, res) => {
  res.set("Cache-Control", "no-store").json(success(await u.canvasContent.readVersionedContent(req.query.directory as string, req.query.path as string)));
});
