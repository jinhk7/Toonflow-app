import type { CanvasInfo } from "@toonflow/tools-scaffold/runtime";
import type { z } from "zod";
import { agentAttachmentsSchema, getActiveAgentSession, hasPendingAgentQuestion, trackAgentEvent } from "@/agent/runtime/sessions";
import { resolveWorkspacePath } from "@/utils/workspace/files";
import type { AgentEvent, AgentMention } from "@/agent/runtime/types";
import { createCanvasContext } from "@/agent/bridge/canvas";
import { createQuestionContext } from "@/agent/bridge/question";
import { registerRunContinuation } from "@/agent/runtime/runContinuation";
import { applyAnsweredQuestionsToSession } from "@/agent/runtime/sessionRecovery";
import {
  appendRunEvent,
  ensureAgentRunStore,
  finishPendingQuestion,
  getActiveRunForSession,
  getAgentRun,
  insertAgentRun,
  listIncompleteRuns,
  listRunEvents,
  listWaitingQuestionsForRun,
  listAuthorizations,
  listPendingAuthorizations,
  listPendingSideEffectReviews,
  hasPendingSideEffectReview,
  recordToolCallFinish,
  updateAgentRun,
  type AgentRunIntent,
  type AgentRunRecord,
} from "@/agent/runtime/store";

export type AgentRunInput = {
  cwd: string;
  prompt: string;
  attachments?: z.infer<typeof agentAttachmentsSchema>;
  mentions?: AgentMention[];
  providerId: string;
  modelId: string;
  thinkingLevel?: "off" | "low" | "medium" | "high";
  sessionFile?: string;
  resendFrom?: string;
  canvas?: CanvasInfo;
};

type RunSubscriber = (event: AgentEvent, meta: { seq: number; runId: string }) => void;

type HostedRun = {
  runId: string;
  cwd: string;
  sessionFile?: string;
  intent: AgentRunIntent;
  subscribers: Set<RunSubscriber>;
  stopGeneration: AbortController;
  runAbort: AbortController;
  bridges: {
    canvas?: ReturnType<typeof createCanvasContext>;
    question?: ReturnType<typeof createQuestionContext>;
  };
  task: Promise<void>;
};

const hostedRuns = new Map<string, HostedRun>();
let runtimeReady = false;

function publishPlaceholder(runId: string, event: AgentEvent) {
  const run = hostedRuns.get(runId);
  if (run) publish(run, event);
  else appendRunEvent(runId, event);
}

function publish(run: HostedRun, event: AgentEvent) {
  const { seq } = appendRunEvent(run.runId, event);
  if (event.type === "session") {
    run.sessionFile = event.file;
    updateAgentRun(run.runId, { sessionFile: event.file });
  }
  trackAgentEvent(run.cwd, run.sessionFile, event);
  for (const subscriber of run.subscribers) subscriber(event, { seq, runId: run.runId });
}

export async function ensureAgentRuntimeReady() {
  if (runtimeReady) return;
  await ensureAgentRunStore();
  for (const record of listIncompleteRuns()) reconcileRecoveredRun(record);
  runtimeReady = true;
}

function reconcileRecoveredRun(record: AgentRunRecord) {
  if (hostedRuns.has(record.runId)) return;
  const waiting = listWaitingQuestionsForRun(record.runId);
  if (waiting.length) {
    updateAgentRun(record.runId, { status: "waitingApproval" });
    return;
  }
  if (["preparing", "running", "terminating"].includes(record.status)) {
    const interrupted = reviewInterruptedToolCalls(record.runId);
    updateAgentRun(record.runId, {
      status: interrupted.length ? "needsReview" : "paused",
      errorMessage: interrupted.length ? "服务重启后存在未核对的副作用步骤，请逐项核对后继续" : "服务重启，已暂停运行，请手动继续",
    });
  }
}

function buildRunControl(run: HostedRun) {
  const signal = AbortSignal.any([run.stopGeneration.signal, run.runAbort.signal]);
  return {
    signal,
    shouldPauseBeforeStep() {
      return getAgentRun(run.runId)?.intent === "pause";
    },
    shouldTerminate() {
      return getAgentRun(run.runId)?.intent === "terminate";
    },
  };
}

async function executeHostedRun(hostedRun: HostedRun, input: AgentRunInput) {
  const send = (event: AgentEvent) => {
    if (event.type === "session") updateAgentRun(hostedRun.runId, { sessionFile: event.file });
    publish(hostedRun, event);
  };
  const runControl = buildRunControl(hostedRun);
  updateAgentRun(hostedRun.runId, { status: "running" });
  try {
    if (runControl.shouldTerminate()) throw Object.assign(new Error("本次流程已终止"), { status: 409 });
    const { run: runAgent } = await import("@/agent/runtime/index");
    await runAgent({
      ...input,
      canvas: hostedRun.bridges.canvas?.context,
      question: hostedRun.bridges.question?.context,
      signal: runControl.signal,
      onCancel: () => { hostedRun.runAbort.abort(); hostedRun.bridges.canvas?.dispose(); hostedRun.bridges.question?.dispose(); },
      runId: hostedRun.runId,
      runControl,
      canvasAttached: Boolean(hostedRun.bridges.canvas),
    }, send);
    const status = runControl.shouldTerminate() ? "completed" : runControl.shouldPauseBeforeStep() || runControl.signal.aborted ? "paused" : "completed";
    updateAgentRun(hostedRun.runId, { status });
    send({ type: "done" });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Agent 运行失败";
    const code = (error as { code?: string }).code;
    const current = getAgentRun(hostedRun.runId);
    const status = current?.intent === "terminate"
      ? "completed"
      : code === "AGENT_PAUSED" || current?.intent === "pause"
        ? "paused"
        : runControl.signal.aborted
          ? "paused"
          : "error";
    updateAgentRun(hostedRun.runId, { status, errorMessage: message });
    send({ type: "error", message });
  } finally {
    hostedRun.bridges.canvas?.dispose();
    hostedRun.bridges.question?.dispose();
    hostedRuns.delete(hostedRun.runId);
  }
}


function hostAgentRun(runId: string, input: AgentRunInput) {
  const stopGeneration = new AbortController();
  const runAbort = new AbortController();
  const bridges = {
    canvas: input.canvas ? createCanvasContext(input.cwd, input.canvas, event => publishPlaceholder(runId, event), { runId }) : undefined,
    question: createQuestionContext(input.cwd, event => publishPlaceholder(runId, event), () => stopGeneration.abort(), { runId }),
  };
  const hosted: HostedRun = {
    runId,
    cwd: input.cwd,
    sessionFile: input.sessionFile,
    intent: "active",
    subscribers: new Set(),
    stopGeneration,
    runAbort,
    bridges,
    task: Promise.resolve(),
  };
  hostedRuns.set(runId, hosted);
  updateAgentRun(runId, { status: "preparing", intent: "active", errorMessage: undefined });
  publish(hosted, { type: "run", runId, sessionFile: input.sessionFile });
  hosted.task = executeHostedRun(hosted, input);
  return hosted;
}

export async function continueAgentRun(runId: string, canvas?: CanvasInfo) {
  const record = getAgentRun(runId);
  if (!record) throw Object.assign(new Error("运行不存在"), { status: 404 });
  if (hostedRuns.has(runId)) throw Object.assign(new Error("运行仍在执行中"), { status: 409 });
  if (hasPendingSideEffectReview(runId)) {
    throw Object.assign(new Error("请先核对未完成的运行步骤"), { status: 409 });
  }
  const waiting = listWaitingQuestionsForRun(runId);
  if (waiting.length) {
    throw Object.assign(new Error("仍有待确认问题，请先作答"), { status: 409 });
  }
  if (!["paused", "error", "needsReview", "waitingApproval"].includes(record.status)) {
    throw Object.assign(new Error("当前状态无法继续运行"), { status: 409 });
  }
  if (!record.sessionFile) throw Object.assign(new Error("缺少会话信息，请发送新消息继续"), { status: 409 });
  await applyAnsweredQuestionsToSession(record.cwd, record.sessionFile, runId);
  const input: AgentRunInput = {
    cwd: record.cwd,
    prompt: "请从上次暂停处继续未完成的步骤。",
    sessionFile: record.sessionFile,
    providerId: record.providerId,
    modelId: record.modelId,
    thinkingLevel: (record.thinkingLevel as AgentRunInput["thinkingLevel"]) ?? "off",
    canvas,
  };
  await ensureAgentRuntimeReady();
  hostAgentRun(runId, input);
  return getAgentRun(runId)!;
}


export async function startAgentRun(input: AgentRunInput) {
  await ensureAgentRuntimeReady();
  if (input.sessionFile) {
    const active = getActiveRunForSession(input.cwd, input.sessionFile);
    if (active) {
      const hosted = hostedRuns.get(active.runId);
      if (hosted) {
        const { path } = await resolveWorkspacePath(input.cwd, `.agent/sessions/${input.sessionFile}`);
        const session = getActiveAgentSession(path);
        if (!session || !hasPendingAgentQuestion(session)) {
          throw Object.assign(new Error("该对话已有后台运行中的任务"), { status: 409, runId: active.runId });
        }
        // 新消息替代旧提问时先释放原会话及运行，页面断开仍不影响后台任务。
        await session.abort();
        await hosted.task;
      }
      for (const question of listWaitingQuestionsForRun(active.runId)) finishPendingQuestion(question.callId, "cancelled");
      updateAgentRun(active.runId, { status: "completed", intent: "terminate" });
    }
  }
  const runId = crypto.randomUUID();
  insertAgentRun({
    runId,
    cwd: input.cwd,
    sessionFile: input.sessionFile ?? null,
    status: "preparing",
    intent: "active",
    providerId: input.providerId,
    modelId: input.modelId,
    thinkingLevel: input.thinkingLevel ?? "off",
    inputJson: JSON.stringify({ prompt: input.prompt, resendFrom: input.resendFrom, hasCanvas: Boolean(input.canvas) }),
  });
  const hosted = hostAgentRun(runId, input);
  return { runId, done: hosted.task };
}

export function subscribeAgentRun(runId: string, subscriber: RunSubscriber, afterSeq = 0) {
  const run = hostedRuns.get(runId);
  const record = getAgentRun(runId);
  if (!record) throw Object.assign(new Error("运行不存在"), { status: 404 });
  for (const item of listRunEvents(runId, afterSeq)) {
    subscriber(JSON.parse(item.payload) as AgentEvent, { seq: item.seq, runId });
  }
  if (!run) return () => {};
  run.subscribers.add(subscriber);
  return () => { run.subscribers.delete(subscriber); };
}

export function stopAgentGeneration(runId: string) {
  const run = hostedRuns.get(runId);
  if (!run) throw Object.assign(new Error("运行不存在或已结束"), { status: 404 });
  run.stopGeneration.abort();
  run.stopGeneration = new AbortController();
}

export async function controlAgentRun(runId: string, action: "pause" | "resume" | "terminate", options?: { canvas?: CanvasInfo }) {
  const run = hostedRuns.get(runId);
  const record = getAgentRun(runId);
  if (!record) throw Object.assign(new Error("运行不存在"), { status: 404 });
  if (action === "pause") {
    if (!run) throw Object.assign(new Error("运行未在执行，无需暂停"), { status: 409 });
    updateAgentRun(runId, { intent: "pause", status: "paused" });
    return getAgentRun(runId)!;
  }
  if (action === "resume") {
    const waiting = listWaitingQuestionsForRun(runId);
    if (run) {
      updateAgentRun(runId, {
        intent: "active",
        status: waiting.length ? "waitingApproval" : "running",
      });
      return getAgentRun(runId)!;
    }
    if (waiting.length) {
      updateAgentRun(runId, { intent: "active", status: "waitingApproval" });
      return getAgentRun(runId)!;
    }
    if (record.status === "waitingApproval") {
      await applyAnsweredQuestionsToSession(record.cwd, record.sessionFile!, runId);
    }
    if (["paused", "error", "needsReview", "waitingApproval"].includes(record.status)) {
      return await continueAgentRun(runId, options?.canvas);
    }
    throw Object.assign(new Error("当前状态无法继续运行"), { status: 409 });
  }
  if (!run) {
    if (record.status === "completed") throw Object.assign(new Error("运行已结束"), { status: 409 });
    for (const question of listWaitingQuestionsForRun(runId)) finishPendingQuestion(question.callId, "cancelled");
    updateAgentRun(runId, { intent: "terminate", status: "completed", errorMessage: "本次流程已终止" });
    return getAgentRun(runId)!;
  }
  updateAgentRun(runId, { intent: "terminate", status: "terminating" });
  run.stopGeneration.abort();
  run.runAbort.abort();
  return getAgentRun(runId)!;
}

export function waitForAgentRun(runId: string) {
  return hostedRuns.get(runId)?.task ?? Promise.resolve();
}

export function getAgentRunSnapshot(runId: string) {
  const record = getAgentRun(runId);
  if (!record) return undefined;
  return {
    ...record,
    live: hostedRuns.has(runId),
    waitingQuestions: listWaitingQuestionsForRun(runId),
    authorizations: listAuthorizations(runId),
    pendingAuthorizations: listPendingAuthorizations(runId),
    reviewCalls: listPendingSideEffectReviews(runId),
  };
}

export function reviewInterruptedToolCalls(runId: string) {
  if (!getAgentRun(runId)) return [];
  const pending = listPendingSideEffectReviews(runId);
  if (!hostedRuns.has(runId)) {
    for (const item of pending) if (item.status === "started") recordToolCallFinish(item.toolCallId, "needsReview");
  }
  const reviews = listPendingSideEffectReviews(runId);
  if (reviews.length && !hostedRuns.has(runId)) updateAgentRun(runId, { status: "needsReview" });
  return reviews;
}

registerRunContinuation({
  continueAgentRun: (id, canvas) => continueAgentRun(id, canvas),
  isRunHosted: id => hostedRuns.has(id),
});
