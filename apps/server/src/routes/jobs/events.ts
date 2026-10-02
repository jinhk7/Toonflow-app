import { Router } from "express";
import { z } from "zod";
import type { NodeJobEvent } from "@/utils/jobs";
import { validateFields } from "@/lib/middleware";
import { error } from "@/lib/responseFormat";
import u from "@/utils";

export default Router().get("/", validateFields({
  jobId: z.uuid(), afterSeq: z.coerce.number().int().min(0).optional(),
}, "query"), async (req, res) => {
  await u.jobs.ensureNodeJobsReady();
  const jobId = req.query.jobId as string;
  const job = u.jobs.getNodeJob(jobId);
  if (!job) return res.status(404).json(error("任务不存在", null, 404));
  res.set({ "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-cache", "X-Accel-Buffering": "no" });
  res.flushHeaders();
  let closed = false;
  const controller = new AbortController();
  const send = (event: NodeJobEvent) => {
    if (!closed && !res.destroyed) res.write(`${JSON.stringify(event)}\n`);
  };
  const unsubscribe = u.jobs.subscribeNodeJob(jobId, send, Number(req.query.afterSeq ?? 0));
  const close = () => {
    closed = true;
    unsubscribe();
    controller.abort();
  };
  res.once("close", close);
  try { await u.jobs.waitForNodeJob(jobId, controller.signal); }
  catch { /* 失败与取消已在持久事件中体现；断开只取消本次等待。 */ }
  finally {
    close();
    res.off("close", close);
    if (!res.destroyed) res.end();
  }
});
