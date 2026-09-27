import useWorkspaceFiles from "@/lib/workspaceFiles";
import { isCanvasFile } from "@/pages/workspace/canvasFile";

export type MobileCanvas = { id: string; name: string };

export async function listProjectCanvases(directory: string): Promise<MobileCanvas[]> {
  const files = useWorkspaceFiles(directory);
  const { entries } = await files.list();
  const loaded = await Promise.all(
    entries
      .filter(entry => entry.type === "file" && /\.json$/i.test(entry.name))
      .map(async entry => {
        if (!(await isCanvasFile(files, entry.path))) return null;
        return { id: entry.path, name: entry.name.slice(0, -5) };
      }),
  );
  return loaded
    .filter((canvas): canvas is MobileCanvas => canvas !== null)
    .sort((left, right) => left.name.localeCompare(right.name, "zh-CN", { numeric: true }));
}
