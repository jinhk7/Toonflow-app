import { Router } from "express";
import { z } from "zod";
import { validateFields } from "@/lib/middleware";
import u from "@/utils";

export default Router().get("/", validateFields({ directory: z.string().min(1), afterSeq: z.coerce.number().int().nonnegative().optional() }, "query"), async (req, res) => {
  const directory = await u.workspace.resolveWorkspace(req.query.directory as string);
  const afterSeq = req.query.afterSeq === undefined ? 0 : Number(req.query.afterSeq);
  res.set({ "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-cache", "X-Accel-Buffering": "no" });
  res.flushHeaders();
  const unsubscribe = u.canvasStore.subscribeWorkspaceEvents(directory, afterSeq, event => { if (!res.destroyed) res.write(`${JSON.stringify(event)}\n`); });
  const heartbeat = setInterval(() => { if (!res.destroyed) res.write("\n"); }, 20000);
  const close = () => { clearInterval(heartbeat); unsubscribe(); };
  res.once("close", close);
});
