import { isAbsolute } from "node:path";
import { normalizeProjectDirectory } from "@/utils/workspace/projects";

export async function resolveWorkspace(path: string) {
  if (!isAbsolute(path)) throw Object.assign(new Error("工作目录必须是绝对路径"), { status: 400 });
  return normalizeProjectDirectory(path);
}
