import { Router } from "express";
import type { z } from "zod";
import type { AgentEvent } from "@/agent/runtime/types";
import { validateFields } from "@/lib/middleware";
import u from "@/utils";
import { startAgentRun, subscribeAgentRun } from "@/agent/runtime/runHost";
import { agentInputSchema } from "@/agent/runtime/input";

export default Router().post("/", validateFields(agentInputSchema.shape), async (req, res) => {
  const { directory, ...options } = agentInputSchema.parse(req.body) as z.infer<typeof agentInputSchema>;
  const cwd = await u.workspace.resolveWorkspace(directory);
  const hosted = await startAgentRun({ cwd, ...options });
  res.set({ "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-cache", "X-Accel-Buffering": "no" });
  res.flushHeaders();
  const send = (event: AgentEvent, seq?: number) => {
    if (event.type === "session") options.sessionFile = event.file;
    if (!res.destroyed) res.write(`${JSON.stringify(seq === undefined ? event : { ...event, runSeq: seq })}\n`);
  };
  if (hosted.mode === "steer") {
    send({ type: "accepted" });
    if (!res.destroyed) res.end();
    return;
  }
  const unsubscribe = subscribeAgentRun(hosted.runId, (event, meta) => send(event, meta.seq), 0);
  res.once("close", unsubscribe);
  try {
    await hosted.done;
  } catch {
    // 事件流内已发送 error
  } finally {
    res.off("close", unsubscribe);
    unsubscribe();
    if (!res.destroyed) res.end();
  }
});
