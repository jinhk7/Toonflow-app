import { Router } from "express";
import { z } from "zod";
import u from "@/utils";
import { validateFields } from "@/lib/middleware";
import { success } from "@/lib/responseFormat";

const router = Router();

export default router.put("/", validateFields({
  name: z.string().min(1).max(1024),
  order: z.array(z.string().min(1).max(1024)).max(2000),
}), async (req, res) => {
  const { name, order } = req.body as { name: string; order: string[] };
  const release = u.workspaceFile.lockWorkspaceFiles([u.skillFile.directory()]);
  try {
    await u.skillFile.saveOrder(name, order);
    res.json(success(null, "顺序已保存"));
  } finally { release(); }
});
