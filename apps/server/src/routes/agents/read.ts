import { Router } from "express";
import { z } from "zod";
import u from "@/utils";
import { validateFields } from "@/lib/middleware";
import { success } from "@/lib/responseFormat";

export default Router().get("/", validateFields({ name: z.string().regex(u.teams.teamNamePattern) }, "query"), async (req, res) => {
  res.json(success(await u.teams.readEditableTeam(req.query.name as string)));
});
