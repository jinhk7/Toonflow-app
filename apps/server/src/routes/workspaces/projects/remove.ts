import { Router } from "express";
import { z } from "zod";
import { validateFields } from "@/lib/middleware";
import { error, success } from "@/lib/responseFormat";
import { normalizeProjectDirectory, removeProject } from "@/utils/workspace/projects";

export default Router().delete("/", validateFields({
  directory: z.string().min(1).max(4096),
}), async (req, res) => {
  // 目录已失效的登记也要能移除，此时按登记时的原路径匹配。
  const directory = await normalizeProjectDirectory(req.body.directory).catch((err: { status?: number }) => {
    if (err.status === 404) return req.body.directory as string;
    throw err;
  });
  const project = removeProject(directory);
  if (!project) return res.status(404).json(error("项目未登记", null, 404));
  res.set("Cache-Control", "no-store").json(success({ project }));
});
