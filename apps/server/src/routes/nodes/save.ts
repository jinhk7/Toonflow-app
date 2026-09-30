import { resolve } from "node:path";
import { Router } from "express";
import { z } from "zod";
import u from "@/utils";
import { validateFields } from "@/lib/middleware";
import { success } from "@/lib/responseFormat";

const router = Router();

export default router.put("/", validateFields({ name: u.nodePlugins.nodeNameSchema, config: z.record(z.string(), z.json()) }), async (req, res) => {
  const { name, config } = req.body;
  const release = u.workspaceFile.lockWorkspaceFiles([resolve(u.nodePlugins.nodesDirectory, `${name}.umd.js`)]);
  try {
    const { configRules } = await u.nodePlugins.readNode(name);
    const parsed = u.nodePlugins.validateNodeConfig(configRules, config);
    u.conf.set("nodeConfigs", { ...u.conf.get("nodeConfigs", {}), [name]: parsed });
    res.json(success(parsed, "节点配置已保存"));
  } finally { release(); }
});
