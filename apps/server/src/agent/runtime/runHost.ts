import type { CanvasInfo, CanvasContext } from "@toonflow/tools-scaffold/runtime";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { copyFile, mkdir, readFile, stat, unlink } from "node:fs/promises";
import { extname } from "node:path";
import { parseSessionEntries } from "@earendil-works/pi-coding-agent";
import type { z } from "zod";
import { agentAttachmentsSchema, createAgentConversation, getActiveAgentSession, getParentSessionFile, hasPendingAgentQuestion, trackAgentEvent } from "@/agent/runtime/sessions";
import { lockWorkspaceFiles, resolveWorkspacePath } from "@/utils/workspace/files";
import type { AgentEvent, AgentMention } from "@/agent/runtime/types";
import { createBackendCanvasContext } from "@/utils/canvas/context";
import { agentMentionsSchema, snapshotMentions, validateMentionTokens } from "@/agent/runtime/mentions";
import type { AgentCanvasTarget } from "@/agent/runtime/input";
import { getAgentModelRevision } from "@/agent/runtime/model";
import { createQuestionContext } from "@/agent/bridge/question";
import { registerRunContinuation } from "@/agent/runtime/runContinuation";
import { applyAnsweredQuestionsToSession, restoreUndeliveredAgentInputs } from "@/agent/runtime/sessionRecovery";
import {
  appendRunEvent,
  ensureAgentRunStore,
  finishPendingQuestion,
  getActiveRunForSession,
  getAgentRun,
  getAgentAcceptance,
  getLatestRunForSession,
  insertAgentAcceptance,
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
  type AgentAcceptanceRecord,
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
  canvas?: AgentCanvasTarget;
  clientId?: string;
  clientMessageId?: string;
  inputPrepared?: boolean;
  modelRevision?: string;
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
    canvas?: CanvasContext;
    question?: ReturnType<typeof createQuestionContext>;
  };
  task: Promise<void>;
};

const hostedRuns = new Map<string, HostedRun>();
let runtimeReady = false;
let runtimeStarting: Promise<void> | undefined;

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
  for (const subscriber of run.subscribers) {
    try { subscriber(event, { seq, runId: run.runId }); }
    catch { run.subscribers.delete(subscriber); }
  }
}

export async function ensureAgentRuntimeReady() {
  if (runtimeReady) return;
  if (!runtimeStarting) runtimeStarting = (async () => {
    await ensureAgentRunStore();
    for (const record of listIncompleteRuns()) reconcileRecoveredRun(record);
    runtimeReady = true;
  })().finally(() => { runtimeStarting = undefined; });
  await runtimeStarting;
}

function reconcileRecoveredRun(record: AgentRunRecord) {
  if (hostedRuns.has(record.runId)) return;
  const waiting = listWaitingQuestionsForRun(record.runId);
  const source = (JSON.parse(record.inputJson) as { source?: string }).source;
  if (source === "a2a") {
    reviewInterruptedToolCalls(record.runId);
    for (const question of waiting) finishPendingQuestion(question.callId, "cancelled");
    updateAgentRun(record.runId, { status: "needsReview", errorMessage: "服务重启后 A2A 协议上下文已释放；请核对原运行结果后新建任务" });
    return;
  }
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
      canvas: hostedRun.bridges.canvas,
      question: hostedRun.bridges.question?.context,
      signal: runControl.signal,
      onCancel: () => { hostedRun.runAbort.abort(); hostedRun.bridges.question?.dispose(); },
      runId: hostedRun.runId,
      runControl,
      canvasAttached: Boolean(hostedRun.bridges.canvas),
    }, send);
    const status = runControl.shouldTerminate() ? "completed"
      : hasPendingSideEffectReview(hostedRun.runId) ? "needsReview"
        : listPendingAuthorizations(hostedRun.runId).length || runControl.shouldPauseBeforeStep() || runControl.signal.aborted ? "paused" : "completed";
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
    hostedRun.bridges.question?.dispose();
    hostedRuns.delete(hostedRun.runId);
  }
}


async function hostAgentRun(runId: string, input: AgentRunInput) {
  const stopGeneration = new AbortController();
  const runAbort = new AbortController();
  const hosted: HostedRun = {
    runId,
    cwd: input.cwd,
    sessionFile: input.sessionFile,
    intent: "active",
    subscribers: new Set(),
    stopGeneration,
    runAbort,
    bridges: {},
    task: Promise.resolve(),
  };
  hostedRuns.set(runId, hosted);
  // 受理事务已提交；启动和会话持久化错误记录到运行，不能撤销已受理收据。
  hosted.task = Promise.resolve().then(async () => {
    try {
      updateAgentRun(runId, { status: "preparing", intent: "active", errorMessage: undefined });
      publish(hosted, { type: "run", runId, sessionFile: input.sessionFile });
      const backendCanvas = await createBackendCanvasContext(input.cwd, input.canvas, {
        runId, clientId: input.clientId,
        onTargetChanged: canvasPath => persistRunCanvasTarget(runId, canvasPath),
      });
      hosted.bridges.canvas = backendCanvas;
      persistRunCanvasTarget(runId, backendCanvas.canvasPath);
      hosted.bridges.question = createQuestionContext(input.cwd, event => publishPlaceholder(runId, event), () => stopGeneration.abort(), { runId, sessionFile: input.sessionFile });
      await executeHostedRun(hosted, input);
    } catch (error) {
      try {
        updateAgentRun(runId, { status: "error", errorMessage: error instanceof Error ? error.message : "后台准备失败" });
        publish(hosted, { type: "error", message: error instanceof Error ? error.message : "后台准备失败" });
      } catch (recordError) { console.error("后台运行错误暂时无法入账", recordError); }
      finally {
        hosted.bridges.question?.dispose();
        hostedRuns.delete(runId);
      }
    }
  });
  return hosted;
}

function persistRunCanvasTarget(runId: string, canvasPath: string) {
  const record = getAgentRun(runId);
  if (!record) return;
  const input = JSON.parse(record.inputJson) as AgentRunInput;
  const previous = input.canvas?.canvasPath ?? input.canvas?.id;
  input.canvas = canvasPath ? { canvasPath, selectedNodeIds: previous && previous !== canvasPath ? [] : input.canvas?.selectedNodeIds ?? [] } : undefined;
  updateAgentRun(runId, { inputJson: JSON.stringify(input) });
}

export async function continueAgentRun(runId: string, canvas?: CanvasInfo) {
  await ensureAgentRuntimeReady();
  const record = getAgentRun(runId);
  if (!record) throw Object.assign(new Error("运行不存在"), { status: 404 });
  return withAcceptanceLock(JSON.stringify([record.cwd, record.sessionFile ?? runId, "session"]), () => continuePreparedAgentRun(runId, canvas));
}

async function continuePreparedAgentRun(runId: string, canvas?: CanvasInfo) {
  const record = getAgentRun(runId);
  if (!record) throw Object.assign(new Error("运行不存在"), { status: 404 });
  if (hostedRuns.has(runId)) throw Object.assign(new Error("运行仍在执行中"), { status: 409 });
  if ((JSON.parse(record.inputJson) as { source?: string }).source === "a2a") {
    throw Object.assign(new Error("A2A 协议上下文不能通过本地会话继续；请核对结果后通过原入口补充输入或新建任务"), { status: 409 });
  }
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
  await restoreUndeliveredAgentInputs(runId);
  const saved = JSON.parse(record.inputJson) as Partial<AgentRunInput>;
  const { path } = await resolveWorkspacePath(record.cwd, `.agent/sessions/${record.sessionFile}`);
  const entries = parseSessionEntries(await readFile(path, "utf8"));
  const delivered = !saved.clientMessageId || entries.some(entry => entry.type === "custom" && entry.customType === "toonflowUserMessage"
    && (entry.data as { clientMessageId?: string } | undefined)?.clientMessageId === saved.clientMessageId);
  const input: AgentRunInput = {
    ...saved,
    cwd: record.cwd,
    prompt: delivered ? "请从上次暂停处继续未完成的步骤。" : saved.prompt ?? "请从上次暂停处继续未完成的步骤。",
    attachments: delivered ? [] : saved.attachments,
    mentions: delivered ? [] : saved.mentions,
    resendFrom: delivered ? undefined : saved.resendFrom,
    clientMessageId: delivered ? undefined : saved.clientMessageId,
    sessionFile: record.sessionFile,
    providerId: record.providerId,
    modelId: record.modelId,
    thinkingLevel: (record.thinkingLevel as AgentRunInput["thinkingLevel"]) ?? "off",
    canvas: saved.canvas ?? (canvas ? { id: canvas.id } : undefined),
  };
  await ensureAgentRuntimeReady();
  await hostAgentRun(runId, input);
  return getAgentRun(runId)!;
}


const acceptanceLocks = new Map<string, Promise<void>>();

async function withAcceptanceLock<T>(key: string, action: () => Promise<T>) {
  const previous = acceptanceLocks.get(key);
  const release = Promise.withResolvers<void>();
  acceptanceLocks.set(key, release.promise);
  try {
    await previous;
    return await action();
  } finally {
    release.resolve();
    if (acceptanceLocks.get(key) === release.promise) acceptanceLocks.delete(key);
  }
}

function requestDigest(input: AgentRunInput) {
  const stable = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(stable);
    if (!value || typeof value !== "object") return value;
    return Object.fromEntries(Object.entries(value).filter(([, value]) => value !== undefined).sort(([left], [right]) => left.localeCompare(right))
      .map(([key, value]) => [key, stable(value)]));
  };
  return createHash("sha256").update(JSON.stringify(stable({ ...input, clientMessageId: undefined, inputPrepared: undefined }))).digest("hex");
}

async function snapshotAttachments(cwd: string, attachments: NonNullable<AgentRunInput["attachments"]>, created: string[]) {
  const result: NonNullable<AgentRunInput["attachments"]> = [];
  for (const attachment of attachments) {
    const source = await resolveWorkspacePath(cwd, attachment.path);
    const info = await stat(source.path);
    if (!info.isFile() || !info.size || info.size > 100 * 1024 * 1024) {
      throw Object.assign(new Error("附件必须是工作区内非空且不超过 100 MB 的文件"), { status: 400 });
    }
    const extension = extname(source.path);
    const path = `assets/chat/${crypto.randomUUID()}${/^\.[a-zA-Z0-9]{1,16}$/.test(extension) ? extension.toLowerCase() : ""}`;
    const folder = await resolveWorkspacePath(cwd, "assets/chat", true);
    const target = await resolveWorkspacePath(cwd, path, true);
    const release = lockWorkspaceFiles([source.path, target.path]);
    try {
      await mkdir(folder.path, { recursive: true });
      await copyFile(source.path, target.path, constants.COPYFILE_EXCL);
      created.push(target.path);
      const copied = await stat(target.path);
      if (!copied.isFile() || !copied.size || copied.size > 100 * 1024 * 1024) throw Object.assign(new Error("附件复制后为空或超过 100 MB"), { status: 400 });
    } finally { release(); }
    result.push({ ...attachment, path });
  }
  return result;
}

function acceptanceSnapshot(record: AgentAcceptanceRecord) {
  const run = getAgentRun(record.runId);
  return {
    clientMessageId: record.clientMessageId,
    runId: record.runId,
    sessionFile: record.sessionFile,
    mode: record.mode,
    delivered: Boolean(record.messageId),
    status: run?.status,
    lastEventSeq: run?.lastEventSeq ?? 0,
    createdAt: record.createdAt,
  };
}

export function getAgentAcceptanceSnapshot(cwd: string, clientMessageId: string) {
  const record = getAgentAcceptance(cwd, clientMessageId);
  return record ? acceptanceSnapshot(record) : undefined;
}

function getParentRun(cwd: string, sessionFile: string) {
  const visited = new Set<string>();
  let file: string | undefined = sessionFile;
  while (file && !visited.has(file)) {
    visited.add(file);
    const record = getLatestRunForSession(cwd, file);
    if (record && hostedRuns.has(record.runId)) return record;
    const active = getActiveAgentSession(`${cwd}/.agent/sessions/${file}`);
    file = active ? getParentSessionFile(active.history) : undefined;
  }
}

export async function acceptAgentRun(input: AgentRunInput & { clientMessageId: string }) {
  await ensureAgentRuntimeReady();
  input = {
    ...input,
    prompt: input.prompt.trim(),
    attachments: agentAttachmentsSchema.parse(input.attachments ?? []),
    mentions: agentMentionsSchema.parse(input.mentions ?? []),
    thinkingLevel: input.thinkingLevel ?? "off",
    canvas: input.canvas ? { id: input.canvas.id, canvasPath: input.canvas.canvasPath, selectedNodeIds: input.canvas.selectedNodeIds ?? [] } : undefined,
  };
  const requestHash = requestDigest(input);
  return withAcceptanceLock(JSON.stringify([input.cwd, input.clientMessageId]), async () => {
    const existing = getAgentAcceptance(input.cwd, input.clientMessageId);
    if (existing) {
      if (existing.requestHash !== requestHash) throw Object.assign(new Error("消息标识对应的输入已变化"), { status: 409 });
      return { ...acceptanceSnapshot(existing), duplicate: true };
    }
    return withAcceptanceLock(JSON.stringify([input.cwd, input.sessionFile ?? input.clientMessageId, "session"]), async () => {
      validateMentionTokens(input.prompt, input.mentions ?? []);
      if (!input.prompt && !input.attachments?.length && !input.mentions?.length) throw Object.assign(new Error("请输入消息、提及或添加图片、视频"), { status: 400 });
      if (input.resendFrom && !input.sessionFile) throw Object.assign(new Error("重发需要指定原对话"), { status: 400 });
      const modelRevision = getAgentModelRevision(input.providerId, input.modelId);
      const sessionPath = input.sessionFile ? (await resolveWorkspacePath(input.cwd, `.agent/sessions/${input.sessionFile}`)).path : undefined;
      if (sessionPath) {
        const info = await stat(sessionPath).catch((error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") throw Object.assign(new Error("会话不存在，请重新打开对话"), { status: 404 });
          throw error;
        });
        if (!info.isFile()) throw Object.assign(new Error("会话必须是普通文件"), { status: 400 });
      }
      const session = sessionPath ? getActiveAgentSession(sessionPath) : undefined;
      if (session && getParentSessionFile(session.history) && !hasPendingAgentQuestion(session)) {
        if (input.resendFrom || input.attachments?.length || input.mentions?.length) throw Object.assign(new Error("请等子 Agent 当前回复结束后发送附件、提及或重发"), { status: 409 });
        if (!session.session?.isStreaming) throw Object.assign(new Error("子 Agent 正在准备或结束回复，请稍后发送"), { status: 409 });
        const parent = getParentRun(input.cwd, input.sessionFile!);
        if (!parent) throw Object.assign(new Error("子会话缺少后台运行，请等待当前任务结束"), { status: 409 });
        const accepted = insertAgentAcceptance({ cwd: input.cwd, clientMessageId: input.clientMessageId, requestHash,
          runId: parent.runId, sessionFile: input.sessionFile!, mode: "steer", inputJson: JSON.stringify(input) });
        try {
          await session.session.prompt(input.prompt, { streamingBehavior: "steer", expandPromptTemplates: false });
          publishPlaceholder(parent.runId, { type: "accepted" });
        } catch (error) {
          // 完整输入已经受理，投递失败保留未投递记录供会话恢复核对。
          try { publishPlaceholder(parent.runId, { type: "error", message: error instanceof Error ? error.message : "已受理消息暂时无法投递" }); }
          catch (recordError) { console.error("已受理消息投递失败暂时无法入账", recordError); }
        }
        return { ...acceptanceSnapshot(accepted), duplicate: false };
      }
      await releasePreviousSessionRun(input);
      const created: string[] = [];
      let accepted = false;
      try {
        const attachments = await snapshotAttachments(input.cwd, input.attachments ?? [], created);
        const mentions = await snapshotMentions(input.cwd, input.mentions ?? []);
        created.push(...mentions.created);
        const sessionFile = input.sessionFile ?? (await createAgentConversation(input.cwd)).file;
        const entries = sessionPath ? parseSessionEntries(await readFile(sessionPath, "utf8")) : [];
        const previousTarget = entries.findLast(entry => entry.type === "custom" && entry.customType === "toonflowCanvasTarget");
        const target = previousTarget?.type === "custom" ? previousTarget.data as { canvasPath?: string } : undefined;
        const prepared: AgentRunInput = { ...input, sessionFile, attachments, mentions: mentions.mentions, inputPrepared: true, modelRevision,
          canvas: input.canvas ?? (target?.canvasPath ? { canvasPath: target.canvasPath } : undefined) };
        const runId = crypto.randomUUID();
        const inputJson = JSON.stringify(prepared);
        const receipt = insertAgentAcceptance({ cwd: input.cwd, clientMessageId: input.clientMessageId, requestHash,
          runId, sessionFile, mode: "run", inputJson }, {
          runId, cwd: input.cwd, sessionFile, status: "preparing", intent: "active", providerId: input.providerId,
          modelId: input.modelId, thinkingLevel: input.thinkingLevel ?? "off", inputJson,
        });
        accepted = true;
        await hostAgentRun(runId, prepared);
        return { ...acceptanceSnapshot(receipt), duplicate: false };
      } finally {
        if (!accepted) await Promise.all(created.map(path => unlink(path)));
      }
    });
  });
}

async function releasePreviousSessionRun(input: AgentRunInput) {
  if (input.sessionFile) {
    const active = getActiveRunForSession(input.cwd, input.sessionFile);
    if (active) {
      if (hasPendingSideEffectReview(active.runId)) throw Object.assign(new Error("请先核对该对话未完成的副作用步骤"), { status: 409, runId: active.runId });
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
        if (hasPendingSideEffectReview(active.runId)) throw Object.assign(new Error("请先核对该对话未完成的副作用步骤"), { status: 409, runId: active.runId });
      }
      for (const question of listWaitingQuestionsForRun(active.runId)) finishPendingQuestion(question.callId, "cancelled");
      updateAgentRun(active.runId, { status: "completed", intent: "terminate" });
    }
  }
}

export async function startAgentRun(input: AgentRunInput) {
  const accepted = await acceptAgentRun({ ...input, clientMessageId: input.clientMessageId ?? crypto.randomUUID() });
  return { ...accepted, done: waitForAgentRun(accepted.runId) };
}

// A2A SDK 持有任务协议上下文；实际执行、控制和副作用记录仍进入同一个后台宿主。
export async function runPersistentAgentTask<T>(runId: string, execute: (send: (event: AgentEvent) => void, control: ReturnType<typeof buildRunControl>) => Promise<T>) {
  await ensureAgentRuntimeReady();
  const record = getAgentRun(runId);
  if (!record) throw Object.assign(new Error("运行不存在"), { status: 404 });
  if (hostedRuns.has(runId)) throw Object.assign(new Error("运行仍在执行"), { status: 409 });
  if (record.intent === "terminate" || record.status === "completed") throw Object.assign(new Error("运行已结束"), { status: 409 });
  const hosted: HostedRun = { runId, cwd: record.cwd, sessionFile: record.sessionFile ?? undefined, intent: "active",
    subscribers: new Set(), stopGeneration: new AbortController(), runAbort: new AbortController(), bridges: {}, task: Promise.resolve() };
  hostedRuns.set(runId, hosted);
  updateAgentRun(runId, { status: "running", intent: "active", errorMessage: undefined });
  publish(hosted, { type: "run", runId });
  const result = (async () => {
    try {
      const output = await execute(event => publish(hosted, event), buildRunControl(hosted));
      const current = getAgentRun(runId)!;
      const status = current.intent === "terminate" ? "completed" : hasPendingSideEffectReview(runId) ? "needsReview"
        : current.status === "paused" || listPendingAuthorizations(runId).length ? "paused" : "completed";
      updateAgentRun(runId, { status });
      publish(hosted, { type: "done" });
      return output;
    } catch (error) {
      const current = getAgentRun(runId)!;
      updateAgentRun(runId, { status: current.intent === "terminate" ? "completed" : hasPendingSideEffectReview(runId) ? "needsReview" : current.intent === "pause" ? "paused" : "error",
        errorMessage: error instanceof Error ? error.message : "后台任务失败" });
      publish(hosted, { type: "error", message: error instanceof Error ? error.message : "后台任务失败" });
      throw error;
    } finally { hostedRuns.delete(runId); }
  })();
  hosted.task = result.then(() => {}, () => {});
  return result;
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
