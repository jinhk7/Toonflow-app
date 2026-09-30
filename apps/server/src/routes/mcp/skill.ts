import { Router } from "express";
import skill from "@toonflow/mcp/skill" with { type: "text" };

export default Router().get("/", (req, res) => {
  res.set({ "Content-Type": "text/markdown; charset=utf-8", "Content-Disposition": 'attachment; filename="SKILL.md"', "Cache-Control": "no-store" }).send(skill);
});
