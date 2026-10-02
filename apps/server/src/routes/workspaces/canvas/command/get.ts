import { Router } from "express";
import { z } from "zod";
import { validateFields } from "@/lib/middleware";
import { success } from "@/lib/responseFormat";
import u from "@/utils";

export default Router().get("/", validateFields({ directory: z.string().min(1), commandId: z.string().min(1).max(80) }, "query"), async (req, res) => {
  const directory = await u.workspace.resolveWorkspace(req.query.directory as string);
  const result = u.canvasStore.getCanvasCommand(directory, req.query.commandId as string);
  if (!result) throw Object.assign(new Error("命令不存在"), { status: 404 });
  res.json(success(result));
});
