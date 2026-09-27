import axios from "axios";
import { ref, shallowRef } from "vue";
import useWorkspaceFiles, { type GraphChange, type WorkspaceGraph } from "@/lib/workspaceFiles";

export function useMobileGraph(directory: () => string, canvasPath: () => string) {
  const graph = shallowRef<WorkspaceGraph | null>(null);
  const loading = ref(false);
  const error = ref("");
  const conflict = ref<{ message: string; server?: WorkspaceGraph } | null>(null);

  async function load() {
    loading.value = true;
    error.value = "";
    conflict.value = null;
    try {
      graph.value = await useWorkspaceFiles(directory()).readGraph(canvasPath());
    } catch (err) {
      error.value = axios.isAxiosError<{ message?: string }>(err)
        ? err.response?.data.message || "读取画布失败"
        : err instanceof Error ? err.message : "读取画布失败";
      graph.value = null;
    } finally {
      loading.value = false;
    }
  }

  async function applyChanges(changes: GraphChange[]) {
    if (!graph.value) throw new Error("画布未加载");
    conflict.value = null;
    try {
      graph.value = await useWorkspaceFiles(directory()).modifyGraph(canvasPath(), changes);
      return graph.value;
    } catch (err) {
      if (axios.isAxiosError<{ message?: string }>(err) && err.response?.status === 409) {
        const message = err.response.data.message || "版本冲突";
        conflict.value = { message };
        try {
          graph.value = await useWorkspaceFiles(directory()).readGraph(canvasPath());
          conflict.value = { message, server: graph.value };
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
