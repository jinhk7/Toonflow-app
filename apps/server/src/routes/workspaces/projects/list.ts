import { Router } from "express";
import { hydrateProjectStatuses, listProjects } from "@/utils/workspace/projects";
import { isSameAppOrigin } from "@/utils/workspace";
import { success, error } from "@/lib/responseFormat";

export default Router().get("/", async (req, res) => {
  if (!isSameAppOrigin(req)) return res.status(403).json(error("页面来源与服务地址不一致", null, 403));
  const projects = await hydrateProjectStatuses(listProjects());
  res.set("Cache-Control", "no-store").json(success({ projects }));
});
