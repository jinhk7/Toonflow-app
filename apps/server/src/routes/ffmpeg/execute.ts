import { Router } from "express";
import { z } from "zod";
import { validateFields } from "@/lib/middleware";
import { success } from "@/lib/responseFormat";
import u from "@/utils";
import "@/utils/jobs/ffmpeg";

const callSchema = z.object({
  method: z.string().min(1).max(64), args: z.array(z.json()).max(128),
  undefinedArgs: z.array(z.number().int().min(0).max(127)).max(128).optional(),
}).strict();
const inputSchema = z.object({
  requestId: z.uuid(),
  directory: z.string().min(1).max(4096),
  options: z.object({
    source: z.string().min(1).max(4096).optional(),
    cwd: z.string().min(1).max(4096).optional(),
    niceness: z.number().int().min(-20).max(20).optional(),
    priority: z.number().int().min(-20).max(20).optional(),
    stdoutLines: z.number().int().nonnegative().optional(),
    timeout: z.number().nonnegative().optional(),
  }).strict(),
  calls: z.array(callSchema).max(2048),
  operation: callSchema,
  wait: z.boolean().optional(),
});

export default Router().post("/", validateFields(inputSchema.shape), async (req, res) => {
  const { wait, ...input } = inputSchema.parse(req.body);
  const cwd = await u.workspace.resolveWorkspace(input.directory);
  await u.jobs.ensureNodeJobsReady();
  if (input.operation.method === "cancel") {
    const job = u.jobs.getNodeJobForCommand(cwd, input.requestId, "ffmpeg");
    res.json(success(job ? u.jobs.cancelNodeJob(job.jobId) : null));
    return;
  }
  if (input.operation.method === "prepare") {
    await u.ffmpeg.createWorkspaceFfmpeg(cwd);
    res.json(success());
    return;
  }
  const job = await u.jobs.acceptNodeJob({ directory: cwd, commandId: input.requestId, request: {
    kind: "ffmpeg", input: { ...input, directory: cwd } as unknown as Record<string, unknown>,
  } });
  res.status(202);
  if (wait === false) {
    res.json(success(job));
    return;
  }
  // 兼容现有 fluent 浏览器消费者；SSE 仅观察持久任务，不持有执行取消权。
  res.set({ "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no" });
  res.flushHeaders();
  let closed = false;
  let terminalSent = false;
  let successfulEvent: Record<string, unknown> | undefined;
  const controller = new AbortController();
  const send = (event: Record<string, unknown>, terminal = false) => {
    if (closed || res.destroyed || terminalSent) return;
    res.write(`data: ${JSON.stringify(event)}\n\n`);
    if (terminal) terminalSent = true;
  };
  const unsubscribe = u.jobs.subscribeNodeJob(job.jobId, event => {
    if (closed || res.destroyed) return;
    if (event.type === "ffmpeg") {
      const name = event.payload.event;
      if (name === "end" || name === "result") {
        successfulEvent = event.payload;
        if (u.jobs.getNodeJob(job.jobId)?.status === "completed") send(successfulEvent, true);
      } else send(event.payload, name === "error");
    }
    else if (event.type === "jobChanged") {
      const changed = event.payload.job as { status: string; errorMessage?: string };
      // 历史 end/result 可能早于完成账本提交；needsReview 不得被旧成功事件覆盖。
      if (changed.status === "completed" && successfulEvent) send(successfulEvent, true);
      else if (["failed", "cancelled", "needsReview"].includes(changed.status))
        send({ event: "error", args: [{ message: changed.errorMessage ?? "FFmpeg 任务未完成" }] }, true);
    }
  });
  const close = () => {
    closed = true;
    unsubscribe();
    controller.abort();
  };
  res.once("close", close);
  const heartbeat = setInterval(() => { if (!closed && !res.destroyed) res.write(": keepalive\n\n"); }, 1000);
  try {
    await u.jobs.waitForNodeJob(job.jobId, controller.signal);
  } catch {
    // 作业失败已发送持久错误事件；HTTP 断开仅停止等待。
  } finally {
    close();
    clearInterval(heartbeat);
    res.off("close", close);
    if (!res.destroyed) res.end();
  }
});
