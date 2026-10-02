import { createHash } from "node:crypto";
import { posix } from "node:path";
import type { CanvasCommand, CanvasCommandResult, WorkspaceEvent } from "@toonflow/nodes-scaffold/execution";
import { getAgentRunDatabase } from "@/agent/runtime/store";

let initialized = false;
const subscribers = new Map<string, Set<(event: WorkspaceEvent) => void>>();
type ResourceWriteInput = { directory: string; commandId: string; path: string; beforeHash: string; afterHash: string; content: string };
type ResourceWriteRecord = Omit<ResourceWriteInput, "content"> & {
  contentJson: string; status: "accepted" | "written" | "completed"; kind: "content" | "graph"; metadataJson: string | null;
};
type GraphWriteInput = ResourceWriteInput & { operationId: string; digest: string; result: unknown };
type WriteEvent = {
  type: WorkspaceEvent["type"]; payload: Record<string, unknown>;
  target?: { commandId?: string; canvasId?: string; nodeId?: string };
};

function normalizeResourcePath(path: string) {
  const normalized = posix.normalize(path.replaceAll("\\", "/")).replace(/\/$/, "");
  return normalized === "." ? "" : process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function db() {
  const database = getAgentRunDatabase();
  if (!initialized) {
    database.exec(`
      CREATE TABLE IF NOT EXISTS canvas_commands (
        directory TEXT NOT NULL, commandId TEXT NOT NULL, digest TEXT NOT NULL,
        requestJson TEXT NOT NULL, status TEXT NOT NULL, resultJson TEXT,
        errorMessage TEXT, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL,
        PRIMARY KEY(directory, commandId)
      );
      CREATE TABLE IF NOT EXISTS workspace_events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, directory TEXT NOT NULL,
        eventJson TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS workspace_event_directory ON workspace_events(directory, seq);
      CREATE TABLE IF NOT EXISTS resource_commands (
        directory TEXT NOT NULL, commandId TEXT NOT NULL, path TEXT NOT NULL,
        beforeHash TEXT NOT NULL, afterHash TEXT NOT NULL, contentJson TEXT NOT NULL,
        status TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'content', metadataJson TEXT,
        PRIMARY KEY(directory, commandId)
      );
      CREATE TABLE IF NOT EXISTS managed_resources (
        directory TEXT NOT NULL, path TEXT NOT NULL, PRIMARY KEY(directory, path)
      );
    `);
    const columns = new Set((database.query("PRAGMA table_info(resource_commands)").all() as { name: string }[]).map(column => column.name));
    if (!columns.has("kind")) database.exec("ALTER TABLE resource_commands ADD COLUMN kind TEXT NOT NULL DEFAULT 'content'");
    if (!columns.has("metadataJson")) database.exec("ALTER TABLE resource_commands ADD COLUMN metadataJson TEXT");
    initialized = true;
  }
  return database;
}

export function requestDigest(value: unknown) {
  // ACT: 输入已经由 schema 规范化；对象属性排序保证重连重试不受 JSON 属性顺序影响。
  function canonical(input: unknown): unknown {
    if (Array.isArray(input)) return input.map(canonical);
    if (input && typeof input === "object") return Object.fromEntries(Object.keys(input).sort().map(key => [key, canonical((input as Record<string, unknown>)[key])]));
    return input;
  }
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}

export function acceptCanvasCommand(command: CanvasCommand, identity: CanvasCommand = command) {
  const database = db();
  const digest = requestDigest(identity);
  const existing = database.query("SELECT digest FROM canvas_commands WHERE directory=? AND commandId=?").get(command.directory, command.commandId) as { digest: string } | null;
  if (existing) {
    if (existing.digest !== digest) throw Object.assign(new Error("命令 ID 已用于其他内容"), { status: 409 });
    return false;
  }
  const now = new Date().toISOString();
  database.query("INSERT INTO canvas_commands (directory,commandId,digest,requestJson,status,resultJson,errorMessage,createdAt,updatedAt) VALUES (?, ?, ?, ?, 'accepted', NULL, NULL, ?, ?)").run(command.directory, command.commandId, digest, JSON.stringify(command), now, now);
  return true;
}

export function updateCanvasCommand(directory: string, result: CanvasCommandResult) {
  db().query("UPDATE canvas_commands SET status=?,resultJson=?,errorMessage=?,updatedAt=? WHERE directory=? AND commandId=?")
    .run(result.status, JSON.stringify(result), result.errorMessage ?? null, new Date().toISOString(), directory, result.commandId);
}

export function getCanvasCommand(directory: string, commandId: string): CanvasCommandResult | undefined {
  const row = db().query("SELECT status,resultJson,errorMessage FROM canvas_commands WHERE directory=? AND commandId=?").get(directory, commandId) as { status: CanvasCommandResult["status"]; resultJson: string | null; errorMessage: string | null } | null;
  return row ? row.resultJson ? JSON.parse(row.resultJson) : { commandId, status: row.status, errorMessage: row.errorMessage ?? undefined } : undefined;
}

export function listIncompleteCanvasCommands() {
  return (db().query("SELECT requestJson,status FROM canvas_commands WHERE status IN ('accepted','running')").all() as { requestJson: string; status: string }[])
    .map(row => ({ command: JSON.parse(row.requestJson) as CanvasCommand, status: row.status }));
}

export function hasPendingInputSnapshot(directory: string) {
  return !!db().query("SELECT 1 FROM canvas_commands WHERE status IN ('accepted','running') AND json_extract(requestJson, '$.inputSnapshot.directory') = ? LIMIT 1").get(directory);
}

function insertWorkspaceEvent(directory: string, type: WorkspaceEvent["type"], payload: Record<string, unknown>, target: { commandId?: string; canvasId?: string; nodeId?: string } = {}) {
  const database = db();
  const event = { eventId: crypto.randomUUID(), directory, type, payload, ...target, createdAt: new Date().toISOString() };
  const inserted = database.query("INSERT INTO workspace_events(directory,eventJson) VALUES (?,?)").run(directory, JSON.stringify(event));
  return { ...event, seq: Number(inserted.lastInsertRowid) };
}

function notifyWorkspaceEvent(event: WorkspaceEvent) {
  for (const listener of subscribers.get(event.directory) ?? []) {
    try { listener(event); } catch { /* 观察者错误不撤回已持久事件。 */ }
  }
}

export function appendWorkspaceEvent(directory: string, type: WorkspaceEvent["type"], payload: Record<string, unknown>, target: { commandId?: string; canvasId?: string; nodeId?: string } = {}) {
  const event = insertWorkspaceEvent(directory, type, payload, target);
  notifyWorkspaceEvent(event);
  return event;
}

export function notifyPluginsChanged(name: string) {
  // 节点目录属于全局设置；在线工作区立即核对，离线工作区在恢复订阅时核对目录。
  for (const directory of [...subscribers.keys()]) appendWorkspaceEvent(directory, "pluginsChanged", { nodeName: name });
}

export function getWorkspaceCursor(directory: string) {
  const row = db().query("SELECT COALESCE(MAX(seq),0) AS seq FROM workspace_events WHERE directory=?").get(directory) as { seq: number };
  return row.seq;
}

export function subscribeWorkspaceEvents(directory: string, afterSeq: number, listener: (event: WorkspaceEvent) => void) {
  for (const row of db().query("SELECT seq,eventJson FROM workspace_events WHERE directory=? AND seq>? ORDER BY seq").all(directory, afterSeq) as { seq: number; eventJson: string }[])
    listener({ ...JSON.parse(row.eventJson), seq: row.seq });
  let listeners = subscribers.get(directory);
  if (!listeners) subscribers.set(directory, listeners = new Set());
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (!listeners.size) subscribers.delete(directory);
  };
}

function findResourceWrite(directory: string, commandId: string) {
  return db().query("SELECT * FROM resource_commands WHERE directory=? AND commandId=?").get(directory, commandId) as ResourceWriteRecord | null;
}

function acceptWrite(input: ResourceWriteInput, kind: ResourceWriteRecord["kind"], metadata: Record<string, unknown> | null = null) {
  const path = normalizeResourcePath(input.path);
  const contentJson = JSON.stringify(input.content);
  const existing = findResourceWrite(input.directory, input.commandId);
  if (existing) {
    if (existing.kind !== kind || normalizeResourcePath(existing.path) !== path
      || existing.beforeHash !== input.beforeHash || existing.afterHash !== input.afterHash || existing.contentJson !== contentJson
      || requestDigest(JSON.parse(existing.metadataJson ?? "null")) !== requestDigest(metadata)) {
      throw Object.assign(new Error("写入命令 ID 已用于其他内容"), { status: 409 });
    }
    return existing.status;
  }
  db().query("INSERT INTO resource_commands (directory,commandId,path,beforeHash,afterHash,contentJson,status,kind,metadataJson) VALUES (?,?,?,?,?,?,'accepted',?,?)")
    .run(input.directory, input.commandId, path, input.beforeHash, input.afterHash, contentJson, kind, metadata ? JSON.stringify(metadata) : null);
  return "accepted" as const;
}

export function acceptResourceWrite(input: ResourceWriteInput) {
  return acceptWrite(input, "content");
}

export function getResourceWrite(directory: string, commandId: string) {
  const row = findResourceWrite(directory, commandId);
  return row?.kind === "content" ? {
    path: normalizeResourcePath(row.path), beforeHash: row.beforeHash, afterHash: row.afterHash, status: row.status, contentJson: row.contentJson,
  } : undefined;
}

function completeWrite(directory: string, commandId: string, kind: ResourceWriteRecord["kind"], event?: WriteEvent) {
  const database = db();
  const published = database.transaction(() => {
    const row = findResourceWrite(directory, commandId);
    if (!row) throw Object.assign(new Error("写入命令不存在"), { status: 404 });
    if (row.kind !== kind) throw Object.assign(new Error("写入命令类型不一致"), { status: 409 });
    if (row.status === "completed") return;
    database.query("UPDATE resource_commands SET status='completed' WHERE directory=? AND commandId=?").run(directory, commandId);
    if (!event) return;
    const payload = typeof event.payload.path === "string" ? { ...event.payload, path: normalizeResourcePath(event.payload.path) } : event.payload;
    return insertWorkspaceEvent(directory, event.type, payload, { commandId, ...event.target });
  })();
  if (published) notifyWorkspaceEvent(published);
  return published;
}

function markWriteApplied(directory: string, commandId: string, kind: ResourceWriteRecord["kind"]) {
  const row = findResourceWrite(directory, commandId);
  if (!row) throw Object.assign(new Error("写入命令不存在"), { status: 404 });
  if (row.kind !== kind) throw Object.assign(new Error("写入命令类型不一致"), { status: 409 });
  db().query("UPDATE resource_commands SET status='written' WHERE directory=? AND commandId=? AND status='accepted'").run(directory, commandId);
}

export function markResourceWriteApplied(directory: string, commandId: string) {
  markWriteApplied(directory, commandId, "content");
}

export function completeResourceWrite(directory: string, commandId: string, event?: { path: string; revision: string }) {
  if (event) {
    const row = getResourceWrite(directory, commandId);
    if (!row || row.path !== normalizeResourcePath(event.path) || row.afterHash !== event.revision) {
      throw Object.assign(new Error("内容事件与写入命令不一致"), { status: 409 });
    }
  }
  return completeWrite(directory, commandId, "content", event ? {
    type: "contentChanged", payload: { path: normalizeResourcePath(event.path), revision: event.revision },
  } : undefined);
}

export function listIncompleteResourceWrites() {
  return (db().query("SELECT directory,commandId,path,beforeHash,afterHash,contentJson,status FROM resource_commands WHERE kind='content' AND status IN ('accepted','written')").all() as (Omit<ResourceWriteInput, "content"> & { contentJson: string; status: ResourceWriteRecord["status"] })[])
    .map(row => ({ ...row, path: normalizeResourcePath(row.path) }));
}

export function acceptGraphWrite(input: GraphWriteInput) {
  return acceptWrite(input, "graph", { operationId: input.operationId, digest: input.digest, result: input.result });
}

function graphWriteRecord(row: ResourceWriteRecord) {
  const metadata = JSON.parse(row.metadataJson!) as { operationId: string; digest: string; result: unknown };
  return {
    directory: row.directory, commandId: row.commandId, path: normalizeResourcePath(row.path), beforeHash: row.beforeHash, afterHash: row.afterHash,
    content: JSON.parse(row.contentJson) as string, ...metadata, status: row.status,
  };
}

export function getGraphWrite(directory: string, commandId: string) {
  const row = findResourceWrite(directory, commandId);
  return row?.kind === "graph" ? graphWriteRecord(row) : undefined;
}

export function listIncompleteGraphWrites() {
  return (db().query("SELECT * FROM resource_commands WHERE kind='graph' AND status IN ('accepted','written')").all() as ResourceWriteRecord[]).map(graphWriteRecord);
}

export function markGraphWriteApplied(directory: string, commandId: string) {
  markWriteApplied(directory, commandId, "graph");
}

export function completeGraphWrite(directory: string, commandId: string, event?: WriteEvent) {
  return completeWrite(directory, commandId, "graph", event);
}

export function registerManagedResource(directory: string, path: string) {
  db().query("INSERT OR IGNORE INTO managed_resources (directory,path) VALUES (?,?)").run(directory, normalizeResourcePath(path));
}

function managedResourcePaths(directory: string) {
  return (db().query("SELECT path FROM managed_resources WHERE directory=?").all(directory) as { path: string }[]).map(row => normalizeResourcePath(row.path));
}

export function isManagedResource(directory: string, path: string) {
  const normalized = normalizeResourcePath(path);
  return /^assets\/[^/]+\/(content\.md|model\.json)$/.test(normalized)
    || managedResourcePaths(directory).includes(normalized);
}

export function containsManagedResource(directory: string, path: string) {
  const normalized = normalizeResourcePath(path);
  if (/^assets\/[^/]+\/(content\.md|model\.json)$/.test(normalized)) return true;
  return managedResourcePaths(directory).some(registered => registered === normalized
    || !normalized || registered.startsWith(`${normalized}/`) || normalized.startsWith(`${registered}/`));
}
