import axios from "axios";
import { ref, shallowRef } from "vue";
import useWorkspaceFiles, { type GraphChange, type WorkspaceGraph } from "@/lib/workspaceFiles";

export function useMobileGraph(directory: () => string, canvasPath: () => string) {
  const graph = shallowRef<WorkspaceGraph | null>(null);
  const loading = ref(false);
  const error = ref("");
  const conflict = ref<{ message: string; server?: WorkspaceGraph } | null>(null);
  let loadRevision = 0;

  async function load() {
    const revision = ++loadRevision;
    const targetDirectory = directory();
    const targetPath = canvasPath();
    const current = () => revision === loadRevision && targetDirectory === directory() && targetPath === canvasPath();
    loading.value = true;
    error.value = "";
    conflict.value = null;
    try {
      const loaded = await useWorkspaceFiles(targetDirectory).readGraph(targetPath);
      if (current()) graph.value = loaded;
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
    try {
      const updated = await useWorkspaceFiles(targetDirectory).modifyGraph(targetPath, changes);
      if (current() && (!graph.value || updated.toonflowGraph.revision >= graph.value.toonflowGraph.revision)) graph.value = updated;
      return updated;
    } catch (err) {
      if (!current()) throw err;
      if (axios.isAxiosError<{ message?: string }>(err) && err.response?.status === 409) {
        const message = err.response.data.message || "版本冲突";
        conflict.value = { message };
        try {
          const remote = await useWorkspaceFiles(targetDirectory).readGraph(targetPath);
          if (current()) {
            if (!graph.value || remote.toonflowGraph.revision >= graph.value.toonflowGraph.revision) graph.value = remote;
            conflict.value = { message, server: remote };
          }
        } catch {
          // 保留冲突提示
        }
        throw new Error(message);
      }
      throw err;
    }
  }

  return { graph, loading, error, conflict, load, applyChanges };
}
