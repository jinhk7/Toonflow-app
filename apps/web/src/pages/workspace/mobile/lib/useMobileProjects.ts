import axios from "axios";
import { ref } from "vue";
import type { Project } from "@/stores/workspace";

const workspaceHeaders = { "x-toonflow-workspace": "1" };

export function useMobileProjects() {
  const projects = ref<Project[]>([]);
  const loading = ref(false);
  const error = ref("");

  async function refresh() {
    loading.value = true;
    error.value = "";
    try {
      const { data } = await axios.get<{ code: number; data?: { projects: Project[] }; message?: string }>("/api/workspaces/projects/list");
      if (data.code !== 200 || !data.data?.projects) throw new Error(data.message || "读取项目列表失败");
      projects.value = data.data.projects;
    } catch (err) {
      error.value = err instanceof Error ? err.message : "读取项目列表失败";
    } finally {
      loading.value = false;
    }
  }

  async function touchOpen(directory: string, name?: string) {
    const { data } = await axios.post<{ code: number; data?: { project: Project }; message?: string }>(
      "/api/workspaces/projects/open",
      { directory, name },
      { headers: workspaceHeaders },
    );
    if (data.code !== 200 || !data.data?.project) throw new Error(data.message || "打开项目失败");
    return data.data.project;
  }

  return { projects, loading, error, refresh, touchOpen };
}
