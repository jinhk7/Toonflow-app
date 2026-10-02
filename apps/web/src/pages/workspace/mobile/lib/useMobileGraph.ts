import axios from "axios";
import { ref, shallowRef } from "vue";
import useWorkspaceFiles, { type GraphChange, type WorkspaceGraph } from "@/lib/workspaceFiles";
import { useWorkspaceEvents } from "@/lib/workspaceEvents";
import { readWorkspaceDraft, removeWorkspaceDraft, saveWorkspaceDraft } from "@/lib/workspaceDrafts";

export function useMobileGraph(directory: () => string, canvasPath: () => string) {
  const graph = shallowRef<WorkspaceGraph | null>(null);
  const loading = ref(false);
  const error = ref("");
  const conflict = ref<{ message: string; server?: WorkspaceGraph; changes?: GraphChange[] } | null>(null);
  let loadRevision = 0;

  async function load() {
    const revision = ++loadRevision;
    const targetDirectory = directory();
    const targetPath = canvasPath();
    if (!targetDirectory || !targetPath) { graph.value = null; loading.value = false; return; }
    const current = () => revision === loadRevision && targetDirectory === directory() && targetPath === canvasPath();
    loading.value = true;
    error.value = "";
    try {
      const loaded = await useWorkspaceFiles(targetDirectory).readGraph(targetPath);
      if (current()) {
        graph.value = loaded;
        const draft = readWorkspaceDraft<{ changes: GraphChange[] }>(targetDirectory, targetPath, "graphChanges");
        if (draft && Array.isArray(draft.changes)) conflict.value = { message: "本地未提交修改已保留，可查看草稿后重新操作", server: loaded, changes: draft.changes };
      }
    } catch (err) {
      if (!current()) return;
      error.value = axios.isAxiosError<{ message?: string }>(err)
        ? err.response?.data.message || "读取画布失败"
        : err instanceof Error ? err.message : "读取画布失败";
      graph.value = null;
    } finally {
      if (current()) loading.value = false;
    }
  }

  async function applyChanges(changes: GraphChange[]) {
    if (!graph.value) throw new Error("画布未加载");
    const targetDirectory = directory();
    const targetPath = canvasPath();
    const current = () => targetDirectory === directory() && targetPath === canvasPath();
    conflict.value = null;
    const draft = { changes: JSON.parse(JSON.stringify(changes)) as GraphChange[], operationId: crypto.randomUUID() };
    saveWorkspaceDraft(targetDirectory, targetPath, "graphChanges", draft);
    try {
      const updated = await useWorkspaceFiles(targetDirectory).modifyGraph(targetPath, draft.changes, draft.operationId);
      if (readWorkspaceDraft<{ operationId: string }>(targetDirectory, targetPath, "graphChanges")?.operationId === draft.operationId) removeWorkspaceDraft(targetDirectory, targetPath, "graphChanges");
      if (current() && (!graph.value || updated.toonflowGraph.revision >= graph.value.toonflowGraph.revision)) graph.value = updated;
      return updated;
    } catch (err) {
      if (!current()) throw err;
      if (axios.isAxiosError<{ message?: string }>(err) && err.response?.status === 409) {
        const message = err.response.data.message || "版本冲突";
        conflict.value = { message: `${message}；本地修改草稿已保留`, changes: draft.changes };
        try {
          const remote = await useWorkspaceFiles(targetDirectory).readGraph(targetPath);
          if (current()) {
            if (!graph.value || remote.toonflowGraph.revision >= graph.value.toonflowGraph.revision) graph.value = remote;
            conflict.value = { message: `${message}；本地修改草稿已保留`, server: remote, changes: draft.changes };
          }
        } catch {
          // 保留冲突提示
        }
        throw new Error(message);
      }
      conflict.value = { message: "保存结果待确认，本地修改草稿已保留", changes: draft.changes };
      throw err;
    }
  }

  const events = useWorkspaceEvents({
    directory,
    context: canvasPath,
    refresh: load,
    cursor: () => graph.value?.cursor ?? 0,
    receive: async event => {
      if (event.type === "graphChanged" && (!event.canvasId || event.canvasId === canvasPath())) await load();
    },
  });
  return { graph, loading, error, conflict, load, applyChanges, connectionError: events.error };
}
