import { Router } from "express";
import { z } from "zod";
import { validateFields } from "@/lib/middleware";
import { success } from "@/lib/responseFormat";
import u from "@/utils";

export default Router().put("/", validateFields({ directory: z.string().min(1), path: z.string().min(1).max(4096), content: z.string(), expectedRevision: z.string().regex(/^[a-f0-9]{64}$/), commandId: z.string().min(1).max(100) }), async (req, res) => {
  res.json(success(await u.canvasContent.writeVersionedContent(req.body)));
});
