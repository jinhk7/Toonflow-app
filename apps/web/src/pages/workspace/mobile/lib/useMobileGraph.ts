import axios from "axios";
import { onScopeDispose, ref, shallowRef, watch } from "vue";
import useWorkspaceFiles, { graphValueJson, type GraphChange, type WorkspaceGraph } from "@/lib/workspaceFiles";
import { useWorkspaceEvents } from "@/lib/workspaceEvents";
import { readWorkspaceDraft, removeWorkspaceDraft, saveWorkspaceDraft } from "@/lib/workspaceDrafts";

export function useMobileGraph(directory: () => string, canvasPath: () => string) {
  const graph = shallowRef<WorkspaceGraph | null>(null);
  const loading = ref(false);
  const error = ref("");
  const conflict = ref<{ message: string; server?: WorkspaceGraph; changes?: GraphChange[] } | null>(null);
  let loadRevision = 0;
  let latestLoad: { revision: number; directory: string; path: string; task: Promise<boolean> } | undefined;
  const lifetime = new AbortController();

  function setGraph(loaded: WorkspaceGraph) {
    const previous = graph.value;
    if (previous?.toonflowGraph.id === loaded.toonflowGraph.id) {
      if (loaded.toonflowGraph.revision < previous.toonflowGraph.revision) return;
      const nodes = new Map(previous.nodes.map(node => [node.id, node]));
      const edges = new Map(previous.edges.map(edge => [edge.id, edge]));
      loaded.nodes = loaded.nodes.map(node => graphValueJson(nodes.get(node.id)) === graphValueJson(node) ? nodes.get(node.id)! : node);
      loaded.edges = loaded.edges.map(edge => graphValueJson(edges.get(edge.id)) === graphValueJson(edge) ? edges.get(edge.id)! : edge);
      if (graphValueJson({ ...previous, cursor: undefined }) === graphValueJson({ ...loaded, cursor: undefined })) {
        previous.cursor = Math.max(previous.cursor ?? 0, loaded.cursor ?? 0);
        return;
      }
    }
    graph.value = loaded;
  }

  watch(() => JSON.stringify([directory(), canvasPath()]), () => {
    loadRevision++;
    graph.value = null;
    conflict.value = null;
    error.value = "";
  }, { flush: "sync" });
  onScopeDispose(() => { lifetime.abort(); loadRevision++; });

  function load(signal?: AbortSignal) {
    const task = readGraph(signal);
    latestLoad = { revision: loadRevision, directory: directory(), path: canvasPath(), task };
    return task;
  }

  async function readGraph(signal?: AbortSignal): Promise<boolean> {
    const revision = ++loadRevision;
    const targetDirectory = directory();
    const targetPath = canvasPath();
    if (!targetDirectory || !targetPath) { graph.value = null; loading.value = false; return true; }
    const currentSignal = signal ? AbortSignal.any([signal, lifetime.signal]) : lifetime.signal;
    const current = () => !currentSignal.aborted && revision === loadRevision && targetDirectory === directory() && targetPath === canvasPath();
    const newer = () => !currentSignal.aborted && latestLoad && latestLoad.revision > revision && latestLoad.directory === targetDirectory && latestLoad.path === targetPath && targetDirectory === directory() && targetPath === canvasPath() ? latestLoad.task : false;
    loading.value = !graph.value;
    error.value = "";
    try {
      const loaded = await useWorkspaceFiles(targetDirectory).readGraph(targetPath, currentSignal);
      if (current()) {
        setGraph(loaded);
        const draft = readWorkspaceDraft<{ changes: GraphChange[] }>(targetDirectory, targetPath, "graphChanges");
        if (draft && Array.isArray(draft.changes)) conflict.value = { message: "本地未提交修改已保留，可查看草稿后重新操作", server: loaded, changes: draft.changes };
        return true;
      }
      return newer();
    } catch (err) {
      if (!current()) return newer();
      error.value = axios.isAxiosError<{ message?: string }>(err)
        ? err.response?.data.message || "读取画布失败"
        : err instanceof Error ? err.message : "读取画布失败";
      return false;
    } finally {
      if (current()) loading.value = false;
    }
  }

  async function applyChanges(changes: GraphChange[]) {
    if (!graph.value) throw new Error("画布未加载");
    const targetDirectory = directory();
    const targetPath = canvasPath();
    const current = () => !lifetime.signal.aborted && targetDirectory === directory() && targetPath === canvasPath();
    conflict.value = null;
    const draft = { changes: JSON.parse(JSON.stringify(changes)) as GraphChange[], operationId: crypto.randomUUID() };
    saveWorkspaceDraft(targetDirectory, targetPath, "graphChanges", draft);
    try {
      const updated = await useWorkspaceFiles(targetDirectory).modifyGraph(targetPath, draft.changes, draft.operationId);
      if (readWorkspaceDraft<{ operationId: string }>(targetDirectory, targetPath, "graphChanges")?.operationId === draft.operationId) removeWorkspaceDraft(targetDirectory, targetPath, "graphChanges");
      if (current()) setGraph(updated);
      return updated;
    } catch (err) {
      if (!current()) throw err;
      if (axios.isAxiosError<{ message?: string }>(err) && err.response?.status === 409) {
        const message = err.response.data.message || "版本冲突";
        conflict.value = { message: `${message}；本地修改草稿已保留`, changes: draft.changes };
        try {
          const remote = await useWorkspaceFiles(targetDirectory).readGraph(targetPath);
          if (current()) {
            setGraph(remote);
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
    directory: () => canvasPath() ? directory() : undefined,
    context: canvasPath,
    refresh: load,
    cursor: () => graph.value?.cursor ?? 0,
    receive: async (event, signal) => {
      if (event.type === "graphChanged" && (!event.canvasId || event.canvasId === canvasPath())) return load(signal);
    },
  });
  return { graph, loading, error, conflict, load, applyChanges, connectionError: events.error };
}
