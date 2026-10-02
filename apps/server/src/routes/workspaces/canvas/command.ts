import { Router } from "express";
import { validateFields } from "@/lib/middleware";
import { success } from "@/lib/responseFormat";
import u from "@/utils";

export default Router().post("/", validateFields(u.backendCanvas.canvasCommandSchema.shape), async (req, res) => {
  const result = await u.backendCanvas.submitCanvasCommand(req.body);
  res.status(result.status === "completed" ? 200 : 202).json(success(result));
});
