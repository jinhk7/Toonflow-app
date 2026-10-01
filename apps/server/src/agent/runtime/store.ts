import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import conf from "@/utils/conf";
import type { AgentEvent } from "@/agent/runtime/types";
import type { QuestionAnswer, QuestionRequest } from "@toonflow/tools-scaffold/runtime";
import { classifyToolExecutionMode } from "@/agent/runtime/toolExecution";
import { isBuiltinNodeTool, type NodeToolContext } from "@/utils/plugins/nodes";

export type AgentRunStatus =
  | "preparing"
  | "running"
  | "waitingApproval"
  | "paused"
  | "terminating"
  | "completed"
  | "error"
  | "needsReview";

export type AgentRunIntent = "active" | "pause" | "terminate";

export type AgentRunRecord = {
  runId: string;
  cwd: string;
  sessionFile: string | null;
  status: AgentRunStatus;
  intent: AgentRunIntent;
  providerId: string;
  modelId: string;
  thinkingLevel: string;
  inputJson: string;
  createdAt: string;
  updatedAt: string;
  lastEventSeq: number;
  errorMessage?: string;
};

export type PendingQuestionRecord = {
  callId: string;
  runId: string;
  cwd: string;
  toolCallId: string;
  request: QuestionRequest;
  status: "waiting" | "answered" | "cancelled";
  answer?: QuestionAnswer;
  createdAt: string;
};

let database: Database | undefined;

function dbPath() {
  return resolve(dirname(conf.path), "agentRuns.sqlite");
}

export function getAgentRunDatabase() {
  if (database) return database;
  database = new Database(dbPath(), { create: true });
  database.exec("PRAGMA journal_mode = WAL;");
  database.exec(`
    CREATE TABLE IF NOT EXISTS agent_runs (
      runId TEXT PRIMARY KEY,
      cwd TEXT NOT NULL,
      sessionFile TEXT,
      status TEXT NOT NULL,
      intent TEXT NOT NULL DEFAULT 'active',
      providerId TEXT NOT NULL,
      modelId TEXT NOT NULL,
      thinkingLevel TEXT NOT NULL,
      inputJson TEXT NOT NULL,
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL,
      lastEventSeq INTEGER NOT NULL DEFAULT 0,
      errorMessage TEXT
    );
    CREATE TABLE IF NOT EXISTS agent_run_events (
      runId TEXT NOT NULL,
      seq INTEGER NOT NULL,
      payload TEXT NOT NULL,
      createdAt TEXT NOT NULL,
      PRIMARY KEY (runId, seq)
    );
    CREATE TABLE IF NOT EXISTS agent_pending_questions (
      callId TEXT PRIMARY KEY,
      runId TEXT NOT NULL,
      cwd TEXT NOT NULL,
      toolCallId TEXT NOT NULL,
      requestJson TEXT NOT NULL,
      status TEXT NOT NULL,
      answerJson TEXT,
      createdAt TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS agent_authorizations (
      id TEXT PRIMARY KEY,
      runId TEXT NOT NULL,
      scopeKey TEXT NOT NULL,
      scopeJson TEXT NOT NULL,
      remaining INTEGER,
      createdAt TEXT NOT NULL,
      UNIQUE(runId, scopeKey)
    );
    CREATE TABLE IF NOT EXISTS agent_tool_calls (
      toolCallId TEXT PRIMARY KEY,
      runId TEXT NOT NULL,
      name TEXT NOT NULL,
      status TEXT NOT NULL,
      argsJson TEXT,
      resultJson TEXT,
      sideEffect INTEGER NOT NULL DEFAULT 0,
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_agent_runs_session ON agent_runs(cwd, sessionFile, updatedAt);
    CREATE INDEX IF NOT EXISTS idx_agent_pending_run ON agent_pending_questions(runId, status);
  `);
  return database;
}

export async function ensureAgentRunStore() {
  await mkdir(dirname(dbPath()), { recursive: true });
  getAgentRunDatabase();
}

function nowIso() {
  return new Date().toISOString();
}

export function insertAgentRun(record: Omit<AgentRunRecord, "createdAt" | "updatedAt" | "lastEventSeq"> & { lastEventSeq?: number }) {
  const db = getAgentRunDatabase();
  const createdAt = nowIso();
  db.prepare(`
    INSERT INTO agent_runs (
      runId, cwd, sessionFile, status, intent, providerId, modelId, thinkingLevel, inputJson,
      createdAt, updatedAt, lastEventSeq, errorMessage
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    record.runId,
    record.cwd,
    record.sessionFile,
    record.status,
    record.intent,
    record.providerId,
    record.modelId,
    record.thinkingLevel,
    record.inputJson,
    createdAt,
    createdAt,
    record.lastEventSeq ?? 0,
    record.errorMessage ?? null,
  );
  return createdAt;
}

export function updateAgentRun(runId: string, patch: Partial<Pick<AgentRunRecord, "status" | "intent" | "sessionFile" | "errorMessage">>) {
  const db = getAgentRunDatabase();
  const fields: string[] = [];
  const values: unknown[] = [];
  for (const key of ["status", "intent", "sessionFile", "errorMessage"] as const) {
    if (patch[key] !== undefined) {
      fields.push(`${key} = ?`);
      values.push(patch[key]);
    }
  }
  if (!fields.length) return;
  fields.push("updatedAt = ?");
  values.push(nowIso());
  values.push(runId);
  db.prepare(`UPDATE agent_runs SET ${fields.join(", ")} WHERE runId = ?`).run(...(values as (string | null)[]));
}

export function getAgentRun(runId: string) {
  return getAgentRunDatabase().prepare("SELECT * FROM agent_runs WHERE runId = ?").get(runId) as AgentRunRecord | undefined;
}

export function getActiveRunForSession(cwd: string, sessionFile: string) {
  const row = getAgentRunDatabase().prepare(`
    SELECT * FROM agent_runs
    WHERE cwd = ? AND sessionFile = ? AND status IN ('preparing', 'running', 'waitingApproval', 'paused', 'terminating', 'error', 'needsReview')
    ORDER BY updatedAt DESC LIMIT 1
  `).get(cwd, sessionFile) as AgentRunRecord | undefined;
  return row;
}

export function listAgentRunsForWorkspace(cwd: string) {
  return getAgentRunDatabase().prepare(`
    SELECT runId, sessionFile, status, intent, providerId, modelId, createdAt, updatedAt, lastEventSeq
    FROM agent_runs WHERE cwd = ? ORDER BY updatedAt DESC LIMIT 50
  `).all(cwd);
}
export function listIncompleteRuns() {
  return getAgentRunDatabase().prepare(`
    SELECT * FROM agent_runs WHERE status IN ('preparing', 'running', 'waitingApproval', 'paused', 'terminating')
  `).all() as AgentRunRecord[];
}

export function appendRunEvent(runId: string, event: AgentEvent) {
  const db = getAgentRunDatabase();
  return db.transaction(() => {
    const run = db.prepare("SELECT lastEventSeq FROM agent_runs WHERE runId = ?").get(runId) as { lastEventSeq: number } | undefined;
    if (!run) throw new Error("运行不存在");
    const maximum = db.prepare("SELECT MAX(seq) AS seq FROM agent_run_events WHERE runId = ?").get(runId) as { seq: number | null };
    const seq = Math.max(run.lastEventSeq, maximum.seq ?? 0) + 1;
    const createdAt = nowIso();
    db.prepare("INSERT INTO agent_run_events (runId, seq, payload, createdAt) VALUES (?, ?, ?, ?)").run(runId, seq, JSON.stringify(event), createdAt);
    db.prepare("UPDATE agent_runs SET lastEventSeq = ?, updatedAt = ? WHERE runId = ?").run(seq, createdAt, runId);
    return { seq, event, createdAt };
  })();
}

export function listRunEvents(runId: string, afterSeq = 0) {
  return getAgentRunDatabase().prepare(`
    SELECT seq, payload, createdAt FROM agent_run_events WHERE runId = ? AND seq > ? ORDER BY seq ASC
  `).all(runId, afterSeq) as { seq: number; payload: string; createdAt: string }[];
}

export function insertPendingQuestion(record: Omit<PendingQuestionRecord, "status" | "createdAt"> & { status?: PendingQuestionRecord["status"] }) {
  const db = getAgentRunDatabase();
  const createdAt = nowIso();
  db.prepare(`
    INSERT INTO agent_pending_questions (callId, runId, cwd, toolCallId, requestJson, status, answerJson, createdAt)
    VALUES (?, ?, ?, ?, ?, ?, NULL, ?)
  `).run(record.callId, record.runId, record.cwd, record.toolCallId, JSON.stringify(record.request), record.status ?? "waiting", createdAt);
  updateAgentRun(record.runId, { status: "waitingApproval" });
  return createdAt;
}

export function getPendingQuestion(callId: string) {
  const row = getAgentRunDatabase().prepare("SELECT * FROM agent_pending_questions WHERE callId = ?").get(callId) as {
    callId: string; runId: string; cwd: string; toolCallId: string; requestJson: string; status: string; answerJson: string | null; createdAt: string;
  } | undefined;
  if (!row) return undefined;
  return {
    callId: row.callId,
    runId: row.runId,
    cwd: row.cwd,
    toolCallId: row.toolCallId,
    request: JSON.parse(row.requestJson) as QuestionRequest,
    status: row.status as PendingQuestionRecord["status"],
    answer: row.answerJson ? JSON.parse(row.answerJson) as QuestionAnswer : undefined,
    createdAt: row.createdAt,
  } satisfies PendingQuestionRecord;
}

export function listWaitingQuestionsForRun(runId: string) {
  const rows = getAgentRunDatabase().prepare(`
    SELECT * FROM agent_pending_questions WHERE runId = ? AND status = 'waiting' ORDER BY createdAt ASC
  `).all(runId) as { callId: string; runId: string; cwd: string; toolCallId: string; requestJson: string; status: string; answerJson: string | null; createdAt: string }[];
  return rows.map(row => ({
    callId: row.callId,
    runId: row.runId,
    cwd: row.cwd,
    toolCallId: row.toolCallId,
    request: JSON.parse(row.requestJson) as QuestionRequest,
    status: row.status as PendingQuestionRecord["status"],
    answer: row.answerJson ? JSON.parse(row.answerJson) as QuestionAnswer : undefined,
    createdAt: row.createdAt,
  }));
}

export function finishPendingQuestion(callId: string, answer: QuestionAnswer | "cancelled") {
  const pending = getPendingQuestion(callId);
  if (!pending || pending.status !== "waiting") return pending;
  getAgentRunDatabase().prepare("UPDATE agent_pending_questions SET status = ?, answerJson = ? WHERE callId = ?").run(
    answer === "cancelled" ? "cancelled" : "answered",
    answer === "cancelled" ? null : JSON.stringify(answer),
    callId,
  );
  const waiting = listWaitingQuestionsForRun(pending.runId);
  if (!waiting.length) {
    const run = getAgentRun(pending.runId);
    if (run?.status === "waitingApproval") updateAgentRun(pending.runId, { status: run.intent === "pause" ? "paused" : "running" });
  }
  return getPendingQuestion(callId);
}

export function recordToolCallStart(runId: string, toolCallId: string, name: string, args: unknown, sideEffect = false, status = "started") {
  const db = getAgentRunDatabase();
  const createdAt = nowIso();
  db.prepare(`
    INSERT INTO agent_tool_calls (toolCallId, runId, name, status, argsJson, resultJson, sideEffect, createdAt, updatedAt)
    VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?)
    ON CONFLICT(toolCallId) DO UPDATE SET status = excluded.status, argsJson = excluded.argsJson, sideEffect = MAX(agent_tool_calls.sideEffect, excluded.sideEffect), updatedAt = excluded.updatedAt
  `).run(toolCallId, runId, name, status, JSON.stringify(args ?? null), sideEffect ? 1 : 0, createdAt, createdAt);
}

export function recordToolCallFinish(toolCallId: string, status: "completed" | "error" | "needsReview" | "skipped", result?: unknown) {
  getAgentRunDatabase().prepare(`
    UPDATE agent_tool_calls SET status = ?, resultJson = ?, updatedAt = ?, sideEffect = CASE WHEN ? = 'needsReview' THEN 1 ELSE sideEffect END WHERE toolCallId = ?
  `).run(status, JSON.stringify(result ?? null), nowIso(), status, toolCallId);
}

export function getToolCallRecord(toolCallId: string) {
  return getAgentRunDatabase().prepare("SELECT * FROM agent_tool_calls WHERE toolCallId = ?").get(toolCallId) as {
    toolCallId: string; runId: string; name: string; status: string; argsJson: string | null; resultJson: string | null; sideEffect: number;
  } | undefined;
}

const readOnlyTools = new Set(["read", "ls", "report", "skill", "question", "getCanvas", "findCanvasNodes", "getCanvasNodes", "getCanvasEdges", "getNodeTools", "selectNodes", "fitCanvas"]);
export function getToolCallInput(value: unknown): unknown {
  if (value && typeof value === "object" && "args" in value && "canvasId" in value && "canvasPath" in value) return value.args;
  return value;
}

export function isSideEffectTool(name: string) {
  return !readOnlyTools.has(name);
}

export function requiresToolAuthorization(name: string, args?: unknown, context?: NodeToolContext) {
  if (readOnlyTools.has(name)) return false;
  if (classifyToolExecutionMode(name) !== "canvas") return true;
  // 审批与防重播分别判断：本地修改免逐次审批，执行结果未知时仍需核对。
  if (name.startsWith("node:")) return true;
  if (name !== "nodeTools") return false;
  const input = getToolCallInput(args);
  if (!input || typeof input !== "object" || Array.isArray(input) || !("nodeId" in input)) return true;
  const nodeToolName = "name" in input ? input.name : undefined;
  return typeof nodeToolName !== "string" || !isBuiltinNodeTool(input.nodeId, nodeToolName, context);
}

function storedToolContext(run: AgentRunRecord | undefined, args: unknown): NodeToolContext | undefined {
  if (!run || !args || typeof args !== "object" || Array.isArray(args) || !("args" in args)
    || !("canvasId" in args) || typeof args.canvasId !== "string" || !args.canvasId
    || !("canvasPath" in args) || typeof args.canvasPath !== "string" || !args.canvasPath
    || !("nodes" in args) || !args.nodes || typeof args.nodes !== "object" || Array.isArray(args.nodes)
    || !("edges" in args) || !args.edges || typeof args.edges !== "object" || Array.isArray(args.edges)
    || !("outputs" in args) || !args.outputs || typeof args.outputs !== "object" || Array.isArray(args.outputs)) return;
  return { cwd: run.cwd, canvasPath: args.canvasPath,
    nodeRevision: "nodeRevision" in args && typeof args.nodeRevision === "string" ? args.nodeRevision : undefined };
}

function stableValue(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(stableValue);
  return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => [key, stableValue(item)]));
}

export function authorizationScopeKey(toolName: string, args: unknown, modelId: string) {
  const digest = createHash("sha256").update(JSON.stringify(stableValue({ toolName, args, modelId }))).digest("hex");
  return `tool:${digest}`;
}

export function listPendingAuthorizations(runId: string) {
  const run = getAgentRun(runId);
  if (!run) return [];
  const rows = getAgentRunDatabase().prepare("SELECT toolCallId, name, argsJson FROM agent_tool_calls WHERE runId = ? AND status = 'pendingAuthorization' ORDER BY createdAt").all(runId) as { toolCallId: string; name: string; argsJson: string }[];
  const grants = new Map((getAgentRunDatabase().prepare("SELECT scopeKey, remaining FROM agent_authorizations WHERE runId = ?").all(runId) as { scopeKey: string; remaining: number }[])
    .map(row => [row.scopeKey, row.remaining]));
  return rows.map(row => {
    const args = JSON.parse(row.argsJson) as unknown;
    return { toolCallId: row.toolCallId, toolName: row.name, args, modelId: run.modelId, scopeKey: authorizationScopeKey(row.name, args, run.modelId) };
  }).filter(call => requiresToolAuthorization(call.toolName, call.args, storedToolContext(run, call.args)) && (grants.get(call.scopeKey) ?? 0) < 1);
}

export function grantAuthorization(runId: string, toolCallId: string, remaining = 1) {
  const run = getAgentRun(runId);
  const call = getToolCallRecord(toolCallId);
  if (!run || !call || call.runId !== runId || call.status !== "pendingAuthorization" || !call.argsJson)
    throw Object.assign(new Error("没有可授权的待执行工具调用"), { status: 409 });
  const args = JSON.parse(call.argsJson) as unknown;
  if (!requiresToolAuthorization(call.name, args, storedToolContext(run, args)))
    throw Object.assign(new Error("没有可授权的待执行工具调用"), { status: 409 });
  if (!Number.isSafeInteger(remaining) || remaining < 1 || remaining > 1000) throw Object.assign(new Error("授权次数无效"), { status: 400 });
  const scopeKey = authorizationScopeKey(call.name, args, run.modelId);
  const scope = { toolName: call.name, modelId: run.modelId, inputDigest: scopeKey.slice(5) };
  getAgentRunDatabase().prepare(`
    INSERT INTO agent_authorizations (id, runId, scopeKey, scopeJson, remaining, createdAt)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(runId, scopeKey) DO UPDATE SET scopeJson = excluded.scopeJson, remaining = excluded.remaining
  `).run(crypto.randomUUID(), runId, scopeKey, JSON.stringify(scope), remaining, nowIso());
  return scope;
}

export function requireSideEffectAuthorization(runId: string, toolName: string, args: unknown, toolCallId: string, context?: NodeToolContext) {
  const run = getAgentRun(runId);
  if (!requiresToolAuthorization(toolName, args, context ?? storedToolContext(run, args))) return;
  if (!run) throw Object.assign(new Error("运行不存在"), { status: 404 });
  const scopeKey = authorizationScopeKey(toolName, args, run.modelId);
  getAgentRunDatabase().transaction(() => {
    const db = getAgentRunDatabase();
    const authorization = db.prepare("SELECT remaining FROM agent_authorizations WHERE runId = ? AND scopeKey = ?").get(runId, scopeKey) as { remaining: number } | undefined;
    if (!authorization || authorization.remaining < 1)
      throw Object.assign(new Error(`工具 ${toolName} 尚未授权，请核对精确输入和模型`), { code: "AGENT_NEEDS_AUTHORIZATION", status: 403, toolCallId });
    db.prepare("UPDATE agent_authorizations SET remaining = remaining - 1 WHERE runId = ? AND scopeKey = ?").run(runId, scopeKey);
    db.prepare("UPDATE agent_tool_calls SET status = 'started', updatedAt = ? WHERE toolCallId = ? AND runId = ? AND status = 'pendingAuthorization'").run(nowIso(), toolCallId, runId);
  })();
}

export function hasPendingSideEffectReview(runId: string) {
  return Boolean(getAgentRunDatabase().prepare("SELECT 1 FROM agent_tool_calls WHERE runId = ? AND sideEffect = 1 AND status IN ('started', 'needsReview') LIMIT 1").get(runId));
}

export function listPendingSideEffectReviews(runId: string) {
  const rows = getAgentRunDatabase().prepare("SELECT toolCallId, name, argsJson, status FROM agent_tool_calls WHERE runId = ? AND sideEffect = 1 AND status IN ('started', 'needsReview') ORDER BY createdAt").all(runId) as { toolCallId: string; name: string; argsJson: string; status: string }[];
  return rows.map(row => ({ toolCallId: row.toolCallId, toolName: row.name, args: JSON.parse(row.argsJson), status: row.status }));
}

export function acknowledgeRunReview(runId: string, toolCallId: string) {
  const result = getAgentRunDatabase().prepare(`
    UPDATE agent_tool_calls SET status = 'skipped', resultJson = ?, updatedAt = ?
    WHERE runId = ? AND toolCallId = ? AND sideEffect = 1 AND status IN ('started', 'needsReview')
  `).run(JSON.stringify({ reviewed: true, noReplay: true }), nowIso(), runId, toolCallId);
  if (!result.changes) throw Object.assign(new Error("没有可核对的步骤"), { status: 409 });
  if (!hasPendingSideEffectReview(runId)) updateAgentRun(runId, { status: "paused", errorMessage: undefined });
}

export function listAuthorizations(runId: string) {
  const rows = getAgentRunDatabase().prepare(`
    SELECT scopeKey, scopeJson, remaining, createdAt FROM agent_authorizations WHERE runId = ? ORDER BY createdAt ASC
  `).all(runId) as { scopeKey: string; scopeJson: string; remaining: number | null; createdAt: string }[];
  return rows.map(row => ({
    scopeKey: row.scopeKey,
    scope: JSON.parse(row.scopeJson) as Record<string, unknown>,
    remaining: row.remaining,
    createdAt: row.createdAt,
  }));
}
