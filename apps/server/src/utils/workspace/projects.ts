import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { mkdir, realpath, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import conf from "@/utils/conf";

export type ProjectRecord = {
  projectId: string;
  directory: string;
  name: string;
  lastOpenedAt: number;
  registeredAt: number;
  source: "import" | "local" | "serverWorkspace";
};

export type ProjectListItem = ProjectRecord & {
  status: "ok" | "missing";
  message?: string;
};

let database: Database | null = null;

function projectDb() {
  if (!database) {
    database = new Database(resolve(dirname(conf.path), "workspaceState.sqlite"), { create: true });
    database.run(`CREATE TABLE IF NOT EXISTS projects (
      projectId TEXT PRIMARY KEY,
      directory TEXT NOT NULL,
      directoryKey TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      lastOpenedAt INTEGER NOT NULL,
      registeredAt INTEGER NOT NULL,
      source TEXT NOT NULL
    )`);
  }
  return database;
}

export function directoryKey(directory: string) {
  return process.platform === "win32" ? directory.toLowerCase() : directory;
}

export async function normalizeProjectDirectory(path: string) {
  if (!path) throw Object.assign(new Error("工作目录不能为空"), { status: 400 });
  const directory = await realpath(path).catch((err: NodeJS.ErrnoException) => {
    if (err.code === "ENOENT" || err.code === "ENOTDIR") throw Object.assign(new Error("工作目录不存在，请重新选择文件夹"), { status: 404 });
    throw err;
  });
  if (!(await stat(directory)).isDirectory()) throw Object.assign(new Error("工作目录不是文件夹，请重新选择"), { status: 404 });
  return directory;
}

async function serverWorkspaceRoot() {
  const workspaceRoot = resolve(dirname(conf.path), "workspaces");
  await mkdir(workspaceRoot, { recursive: true });
  return await realpath(workspaceRoot);
}

export async function isWithinServerWorkspace(directory: string) {
  const root = await serverWorkspaceRoot();
  const offset = relative(root, directory);
  return offset !== ".." && !offset.startsWith(`..${sep}`) && !isAbsolute(offset);
}

function getProjectByDirectoryKey(key: string) {
  const row = projectDb().query("SELECT * FROM projects WHERE directoryKey = ? LIMIT 1").get(key) as Record<string, unknown> | null;
  return row ? readProject(row) : null;
}

function defaultName(directory: string, name?: string) {
  const trimmed = name?.trim();
  return trimmed || basename(directory) || directory;
}

function readProject(row: Record<string, unknown>): ProjectRecord {
  return {
    projectId: String(row.projectId),
    directory: String(row.directory),
    name: String(row.name),
    lastOpenedAt: Number(row.lastOpenedAt),
    registeredAt: Number(row.registeredAt),
    source: row.source as ProjectRecord["source"],
  };
}

export function listProjects(): ProjectListItem[] {
  const rows = projectDb().query("SELECT * FROM projects ORDER BY lastOpenedAt DESC").all() as Record<string, unknown>[];
  return rows.map(row => ({ ...readProject(row), status: "ok" as const }));
}

export async function hydrateProjectStatuses(projects: ProjectListItem[]) {
  const hydrated: ProjectListItem[] = [];
  for (const project of projects) {
    try {
      const directory = await normalizeProjectDirectory(project.directory);
      hydrated.push(directory === project.directory ? { ...project, status: "ok" } : { ...project, directory, status: "ok" });
    } catch (err) {
      hydrated.push({
        ...project,
        status: "missing",
        message: err instanceof Error ? err.message : "工作目录不可用",
      });
    }
  }
  return hydrated;
}

export async function registerProject(directoryInput: string, options: { name?: string; source: ProjectRecord["source"]; lastOpenedAt?: number }) {
  const directory = await normalizeProjectDirectory(directoryInput);
  const key = directoryKey(directory);
  const existing = getProjectByDirectoryKey(key);
  const now = Date.now();
  const name = defaultName(directory, options.name ?? existing?.name);
  const lastOpenedAt = options.lastOpenedAt ?? now;
  if (existing) {
    projectDb().query("UPDATE projects SET directory = ?, name = ?, lastOpenedAt = ?, source = ? WHERE projectId = ?")
      .run(directory, name, lastOpenedAt, options.source, existing.projectId);
    return { ...existing, directory, name, lastOpenedAt, source: options.source };
  }
  const projectId = randomUUID();
  const registeredAt = now;
  projectDb().query("INSERT INTO projects (projectId, directory, directoryKey, name, lastOpenedAt, registeredAt, source) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(projectId, directory, key, name, lastOpenedAt, registeredAt, options.source);
  return { projectId, directory, name, lastOpenedAt, registeredAt, source: options.source };
}

export function renameProject(directoryInput: string, name: string) {
  const trimmed = name.trim();
  if (!trimmed) throw Object.assign(new Error("项目名称不能为空"), { status: 400 });
  const key = directoryKey(directoryInput);
  const existing = getProjectByDirectoryKey(key);
  if (!existing) throw Object.assign(new Error("项目未登记"), { status: 404 });
  projectDb().query("UPDATE projects SET name = ? WHERE projectId = ?").run(trimmed, existing.projectId);
  return { ...existing, name: trimmed };
}

export function removeProject(directoryInput: string) {
  const key = directoryKey(directoryInput);
  const existing = getProjectByDirectoryKey(key);
  if (!existing) return null;
  projectDb().query("DELETE FROM projects WHERE projectId = ?").run(existing.projectId);
  return existing;
}

export function relocateProject(previousDirectory: string, directory: string, options: { name?: string; lastOpenedAt?: number }) {
  const previousKey = directoryKey(previousDirectory);
  const nextKey = directoryKey(directory);
  const previous = getProjectByDirectoryKey(previousKey);
  const next = getProjectByDirectoryKey(nextKey);
  if (next && previous?.projectId !== next.projectId) {
    throw Object.assign(new Error("目标目录已登记为其他项目"), { status: 409 });
  }
  const now = Date.now();
  const name = defaultName(directory, options.name ?? previous?.name);
  const lastOpenedAt = options.lastOpenedAt ?? now;
  if (previous) {
    projectDb().query("UPDATE projects SET directory = ?, directoryKey = ?, name = ?, lastOpenedAt = ? WHERE projectId = ?")
      .run(directory, nextKey, name, lastOpenedAt, previous.projectId);
    return { ...previous, directory, name, lastOpenedAt };
  }
  if (next) {
    projectDb().query("UPDATE projects SET name = ?, lastOpenedAt = ? WHERE projectId = ?").run(name, lastOpenedAt, next.projectId);
    return { ...next, name, lastOpenedAt };
  }
  return null;
}

export async function importLocalProjects(entries: { directory: string; name: string; lastOpenedAt: number }[]) {
  const imported: ProjectRecord[] = [];
  const skipped: { directory: string; reason: string }[] = [];
  for (const entry of entries) {
    try {
      const directory = await normalizeProjectDirectory(entry.directory);
      const source = await isWithinServerWorkspace(directory) ? "serverWorkspace" : "import";
      imported.push(await registerProject(directory, { name: entry.name, source, lastOpenedAt: entry.lastOpenedAt }));
    } catch (err) {
      skipped.push({ directory: entry.directory, reason: err instanceof Error ? err.message : "无法登记" });
    }
  }
  return { imported, skipped };
}

export async function registrationSourceForDirectory(directory: string) {
  return await isWithinServerWorkspace(directory) ? "serverWorkspace" : "local";
}
