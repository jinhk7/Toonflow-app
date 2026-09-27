import type { Request } from "express";
import { isAbsolute } from "node:path";
import { isRegisteredProjectDirectory, normalizeProjectDirectory } from "@/utils/workspace/projects";

export function isSameAppOrigin(req: Request) {
  const origin = req.get("origin");
  const localOrigin = `${req.protocol}://${req.get("host")}`;
  if (origin === undefined) return req.get("referer")?.startsWith(`${localOrigin}/`) ?? false;
  return origin === localOrigin;
}

export function isLocalWorkspaceRequest(req: Request) {
  const localAddress = ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(req.socket.remoteAddress ?? "") && req.get("x-toonflow-local-client") !== "0";
  const localHost = ["localhost", "127.0.0.1", "[::1]"].includes(req.hostname);
  return localAddress && localHost && isSameAppOrigin(req) && req.get("x-toonflow-workspace") === "1";
}


export async function resolveWorkspace(req: Request, path: string) {
  if (!isAbsolute(path)) throw Object.assign(new Error("工作目录必须是绝对路径"), { status: 400 });
  const directory = await normalizeProjectDirectory(path);
  const localWorkspace = ["win32", "darwin"].includes(process.platform) && (process.env.NODE_ENV === "dev" || process.env.toonflowDesktop === "1");
  if (localWorkspace && isLocalWorkspaceRequest(req)) return directory;

  if (!isSameAppOrigin(req)) {
    throw Object.assign(new Error("页面来源与服务地址不一致"), { status: 403 });
  }

  if (await isRegisteredProjectDirectory(directory)) return directory;

  throw Object.assign(new Error("只能访问已登记项目"), { status: 403 });
}
