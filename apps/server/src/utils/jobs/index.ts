import { createHash, randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { NodeJobRequest, NodeJobView } from "@toonflow/nodes-scaffold/execution";
import { ensureAgentRunStore, getAgentRunDatabase } from "@/agent/runtime/store";
import { appendWorkspaceEvent } from "@/utils/canvas/store";
import conf from "@/utils/conf";
import { resolveWorkspace } from "@/utils/workspace";

export type NodeJobEvent = {
  jobId: string;
  seq: number;
  type: "jobChanged" | "progress" | "ffmpeg";
  payload: Record<string, unknown>;
  createdAt: string;
};

export type NodeJobContext = {
  jobId: string;
  directory: string;
  scratchDirectory: string;
  signal: AbortSignal;
  reportProgress(progress: number): void;
  saveResult(result: unknown): void;
};

type JobHandler = (input: Record<string, unknown>, context: NodeJobContext) => Promise<unknown>;
type JobRecord = {
  jobId: string;
  commandId: string;
  directory: string;
  kind: string;
  nodeId: string | null;
  canvasPath: string | null;
  pluginRevision: string | null;
  requestJson: string;
  inputDigest: string;
  handlerRevision: string;
  recoveryMode: "safe" | "review";
  status: NodeJobView["status"];
  progress: number | null;
  resultJson: string | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
  lastEventSeq: number;
  attempt: number;
  cancelRequested: number;
  activationRequired: number;
};

const handlers = new Map<string, { handler: JobHandler; recoveryMode: "safe" | "review"; revision: string }>();
const activeJobs = new Map<string, AbortController>();
const listeners = new Map<string, Set<(event: NodeJobEvent) => void>>();
let tablesReady = false;
let ready: Promise<void> | undefined;
let publishingWorkspaceEvents = false;
let workspaceRetry: ReturnType<typeof setTimeout> | undefined;

function database() {
  const db = getAgentRunDatabase();
  if (tablesReady) return db;
  db.exec(`
    CREATE TABLE IF NOT EXISTS node_jobs (
      jobId TEXT PRIMARY KEY,
      commandId TEXT NOT NULL,
      directory TEXT NOT NULL,
      kind TEXT NOT NULL,
      nodeId TEXT,
      canvasPath TEXT,
      pluginRevision TEXT,
      requestJson TEXT NOT NULL,
      inputDigest TEXT NOT NULL,
      handlerRevision TEXT NOT NULL,
      recoveryMode TEXT NOT NULL,
      status TEXT NOT NULL,
      progress REAL,
      resultJson TEXT,
      errorMessage TEXT,
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL,
      lastEventSeq INTEGER NOT NULL DEFAULT 0,
      attempt INTEGER NOT NULL DEFAULT 0,
      cancelRequested INTEGER NOT NULL DEFAULT 0,
      activationRequired INTEGER NOT NULL DEFAULT 0,
      UNIQUE(directory, commandId, kind)
    );
    CREATE TABLE IF NOT EXISTS node_job_events (
      jobId TEXT NOT NULL,
      seq INTEGER NOT NULL,
      type TEXT NOT NULL,
      payload TEXT NOT NULL,
      createdAt TEXT NOT NULL,
      workspacePublished INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY(jobId, seq)
    );
    CREATE INDEX IF NOT EXISTS idx_node_jobs_workspace ON node_jobs(directory, createdAt);
  `);
  const jobColumns = db.prepare("PRAGMA table_info(node_jobs)").all() as { name: string }[];
  if (!jobColumns.some(column => column.name === "handlerRevision"))
    db.exec("ALTER TABLE node_jobs ADD COLUMN handlerRevision TEXT NOT NULL DEFAULT ''");
  if (!jobColumns.some(column => column.name === "cancelRequested"))
    db.exec("ALTER TABLE node_jobs ADD COLUMN cancelRequested INTEGER NOT NULL DEFAULT 0");
  if (!jobColumns.some(column => column.name === "activationRequired"))
    db.exec("ALTER TABLE node_jobs ADD COLUMN activationRequired INTEGER NOT NULL DEFAULT 0");
  const eventColumns = db.prepare("PRAGMA table_info(node_job_events)").all() as { name: string }[];
  if (!eventColumns.some(column => column.name === "workspacePublished"))
    db.exec("ALTER TABLE node_job_events ADD COLUMN workspacePublished INTEGER NOT NULL DEFAULT 0");
  db.exec("UPDATE node_job_events SET workspacePublished = 1 WHERE type = 'ffmpeg' AND workspacePublished = 0");
  db.exec("CREATE INDEX IF NOT EXISTS idx_node_job_event_outbox ON node_job_events(workspacePublished, jobId, seq)");
  tablesReady = true;
  return db;
}

function getRecord(jobId: string) {
  return database().prepare("SELECT * FROM node_jobs WHERE jobId = ?").get(jobId) as JobRecord | null;
}

function view(record: JobRecord): NodeJobView {
  return {
    jobId: record.jobId,
    commandId: record.commandId,
    directory: record.directory,
    kind: record.kind,
    ...(record.nodeId ? { nodeId: record.nodeId } : {}),
    ...(record.canvasPath ? { canvasPath: record.canvasPath } : {}),
    status: record.status,
    ...(record.progress === null ? {} : { progress: record.progress }),
    ...(record.resultJson === null ? {} : { result: JSON.parse(record.resultJson) as unknown }),
    ...(record.errorMessage ? { errorMessage: record.errorMessage } : {}),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

function flushWorkspaceEvents() {
  if (publishingWorkspaceEvents) return;
  publishingWorkspaceEvents = true;
  try {
    const pending = database().prepare("SELECT jobId, seq, payload FROM node_job_events WHERE workspacePublished = 0 AND type != 'ffmpeg' ORDER BY jobId, seq")
      .all() as { jobId: string; seq: number; payload: string }[];
    for (const event of pending) {
      const record = getRecord(event.jobId);
      if (!record) continue;
      const payload = JSON.parse(event.payload) as Record<string, unknown>;
      appendWorkspaceEvent(record.directory, "jobChanged", payload.job ? payload : { job: view(record) }, {
        commandId: record.commandId, nodeId: record.nodeId ?? undefined,
      });
      database().prepare("UPDATE node_job_events SET workspacePublished = 1 WHERE jobId = ? AND seq = ?")
        .run(event.jobId, event.seq);
    }
  } catch (error) {
    // ACT: 通知采用持久 outbox，失败不会改写已完成作业；崩溃边界允许重复观察通知。
    console.error("作业工作区通知待重试", error);
    if (!workspaceRetry) workspaceRetry = setTimeout(() => {
      workspaceRetry = undefined;
      flushWorkspaceEvents();
    }, 5000);
    workspaceRetry?.unref();
  } finally {
    publishingWorkspaceEvents = false;
  }
}

function publish(event: NodeJobEvent) {
  for (const listener of listeners.get(event.jobId) ?? []) {
    try { listener(event); }
    catch (error) { console.error("作业事件订阅失败", error); }
  }
  if (event.type !== "ffmpeg") flushWorkspaceEvents();
}

function appendEvent(jobId: string, type: NodeJobEvent["type"], payload: Record<string, unknown>) {
  const db = database();
  const event = db.transaction(() => {
    const record = getRecord(jobId);
    if (!record) throw Object.assign(new Error("任务不存在"), { status: 404 });
    const createdAt = new Date().toISOString();
    const seq = record.lastEventSeq + 1;
    db.prepare("INSERT INTO node_job_events (jobId, seq, type, payload, createdAt, workspacePublished) VALUES (?, ?, ?, ?, ?, ?)")
      .run(jobId, seq, type, JSON.stringify(payload), createdAt, type === "ffmpeg" ? 1 : 0);
    db.prepare("UPDATE node_jobs SET lastEventSeq = ? WHERE jobId = ?").run(seq, jobId);
    return { jobId, seq, type, payload, createdAt };
  })();
  publish(event);
  return event;
}

function updateJob(jobId: string, status: NodeJobView["status"], result?: unknown, errorMessage?: string) {
  const db = database();
  const event = db.transaction(() => {
    const now = new Date().toISOString();
    db.prepare("UPDATE node_jobs SET status = ?, resultJson = COALESCE(?, resultJson), errorMessage = ?, updatedAt = ? WHERE jobId = ?")
      .run(status, result === undefined ? null : JSON.stringify(result), errorMessage ?? null, now, jobId);
    const record = getRecord(jobId);
    if (!record) throw Object.assign(new Error("任务不存在"), { status: 404 });
    const seq = record.lastEventSeq + 1;
    const payload = { job: view(record) };
    db.prepare("INSERT INTO node_job_events (jobId, seq, type, payload, createdAt) VALUES (?, ?, 'jobChanged', ?, ?)")
      .run(jobId, seq, JSON.stringify(payload), now);
    db.prepare("UPDATE node_jobs SET lastEventSeq = ? WHERE jobId = ?").run(seq, jobId);
    return { jobId, seq, type: "jobChanged" as const, payload, createdAt: now };
  })();
  publish(event);
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    return `{${Object.keys(value).sort().filter(key => (value as Record<string, unknown>)[key] !== undefined)
      .map(key => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`).join(",")}}`;
  }
  throw Object.assign(new Error("任务参数必须为 JSON 数据"), { status: 400 });
}

function terminal(status: NodeJobView["status"]) {
  return status !== "accepted" && status !== "running";
}

function startJob(jobId: string) {
  if (activeJobs.has(jobId)) return;
  const record = getRecord(jobId);
  if (!record || record.status !== "accepted" || record.activationRequired) return;
  const registered = handlers.get(record.kind);
  if (!registered) return;
  if (record.handlerRevision !== registered.revision) {
    updateJob(jobId, "needsReview", undefined, "任务执行器版本已变化，未使用新版自动重做旧任务");
    return;
  }
  const controller = new AbortController();
  activeJobs.set(jobId, controller);
  try {
    database().prepare("UPDATE node_jobs SET attempt = attempt + 1 WHERE jobId = ?").run(jobId);
    updateJob(jobId, "running");
  } catch (error) {
    activeJobs.delete(jobId);
    throw error;
  }
  const attempt = getRecord(jobId)!.attempt;
  // ACT: 每次安全恢复使用独立产物目录；不删除上一次中断的文件，方便核对与恢复。
  const scratchDirectory = join(dirname(conf.path), "nodeJobs", jobId, `attempt${attempt}`);
  void (async () => {
    await mkdir(scratchDirectory, { recursive: true });
    controller.signal.throwIfAborted();
    const request = JSON.parse(record.requestJson) as NodeJobRequest;
    const result = await registered.handler(request.input, {
      jobId,
      directory: record.directory,
      scratchDirectory,
      signal: controller.signal,
      saveResult(result) { controller.signal.throwIfAborted(); canonicalJson(result); updateJob(jobId, "running", result); },
      reportProgress(progress) {
        if (controller.signal.aborted || !Number.isFinite(progress)) return;
        const value = Math.max(0, Math.min(1, progress));
        const now = new Date().toISOString();
        database().prepare("UPDATE node_jobs SET progress = ?, updatedAt = ? WHERE jobId = ? AND status = 'running'")
          .run(value, now, jobId);
        appendEvent(jobId, "progress", { progress: value });
      },
    });
    controller.signal.throwIfAborted();
    updateJob(jobId, "completed", result);
  })().catch((error: unknown) => {
    const needsReview = error && typeof error === "object" && "code" in error && error.code === "JOB_NEEDS_REVIEW";
    updateJob(jobId, needsReview ? "needsReview" : controller.signal.aborted ? "cancelled" : "failed", undefined,
      error instanceof Error ? error.message : String(error));
  }).finally(() => { activeJobs.delete(jobId); });
}

export function registerNodeJobHandler(kind: string, handler: JobHandler, recoveryMode: "safe" | "review", handlerRevision?: string) {
  if (handlers.has(kind)) throw new Error(`任务处理器已注册：${kind}`);
  const revision = handlerRevision ?? createHash("sha256").update(handler.toString()).digest("hex");
  handlers.set(kind, { handler, recoveryMode, revision });
  if (ready) void ready.then(() => {
    const records = database().prepare("SELECT jobId FROM node_jobs WHERE kind = ? AND status = 'accepted'")
      .all(kind) as { jobId: string }[];
    for (const record of records) startJob(record.jobId);
  });
}

export function ensureNodeJobsReady() {
  if (ready) return ready;
  ready = (async () => {
    await ensureAgentRunStore();
    const records = database().prepare("SELECT * FROM node_jobs WHERE status IN ('accepted', 'running')")
      .all() as JobRecord[];
    flushWorkspaceEvents();
    for (const record of records) {
      if (record.activationRequired) {
        updateJob(record.jobId, "needsReview", undefined, "任务尚未完成节点绑定，请核对后继续；未启动执行");
        continue;
      }
      if (record.status === "running") {
        const safe = record.recoveryMode === "safe" && !record.cancelRequested;
        updateJob(record.jobId, safe ? "accepted" : "needsReview", undefined,
          safe ? undefined : "后台重启时任务尚未完成，请核对已有产物后继续");
      } else if (record.cancelRequested) {
        updateJob(record.jobId, "cancelled", undefined, "任务已取消");
      }
      startJob(record.jobId);
    }
  })();
  return ready;
}

export async function acceptNodeJob(input: { directory: string; commandId: string; request: NodeJobRequest; deferStart?: boolean }): Promise<NodeJobView> {
  await ensureNodeJobsReady();
  const directory = await resolveWorkspace(input.directory);
  if (!input.commandId || !input.request.kind) throw Object.assign(new Error("任务命令与类型不能为空"), { status: 400 });
  const requestJson = canonicalJson(input.request);
  const inputDigest = createHash("sha256").update(requestJson).digest("hex");
  const db = database();
  const existing = db.prepare("SELECT * FROM node_jobs WHERE directory = ? AND commandId = ? AND kind = ?")
    .get(directory, input.commandId, input.request.kind) as JobRecord | null;
  if (existing) {
    if (existing.inputDigest !== inputDigest) throw Object.assign(new Error("同一任务命令对应不同输入"), { status: 409 });
    startJob(existing.jobId);
    return view(getRecord(existing.jobId)!);
  }
  const registered = handlers.get(input.request.kind);
  if (!registered) throw Object.assign(new Error(`没有可用的任务处理器：${input.request.kind}`), { status: 422 });
  const jobId = randomUUID();
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO node_jobs (
    jobId, commandId, directory, kind, nodeId, canvasPath, pluginRevision, requestJson, inputDigest,
    recoveryMode, handlerRevision, activationRequired, status, createdAt, updatedAt
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'accepted', ?, ?)`).run(
    jobId, input.commandId, directory, input.request.kind, input.request.nodeId ?? null,
    input.request.canvasPath ?? null, input.request.pluginRevision ?? null, requestJson, inputDigest,
    registered.recoveryMode, registered.revision, input.deferStart ? 1 : 0, now, now,
  );
  appendEvent(jobId, "jobChanged", { job: view(getRecord(jobId)!) });
  // 执行在独立生命周期中进行，受理后客户端连接不会持有取消信号。
  startJob(jobId);
  return view(getRecord(jobId)!);
}

export function activateNodeJob(jobId: string): NodeJobView {
  const record = getRecord(jobId);
  if (!record) throw Object.assign(new Error("任务不存在"), { status: 404 });
  if (terminal(record.status)) return view(record);
  database().prepare("UPDATE node_jobs SET activationRequired = 0 WHERE jobId = ? AND status = 'accepted'").run(jobId);
  startJob(jobId);
  return getNodeJob(jobId)!;
}

export function getNodeJob(jobId: string): NodeJobView | undefined {
  const record = getRecord(jobId);
  return record ? view(record) : undefined;
}

export function getNodeJobRequest(jobId: string): NodeJobRequest | undefined {
  const record = getRecord(jobId);
  return record ? JSON.parse(record.requestJson) : undefined;
}

export function getNodeJobForCommand(directory: string, commandId: string, kind: string): NodeJobView | undefined {
  const record = database().prepare("SELECT * FROM node_jobs WHERE directory = ? AND commandId = ? AND kind = ?")
    .get(directory, commandId, kind) as JobRecord | null;
  return record ? view(record) : undefined;
}

export function getNodeJobCursor(jobId: string) {
  return getRecord(jobId)?.lastEventSeq ?? 0;
}

export function listNodeJobs(directory: string): NodeJobView[] {
  return (database().prepare("SELECT * FROM node_jobs WHERE directory = ? ORDER BY createdAt DESC")
    .all(directory) as JobRecord[]).map(view);
}

export function listNodeJobEvents(jobId: string, afterSeq = 0): NodeJobEvent[] {
  const records = database().prepare("SELECT jobId, seq, type, payload, createdAt FROM node_job_events WHERE jobId = ? AND seq > ? ORDER BY seq")
    .all(jobId, afterSeq) as { jobId: string; seq: number; type: NodeJobEvent["type"]; payload: string; createdAt: string }[];
  return records.map(record => ({ ...record, payload: JSON.parse(record.payload) as Record<string, unknown> }));
}

export function reportNodeJobEvent(jobId: string, type: "ffmpeg", payload: Record<string, unknown>) {
  return appendEvent(jobId, type, payload);
}

export function subscribeNodeJob(jobId: string, listener: (event: NodeJobEvent) => void, afterSeq = 0) {
  let set = listeners.get(jobId);
  if (!set) listeners.set(jobId, set = new Set());
  set.add(listener);
  for (const event of listNodeJobEvents(jobId, afterSeq)) listener(event);
  return () => {
    set.delete(listener);
    if (!set.size) listeners.delete(jobId);
  };
}

export function waitForNodeJob(jobId: string, signal?: AbortSignal): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let unsubscribe = () => {};
    const finish = () => {
      unsubscribe();
      signal?.removeEventListener("abort", cancel);
    };
    const cancel = () => { finish(); reject(signal?.reason ?? new DOMException("等待已取消", "AbortError")); };
    const check = () => {
      const job = getNodeJob(jobId);
      if (job?.status === "accepted" || job?.status === "running") return;
      finish();
      if (job?.status === "completed") resolve(job.result);
      else reject(Object.assign(new Error(job?.errorMessage ?? (job ? "任务未完成" : "任务不存在")), {
        status: job ? 409 : 404, jobId, jobStatus: job?.status,
      }));
    };
    if (signal?.aborted) { cancel(); return; }
    unsubscribe = subscribeNodeJob(jobId, check, getNodeJobCursor(jobId));
    signal?.addEventListener("abort", cancel, { once: true });
    check();
  });
}

export function cancelNodeJob(jobId: string): NodeJobView {
  const record = getRecord(jobId);
  if (!record) throw Object.assign(new Error("任务不存在"), { status: 404 });
  if (terminal(record.status)) return view(record);
  database().prepare("UPDATE node_jobs SET cancelRequested = 1 WHERE jobId = ?").run(jobId);
  const controller = activeJobs.get(jobId);
  if (controller) {
    updateJob(jobId, "running", undefined, "正在取消任务");
    controller.abort(new DOMException("任务已取消", "AbortError"));
  }
  else updateJob(jobId, "cancelled", undefined, "任务已取消");
  return getNodeJob(jobId)!;
}
