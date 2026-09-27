import { Router } from "express";
import { z } from "zod";
import u from "@/utils";
import { validateFields } from "@/lib/middleware";
import { success } from "@/lib/responseFormat";
import { relative } from "node:path";
import { updateMediaJobCanvasPath } from "@/utils/media/jobLedger";

export default Router().post("/", validateFields({ directory: z.string().min(1).max(4096), path: z.string().min(1).max(4096), target: z.string().min(1).max(4096) }), async (req, res) => {
  const source = await u.workspaceFile.resolveWorkspaceFile(req, req.body.directory, req.body.path);
  const target = await u.workspaceFile.resolveWorkspacePath(source.directory, req.body.target);
  u.workspaceFile.protectWorkspaceRoot(source.directory, source.path);
  u.workspaceFile.protectWorkspaceRoot(target.directory, target.path);
  const release = u.workspaceFile.lockWorkspaceFiles([source.path, target.path]);
  try {
    const graph = await u.graph.readGraphUnlocked(source.path);
    await u.workspaceFile.renameWorkspaceFile(source.path, target.path);
    updateMediaJobCanvasPath(source.directory, graph.toonflowGraph!.id, relative(source.directory, target.path).split("\\").join("/"));
  } finally { release(); }
  res.json(success());
});
