import { Router } from "express";
import { z } from "zod";
import { validateFields } from "@/lib/middleware";
import { success } from "@/lib/responseFormat";
import { hydrateProjectStatuses, importLocalProjects, listProjects } from "@/utils/workspace/projects";

const project = z.object({
  directory: z.string().min(1).max(4096),
  name: z.string().min(1).max(256),
  lastOpenedAt: z.number().int().nonnegative(),
});

export default Router().post("/", validateFields({
  projects: z.array(project).max(1000),
}), async (req, res) => {
  const result = await importLocalProjects(req.body.projects);
  const projects = await hydrateProjectStatuses(listProjects());
  res.set("Cache-Control", "no-store").json(success({ ...result, projects }));
});
