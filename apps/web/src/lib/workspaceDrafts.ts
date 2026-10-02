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

export function removeWorkspaceDraft(directory: string, path: string, kind: string) {
  localStorage.removeItem(draftKey(directory, path, kind));
}
