import { Router } from "express";
import { z } from "zod";
import { validateFields } from "@/lib/middleware";
import * as workspace from "@/utils/workspace";
import { error, success } from "@/lib/responseFormat";
import { hydrateProjectStatuses, importLocalProjects, listProjects } from "@/utils/workspace/projects";

const project = z.object({
  directory: z.string().min(1).max(4096),
  name: z.string().min(1).max(256),
  lastOpenedAt: z.number().int().nonnegative(),
});

export default Router().post("/", validateFields({
  projects: z.array(project).max(1000),
}), async (req, res) => {
  if (!workspace.isLocalWorkspaceRequest(req)) {
    return res.status(403).json(error("仅本机页面可导入历史项目列表", null, 403));
  }
  const result = await importLocalProjects(req.body.projects);
  const projects = await hydrateProjectStatuses(listProjects());
  res.set("Cache-Control", "no-store").json(success({ ...result, projects }));
});
