import { Router } from "express";
import { z } from "zod";
import type { CanvasInfo } from "@toonflow/tools-scaffold/runtime";
import type { AgentEvent } from "@/agent/runtime/types";
import { validateFields } from "@/lib/middleware";
import u from "@/utils";
import { startAgentRun, subscribeAgentRun } from "@/agent/runtime/runHost";

const inputSchema = z.object({
  prompt: z.string().trim(), directory: z.string().min(1),
  attachments: u.agent.agentAttachmentsSchema.optional(),
  mentions: u.agent.agentMentionsSchema.optional(),
  providerId: z.string().min(1), modelId: z.string().min(1),
  thinkingLevel: z.enum(["off", "low", "medium", "high"]).optional(),
  sessionFile: z.string().regex(/^[\w-]+\.jsonl$/).optional(),
  resendFrom: z.string().min(1).max(128).optional(),
  canvas: z.strictObject({
    id: z.string().min(1).max(256),
    tools: z.array(z.strictObject({
      nodeId: z.string().min(1).max(256),
      name: z.string().max(101).regex(/^node:[a-z][a-zA-Z0-9]*$/),
      nodeLabel: z.string().max(200).optional(),
      nodeRevision: z.string().regex(/^[a-f0-9]{64}$/).optional(),
      description: z.string().max(4000),
      parameters: z.record(z.string(), z.json()).refine(value => value.type === "object", "函数参数必须是 object JSON Schema"),
    })).max(1000),
  }).optional(),
});

export default Router().post("/", validateFields(inputSchema.shape), async (req, res) => {
  const { directory, canvas, ...options } = req.body as z.infer<typeof inputSchema>;
  const cwd = await u.workspace.resolveWorkspace(directory);
  const sessionPath = options.sessionFile ? (await u.workspaceFile.resolveWorkspaceFile(directory, `.agent/sessions/${options.sessionFile}`)).path : undefined;
  const active = sessionPath ? u.agent.getActiveAgentSession(sessionPath) : undefined;
  // 正在委派执行的子会话继续走 SDK steering，不另建后台运行争抢会话文件。
  const steering = active && u.agent.getParentSessionFile(active.history) && !u.agent.hasPendingAgentQuestion(active);
  const hosted = steering ? undefined : await startAgentRun({ cwd, canvas: canvas as CanvasInfo | undefined, ...options });
  res.set({ "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-cache", "X-Accel-Buffering": "no" });
  res.flushHeaders();
  const send = (event: AgentEvent, seq?: number) => {
    if (event.type === "session") options.sessionFile = event.file;
    if (!res.destroyed) res.write(`${JSON.stringify(seq === undefined ? event : { ...event, runSeq: seq })}\n`);
  };
  if (!hosted) {
    try {
      await u.agent.run({ ...options, cwd }, send);
      send({ type: "done" });
    } catch (error) {
      send({ type: "error", message: error instanceof Error ? error.message : "发送失败" });
    } finally {
      if (!res.destroyed) res.end();
    }
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
