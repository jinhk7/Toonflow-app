import { defineStore } from "pinia";
import { ref } from "vue";
import axios from "axios";


export type Project = {
  projectId?: string;
  directory: string;
  name: string;
  lastOpenedAt: number;
  status?: "ok" | "missing";
  message?: string;
};

function readLegacyProjectList(): Project[] {
  try {
    const raw = localStorage.getItem("toonflow.projectList");
    if (!raw) return [];
    const parsed = JSON.parse(raw) as { projectList?: Project[] };
    return Array.isArray(parsed.projectList) ? parsed.projectList : [];
  } catch {
    return [];
  }
}

export const useWorkspaceStore = defineStore("workspace", () => {
  const project = ref<Project | null>(null);
  const projectList = ref<Project[]>([]);
  const pendingAgentMessage = ref<{ directory: string; prompt: string; model: string; reasoningEffort: string } | null>(null);
  let importAttempted = false;

  async function refreshProjectList() {
    const { data } = await axios.get<{ code: number; data?: { projects: Project[] }; message?: string }>("/api/workspaces/projects/list");
    if (data.code !== 200 || !data.data?.projects) throw new Error(data.message || "读取项目列表失败");
    projectList.value = data.data.projects;
    if (project.value) {
      const current = projectList.value.find(item => item.directory === project.value?.directory);
      if (current) project.value = current;
    }
  }

  async function importLegacyProjectListIfNeeded() {
    if (importAttempted) return;
    importAttempted = true;
    const legacy = readLegacyProjectList();
    if (!legacy.length) return;
    try {
      await axios.post("/api/workspaces/projects/importLocal", { projects: legacy });
    } catch {
      // ACT: 导入失败不阻塞首页，仍由服务端列表作为权威来源。
    }
  }

  async function ensureProjectList() {
    await importLegacyProjectListIfNeeded();
    await refreshProjectList();
  }

  async function openProject(path: string, previousDirectory = path, signal?: AbortSignal) {
    const { data: check } = await axios.get<{ code: number; data?: { directory: string }; message?: string }>("/api/workspaces/check", {
      params: { directory: path }, signal,
    });
    signal?.throwIfAborted();
    if (check.code !== 200 || !check.data?.directory) throw new Error(check.message || "工作目录校验失败");
    const checkedDirectory = check.data.directory;
    const existing = projectList.value.find(item => item.directory === previousDirectory)
      ?? projectList.value.find(item => item.directory === checkedDirectory);
    const { data: opened } = await axios.post<{ code: number; data?: { project: Project }; message?: string }>("/api/workspaces/projects/open", {
      directory: checkedDirectory,
      previousDirectory: previousDirectory !== checkedDirectory ? previousDirectory : undefined,
      name: existing?.name,
    }, { signal });
    signal?.throwIfAborted();
    if (opened.code !== 200 || !opened.data?.project) throw new Error(opened.message || "登记项目失败");
    pendingAgentMessage.value = null;
    project.value = opened.data.project;
    await refreshProjectList();
  }

  async function renameProject(path: string, name: string) {
    const trimmed = name.trim();
    if (!trimmed) return;
    const { data } = await axios.put<{ code: number; data?: { project: Project }; message?: string }>("/api/workspaces/projects/rename", {
      directory: path,
      name: trimmed,
    });
    if (data.code !== 200 || !data.data?.project) throw new Error(data.message || "重命名失败");
    const target = data.data.project;
    const index = projectList.value.findIndex(item => item.directory === path);
    if (index >= 0) projectList.value[index] = { ...projectList.value[index], ...target };
    if (project.value?.directory === path) project.value = target;
  }

  async function removeProject(path: string) {
    const { data } = await axios.delete<{ code: number; message?: string }>("/api/workspaces/projects/remove", {
      data: { directory: path },
    });
    if (data.code !== 200) throw new Error(data.message || "移除项目失败");
    projectList.value = projectList.value.filter(item => item.directory !== path);
    if (project.value?.directory === path) project.value = null;
  }

  return { project, projectList, pendingAgentMessage, ensureProjectList, refreshProjectList, openProject, renameProject, removeProject };
}, {
  persist: {
    key: "toonflow.projectList",
    storage: localStorage,
    pick: ["project"],
  },
});
