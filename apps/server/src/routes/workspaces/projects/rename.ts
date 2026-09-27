import { Router } from "express";
import { z } from "zod";
import { validateFields } from "@/lib/middleware";
import { success } from "@/lib/responseFormat";
import { normalizeProjectDirectory, renameProject } from "@/utils/workspace/projects";

export default Router().put("/", validateFields({
  directory: z.string().min(1).max(4096),
  name: z.string().min(1).max(256),
}), async (req, res) => {
  const directory = await normalizeProjectDirectory(req.body.directory);
  const project = renameProject(directory, req.body.name);
  res.set("Cache-Control", "no-store").json(success({ project }));
});
