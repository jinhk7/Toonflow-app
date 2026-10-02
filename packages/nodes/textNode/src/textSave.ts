import { reactive } from "vue";

type TextSnapshot = { content: string; revision: string };
type TextWrite = { content: string; expectedRevision: string; commandId: string };
type TextDraft = { content: string; revision: string; pending?: TextWrite; conflict: boolean };

export function createTextSave(options: {
  directory: string;
  path: string;
  read(): Promise<TextSnapshot>;
  write(request: TextWrite): Promise<{ revision: string }>;
}) {
  const key = `toonflow.textDraft.${JSON.stringify([options.directory, options.path])}`;
  const state = reactive({ content: "", savedText: "", revision: "", dirty: false, saving: false, error: "", conflict: false, remote: undefined as TextSnapshot | undefined });
  // ACT: 保留一个待确认写入和最新草稿；先对账原命令，再使用确认版本保存后续编辑。
  let pending: TextWrite | undefined;
  let running: Promise<void> | undefined;

  function persist() {
    if (!state.dirty && !pending) { localStorage.removeItem(key); return; }
    localStorage.setItem(key, JSON.stringify({ content: state.content, revision: state.revision, pending, conflict: state.conflict } satisfies TextDraft));
  }
  function load(snapshot: TextSnapshot) {
    state.content = state.savedText = snapshot.content;
    state.revision = snapshot.revision;
    const raw = localStorage.getItem(key);
    if (!raw) return;
    const draft: TextDraft = JSON.parse(raw);
    if (!draft || typeof draft !== "object" || typeof draft.content !== "string" || typeof draft.revision !== "string" || !/^[a-f0-9]{64}$/.test(draft.revision)
      || draft.pending && (typeof draft.pending.content !== "string" || typeof draft.pending.expectedRevision !== "string" || !/^[a-f0-9]{64}$/.test(draft.pending.expectedRevision) || typeof draft.pending.commandId !== "string" || !draft.pending.commandId)) throw new Error("正文草稿格式无效，原数据已保留");
    state.content = draft.content;
    state.revision = draft.revision;
    pending = draft.pending;
    state.conflict = draft.conflict === true;
    state.remote = snapshot;
    state.dirty = true;
    state.error = "已恢复未提交正文，请先对账原保存";
  }
  function refresh(snapshot: TextSnapshot) {
    if (state.dirty || pending || state.saving) return;
    state.content = state.savedText = snapshot.content;
    state.revision = snapshot.revision;
  }
  function flush(): Promise<void> {
    if (running) return running;
    if (state.error) return Promise.reject(new Error(state.error));
    running = (async () => {
      state.saving = true;
      try {
        while (state.dirty) {
          const request = pending ??= { content: state.content, expectedRevision: state.revision, commandId: crypto.randomUUID() };
          persist();
          const receipt = await options.write(request);
          const current = await options.read();
          state.remote = current;
          state.savedText = current.content;
          if (current.revision !== receipt.revision) throw Object.assign(new Error("原保存已受理，但远端正文随后改变；草稿已保留，请核对冲突"), { status: 409 });
          state.revision = receipt.revision;
          pending = undefined;
          state.dirty = state.content !== request.content;
          state.error = "";
          state.conflict = false;
          persist();
        }
      } catch (error) {
        state.error = error instanceof Error ? error.message : "正文保存结果待确认";
        state.conflict = typeof error === "object" && error !== null && "status" in error && error.status === 409;
        persist();
        throw error;
      } finally { state.saving = false; }
    })().finally(() => { running = undefined; });
    return running;
  }
  function update(content: string) {
    state.content = content;
    state.dirty = !!pending || content !== state.savedText;
    persist();
    return state.error ? Promise.resolve() : flush();
  }
  function retry() {
    state.error = "";
    state.conflict = false;
    return flush();
  }
  function resolveConflict(snapshot: TextSnapshot, content: string) {
    if (!state.conflict || state.saving) throw new Error("请先对账原保存，确认版本冲突后再处理");
    state.remote = snapshot;
    state.savedText = snapshot.content;
    state.revision = snapshot.revision;
    state.content = content;
    state.dirty = content !== snapshot.content;
    pending = undefined;
    state.error = "";
    state.conflict = false;
    persist();
    return flush();
  }

  return { state, load, refresh, update, flush, retry, resolveConflict };
}
