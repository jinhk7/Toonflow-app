import { Database } from "bun:sqlite";
import { dirname, join } from "node:path";
import conf from "@/utils/conf";

export const mediaJobStatuses = [
  "prepared",
  "submitting",
  "tracking",
  "collecting",
  "completed",
  "failed",
  "unknown",
  "collectionFailed",
] as const;

export type MediaJobStatus = typeof mediaJobStatuses[number];
export type MediaJobRecoveryMode = "async" | "sync" | "none";

export type MediaJobRow = {
  jobId: string;
  idempotencyKey: string;
  requestDigest: string;
  workspaceDirectory: string;
  mediaType: "image" | "video" | "audio";
  requestJson: string;
  providerId: string;
  modelId: string;
  providerRevision: string;
  canvasId: string | null;
  canvasPath: string | null;
  nodeId: string | null;
  nodeVersion: number | null;
  outputSlot: string | null;
  outputVersion: number | null;
  linkStatus: "none" | "pending" | "linked" | "unlinked";
  status: MediaJobStatus;
  recoveryMode: MediaJobRecoveryMode;
  remoteTaskId: string | null;
  pendingAssetsJson: string | null;
  resultJson: string | null;
  collectedFilesJson: string | null;
  errorMessage: string | null;
  createdAt: number;
  updatedAt: number;
};

let database: Database | undefined;

function dbPath() {
  return join(dirname(conf.path), "mediaJobs.sqlite");
}

function getDb() {
  if (database) return database;
  database = new Database(dbPath(), { create: true });
  database.exec("PRAGMA journal_mode = WAL;");
  database.exec(`
    CREATE TABLE IF NOT EXISTS mediaJobs (
      jobId TEXT PRIMARY KEY,
      idempotencyKey TEXT NOT NULL,
      requestDigest TEXT NOT NULL,
      workspaceDirectory TEXT NOT NULL,
      mediaType TEXT NOT NULL,
      requestJson TEXT NOT NULL,
      providerId TEXT NOT NULL,
      providerRevision TEXT NOT NULL DEFAULT '',
      modelId TEXT NOT NULL,
      canvasId TEXT,
      canvasPath TEXT,
      nodeId TEXT,
      nodeVersion INTEGER,
      outputSlot TEXT,
      outputVersion INTEGER,
      linkStatus TEXT NOT NULL DEFAULT 'none',
      status TEXT NOT NULL,
      recoveryMode TEXT NOT NULL DEFAULT 'none',
      remoteTaskId TEXT,
      pendingAssetsJson TEXT,
      resultJson TEXT,
      collectedFilesJson TEXT,
      errorMessage TEXT,
      createdAt INTEGER NOT NULL,
      updatedAt INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS mediaJobs_idempotency
      ON mediaJobs (workspaceDirectory, idempotencyKey);
    CREATE INDEX IF NOT EXISTS mediaJobs_status ON mediaJobs (status);
  `);
  const columns = new Set((database.query("PRAGMA table_info(mediaJobs)").all() as { name: string }[]).map(column => column.name));
  for (const [name, definition] of Object.entries({ collectedFilesJson: "TEXT", providerRevision: "TEXT NOT NULL DEFAULT ''", canvasId: "TEXT", canvasPath: "TEXT", nodeId: "TEXT", nodeVersion: "INTEGER", outputSlot: "TEXT", outputVersion: "INTEGER", linkStatus: "TEXT NOT NULL DEFAULT 'none'" })) {
    if (!columns.has(name)) database.exec(`ALTER TABLE mediaJobs ADD COLUMN ${name} ${definition}`);
  }
  return database;
}

function rowToJob(row: Record<string, unknown>): MediaJobRow {
  return {
    jobId: String(row.jobId),
    idempotencyKey: String(row.idempotencyKey),
    requestDigest: String(row.requestDigest),
    workspaceDirectory: String(row.workspaceDirectory),
    mediaType: row.mediaType as MediaJobRow["mediaType"],
    requestJson: String(row.requestJson),
    providerId: String(row.providerId),
    modelId: String(row.modelId),
    providerRevision: String(row.providerRevision ?? ""),
    canvasId: row.canvasId == null ? null : String(row.canvasId),
    canvasPath: row.canvasPath == null ? null : String(row.canvasPath),
    nodeId: row.nodeId == null ? null : String(row.nodeId),
    nodeVersion: row.nodeVersion == null ? null : Number(row.nodeVersion),
    outputSlot: row.outputSlot == null ? null : String(row.outputSlot),
    outputVersion: row.outputVersion == null ? null : Number(row.outputVersion),
    linkStatus: (row.linkStatus ?? "none") as MediaJobRow["linkStatus"],
    status: row.status as MediaJobStatus,
    recoveryMode: (row.recoveryMode ?? "none") as MediaJobRecoveryMode,
    remoteTaskId: row.remoteTaskId == null ? null : String(row.remoteTaskId),
    pendingAssetsJson: row.pendingAssetsJson == null ? null : String(row.pendingAssetsJson),
    resultJson: row.resultJson == null ? null : String(row.resultJson),
    collectedFilesJson: row.collectedFilesJson == null ? null : String(row.collectedFilesJson),
    errorMessage: row.errorMessage == null ? null : String(row.errorMessage),
    createdAt: Number(row.createdAt),
    updatedAt: Number(row.updatedAt),
  };
}

export function findMediaJobById(jobId: string) {
  const row = getDb().query("SELECT * FROM mediaJobs WHERE jobId = ?").get(jobId) as Record<string, unknown> | null;
  return row ? rowToJob(row) : undefined;
}

export function findMediaJobByIdempotency(workspaceDirectory: string, idempotencyKey: string) {
  const row = getDb().query(
    "SELECT * FROM mediaJobs WHERE workspaceDirectory = ? AND idempotencyKey = ?",
  ).get(workspaceDirectory, idempotencyKey) as Record<string, unknown> | null;
  return row ? rowToJob(row) : undefined;
}

export type InsertMediaJobInput = {
  jobId: string;
  idempotencyKey: string;
  requestDigest: string;
  workspaceDirectory: string;
  mediaType: MediaJobRow["mediaType"];
  requestJson: string;
  providerId: string;
  providerRevision: string;
  modelId: string;
  binding?: Pick<MediaJobRow, "canvasId" | "canvasPath" | "nodeId" | "nodeVersion" | "outputSlot" | "outputVersion">;
};

export function insertMediaJob(input: InsertMediaJobInput) {
  const now = Date.now();
  getDb().query(`
    INSERT INTO mediaJobs (
      jobId, idempotencyKey, requestDigest, workspaceDirectory, mediaType, requestJson,
      providerId, modelId, providerRevision, canvasId, canvasPath, nodeId, nodeVersion, outputSlot, outputVersion,
      linkStatus, status, recoveryMode, createdAt, updatedAt
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'prepared', 'none', ?, ?)
  `).run(
    input.jobId,
    input.idempotencyKey,
    input.requestDigest,
    input.workspaceDirectory,
    input.mediaType,
    input.requestJson,
    input.providerId,
    input.modelId,
    input.providerRevision,
    input.binding?.canvasId ?? null,
    input.binding?.canvasPath ?? null,
    input.binding?.nodeId ?? null,
    input.binding?.nodeVersion ?? null,
    input.binding?.outputSlot ?? null,
    input.binding?.outputVersion ?? null,
    input.binding ? "pending" : "none",
    now,
    now,
  );
  return findMediaJobById(input.jobId)!;
}

export function updateMediaJob(
  jobId: string,
  patch: Partial<Pick<MediaJobRow,
    "status" | "recoveryMode" | "remoteTaskId" | "pendingAssetsJson" | "resultJson" | "collectedFilesJson" | "errorMessage" | "linkStatus" | "canvasPath"
  >>,
) {
  const fields: string[] = [];
  const values: unknown[] = [];
  for (const [key, value] of Object.entries(patch)) {
    fields.push(`${key} = ?`);
    values.push(value);
  }
  fields.push("updatedAt = ?");
  values.push(Date.now());
  values.push(jobId);
  getDb().query(`UPDATE mediaJobs SET ${fields.join(", ")} WHERE jobId = ?`).run(...(values as (string | number | bigint | boolean | null | Uint8Array)[]));
}

export function listResumableMediaJobs() {
  const rows = getDb().query(`
    SELECT * FROM mediaJobs
    WHERE status IN ('prepared', 'tracking', 'collecting')
       OR (status = 'submitting' AND remoteTaskId IS NOT NULL)
       OR (status = 'completed' AND linkStatus = 'pending')
  `).all() as Record<string, unknown>[];
  return rows.map(rowToJob);
}
export function listProjectMediaJobs(workspaceDirectory: string) {
  const rows = getDb().query("SELECT * FROM mediaJobs WHERE workspaceDirectory = ? ORDER BY createdAt DESC LIMIT 200").all(workspaceDirectory) as Record<string, unknown>[];
  return rows.map(rowToJob);
}

export function updateMediaJobCanvasPath(workspaceDirectory: string, canvasId: string, canvasPath: string) {
  getDb().query("UPDATE mediaJobs SET canvasPath = ? WHERE workspaceDirectory = ? AND canvasId = ?")
    .run(canvasPath, workspaceDirectory, canvasId);
}

export function markInterruptedSubmittingAsUnknown() {
  getDb().query(`
    UPDATE mediaJobs
    SET status = 'unknown',
        errorMessage = COALESCE(errorMessage, '提交结果未知，需人工核对；不会自动重新生成'),
        recoveryMode = CASE WHEN recoveryMode = 'sync' THEN 'sync' ELSE recoveryMode END,
        updatedAt = ?
    WHERE status = 'submitting' AND remoteTaskId IS NULL
  `).run(Date.now());
}
