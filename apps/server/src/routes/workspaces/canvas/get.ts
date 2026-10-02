import { Router } from "express";
import { z } from "zod";
import u from "@/utils";
import { validateFields } from "@/lib/middleware";
import { success } from "@/lib/responseFormat";

export default Router().get("/", validateFields({ directory: z.string().min(1).max(4096), path: z.string().min(1).max(4096) }, "query"), async (req, res) => {
  const { directory, path } = await u.workspaceFile.resolveWorkspaceFile(req.query.directory as string, req.query.path as string);
  const snapshot = await u.graph.readGraphSnapshot(path, directory);
  res.set("Cache-Control", "no-store").json(success({ ...snapshot.graph, cursor: snapshot.cursor }));
});
