function draftKey(directory: string, path: string, kind: string) {
  return `toonflow.draft.${JSON.stringify([directory, path, kind])}`;
}

export function saveWorkspaceDraft(directory: string, path: string, kind: string, value: unknown) {
  localStorage.setItem(draftKey(directory, path, kind), JSON.stringify(value));
}

export function readWorkspaceDraft<T>(directory: string, path: string, kind: string): T | undefined {
  const value = localStorage.getItem(draftKey(directory, path, kind));
  if (!value) return;
  try { return JSON.parse(value) as T; } catch { throw new Error("本地草稿无法读取，请先导出保留原数据"); }
}

export function readWorkspaceDrafts<T>(directory: string, path: string, kindPrefix: string): { kind: string; value: T }[] {
  const drafts: { kind: string; value: T }[] = [];
  for (let index = 0; index < localStorage.length; index++) {
    const key = localStorage.key(index);
    if (!key?.startsWith("toonflow.draft.")) continue;
    let parts: unknown;
    try { parts = JSON.parse(key.slice("toonflow.draft.".length)); } catch { continue; }
    if (!Array.isArray(parts) || parts[0] !== directory || parts[1] !== path || typeof parts[2] !== "string" || !parts[2].startsWith(kindPrefix)) continue;
    const value = readWorkspaceDraft<T>(directory, path, parts[2]);
    if (value !== undefined) drafts.push({ kind: parts[2], value });
  }
  return drafts;
}

export function removeWorkspaceDraft(directory: string, path: string, kind: string) {
  localStorage.removeItem(draftKey(directory, path, kind));
}
