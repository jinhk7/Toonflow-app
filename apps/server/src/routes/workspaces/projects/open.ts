import { Router } from "express";
import { z } from "zod";
import { validateFields } from "@/lib/middleware";
import * as workspace from "@/utils/workspace";
import { success } from "@/lib/responseFormat";
import { registerProject, registrationSourceForDirectory, relocateProject } from "@/utils/workspace/projects";

export default Router().post("/", validateFields({
  directory: z.string().min(1).max(4096),
  name: z.string().max(256).optional(),
  previousDirectory: z.string().max(4096).optional(),
}), async (req, res) => {
  const directory = await workspace.resolveWorkspace(req.body.directory);
  const previousDirectory = req.body.previousDirectory
    ? await workspace.resolveWorkspace(req.body.previousDirectory)
    : undefined;
  const relocated = previousDirectory && previousDirectory !== directory
    ? relocateProject(previousDirectory, directory, { name: req.body.name, lastOpenedAt: Date.now() })
    : null;
  const project = relocated ?? await registerProject(directory, {
    name: req.body.name,
    source: await registrationSourceForDirectory(directory),
    lastOpenedAt: Date.now(),
  });
  res.set("Cache-Control", "no-store").json(success({ project }));
});
