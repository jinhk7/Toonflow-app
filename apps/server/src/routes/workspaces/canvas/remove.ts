import { unlink } from "node:fs/promises";
import { Router } from "express";
import { z } from "zod";
import u from "@/utils";
import { validateFields } from "@/lib/middleware";
import { success } from "@/lib/responseFormat";

export default Router().delete("/", validateFields({ directory: z.string().min(1).max(4096), path: z.string().min(1).max(4096) }), async (req, res) => {
  const { directory, path } = await u.workspaceFile.resolveWorkspaceFile(req.body.directory, req.body.path);
  u.workspaceFile.protectWorkspaceRoot(directory, path);
  const release = u.workspaceFile.lockWorkspaceFiles([path]);
  try {
    await u.graph.readGraphUnlocked(path);
    await unlink(path);
  } finally { release(); }
  res.json(success());
});
