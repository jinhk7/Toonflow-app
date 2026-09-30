import { Router } from "express";
import { z } from "zod";
import u from "@/utils";
import { validateFields } from "@/lib/middleware";
import { success } from "@/lib/responseFormat";

export default Router().delete("/", validateFields({ name: z.string().regex(u.teams.teamNamePattern) }), async (req, res) => {
  await u.teams.uninstall(req.body.name);
  res.json(success(null, "团队已卸载"));
});
