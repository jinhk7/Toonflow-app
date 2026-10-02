import { onScopeDispose, ref, watch } from "vue";
import { createExecutionClient } from "@toonflow/nodes-scaffold/runtime";
import type { WorkspaceEvent } from "@toonflow/nodes-scaffold/execution";

export function useWorkspaceEvents(options: {
  directory(): string | undefined;
  context?(): string;
  refresh(): Promise<void | boolean>;
  cursor?(): number;
  receive(event: WorkspaceEvent): void | boolean | Promise<void | boolean>;
}) {
  const error = ref("");
  let connection: AbortController | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;
  let cursor = 0;
  let binding = "";

  async function recover() {
    clearTimeout(timer);
    connection?.abort();
    const directory = options.directory();
    if (disposed || document.hidden || !directory) return;
    const nextBinding = JSON.stringify([directory, options.context?.()]);
    if (nextBinding !== binding) { cursor = 0; binding = nextBinding; }
    const current = new AbortController();
    connection = current;
    try {
      const refreshed = await options.refresh();
      current.signal.throwIfAborted();
      if (refreshed === false) throw new Error("画布正在忙碌，等待尾随同步");
      cursor = Math.max(cursor, options.cursor?.() ?? 0);
      error.value = "";
      await createExecutionClient(directory).subscribe(cursor, async event => {
        current.signal.throwIfAborted();
        const received = await options.receive(event);
        current.signal.throwIfAborted();
        if (received === false) throw new Error("画布正在忙碌，事件待确认");
        cursor = Math.max(cursor, event.seq);
      }, current.signal);
    } catch (reason) {
      if (!current.signal.aborted) error.value = reason instanceof Error ? reason.message : "后台连接中断，正在重连";
    } finally {
      if (!disposed && !current.signal.aborted) timer = setTimeout(() => { void recover(); }, 3000);
    }
  }
  watch(() => [options.directory(), options.context?.()], () => { void recover(); }, { immediate: true });
  const restore = () => { void recover(); };
  document.addEventListener("visibilitychange", restore);
  window.addEventListener("online", restore);
  window.addEventListener("pageshow", restore);
  onScopeDispose(() => {
    disposed = true;
    clearTimeout(timer);
    connection?.abort();
    document.removeEventListener("visibilitychange", restore);
    window.removeEventListener("online", restore);
    window.removeEventListener("pageshow", restore);
  });
  return { error, recover };
}
