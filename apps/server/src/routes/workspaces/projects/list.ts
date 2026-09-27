import { Router } from "express";
import { hydrateProjectStatuses, listProjects } from "@/utils/workspace/projects";
import { success } from "@/lib/responseFormat";

export default Router().get("/", async (req, res) => {
  const projects = await hydrateProjectStatuses(listProjects());
  res.set("Cache-Control", "no-store").json(success({ projects }));
});
