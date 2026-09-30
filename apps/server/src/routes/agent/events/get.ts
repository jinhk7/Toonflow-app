import { Router } from "express";
import { z } from "zod";
import type { AgentEvent } from "@/agent/runtime/types";
import { validateFields } from "@/lib/middleware";
import { error } from "@/lib/responseFormat";
import { subscribeAgentRun, waitForAgentRun } from "@/agent/runtime/runHost";
import { getAgentRun, listRunEvents } from "@/agent/runtime/store";
import u from "@/utils";

export default Router().get("/", validateFields({
  runId: z.uuid(),
  afterSeq: z.coerce.number().int().min(0).optional(),
}, "query"), async (req, res) => {
  const runId = req.query.runId as string;
  const afterSeq = Number(req.query.afterSeq ?? 0);
  const record = getAgentRun(runId);
  if (!record) return res.status(404).json(error("运行不存在", null, 404));
  await u.workspace.resolveWorkspace(record.cwd);
  res.set({ "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-cache", "X-Accel-Buffering": "no" });
  res.flushHeaders();
  let closed = false;
  const send = (event: AgentEvent) => {
    if (!closed && !res.destroyed) res.write(`${JSON.stringify(event)}\n`);
  };
  const unsubscribe = subscribeAgentRun(runId, (event, meta) => {
    send({ ...event, runSeq: meta.seq } as AgentEvent & { runSeq: number });
  }, afterSeq);
  const close = () => {
    closed = true;
    unsubscribe();
  };
  res.once("close", close);
  const latest = listRunEvents(runId, 0).at(-1);
  const latestEvent = latest ? JSON.parse(latest.payload) as AgentEvent : undefined;
  if (latestEvent && (latestEvent.type === "done" || latestEvent.type === "error")) {
    close();
    if (!res.destroyed) res.end();
    return;
  }
  try {
    await waitForAgentRun(runId);
  } catch {
    // 运行错误已在事件流中体现
  } finally {
    close();
    if (!res.destroyed) res.end();
  }
});
