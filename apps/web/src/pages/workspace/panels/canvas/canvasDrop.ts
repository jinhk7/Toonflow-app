import axios from "axios";
import { ElMessage } from "element-plus";
import type { useVueFlow } from "@vue-flow/core";
import type { NodeExecutionDescriptor } from "@toonflow/nodes-scaffold/execution";
import useWorkspaceFiles from "@/lib/workspaceFiles";

const assetDragType = "application/toonflow-asset";
const fileMimeTypes: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif",
  avif: "image/avif", apng: "image/apng", bmp: "image/bmp", svg: "image/svg+xml", ico: "image/x-icon",
  mp4: "video/mp4", m4v: "video/mp4", webm: "video/webm", mov: "video/quicktime", mkv: "video/x-matroska", avi: "video/x-msvideo",
  mp3: "audio/mpeg", wav: "audio/wav", ogg: "audio/ogg", opus: "audio/ogg", flac: "audio/flac", m4a: "audio/mp4", aac: "audio/aac",
  txt: "text/plain", md: "text/markdown", markdown: "text/markdown", csv: "text/csv", log: "text/plain",
  json: "application/json", xml: "application/xml", html: "text/html", css: "text/css", js: "text/javascript", ndjson: "application/x-ndjson",
};

export function startAssetDrag(event: DragEvent, entry: { type: string; path: string }) {
  if (entry.type !== "file" || !event.dataTransfer) return;
  event.dataTransfer.effectAllowed = "copy";
  event.dataTransfer.setData(assetDragType, entry.path);
}

export function isCanvasFileDrag(event: DragEvent) {
  return event.dataTransfer?.types.some(type => type === assetDragType || type === "Files") ?? false;
}

type CanvasFileContext = {
  directory: string;
  availableNodes: (NodeExecutionDescriptor & { type: string })[];
  signal: AbortSignal;
  flow: Pick<ReturnType<typeof useVueFlow>, "screenToFlowCoordinate">;
  addNode(type: string, label: string, position: { x: number; y: number }): Promise<string>;
  execute(nodeId: string, action: string, args: Record<string, unknown>, revision: string): Promise<unknown>;
};

export async function dropCanvasFiles(event: DragEvent, context: CanvasFileContext) {
  const transfer = event.dataTransfer;
  if (!transfer) return;
  const path = transfer.getData(assetDragType);
  let droppedFiles = Array.from(transfer.files);
  const { signal, flow } = context;
  const position = flow.screenToFlowCoordinate({ x: event.clientX, y: event.clientY });
  try {
    signal.throwIfAborted();
    if (path) {
      const { data } = await axios.get<Blob>("/api/assets/read", { params: { path }, responseType: "blob", signal });
      droppedFiles = [new File([data], path.split("/").pop()!, { type: data.type })];
    }
    await importCanvasFiles(droppedFiles, position, context);
  } catch (error) {
    if (!signal.aborted) showError(error);
  }
}

export async function importCanvasFiles(droppedFiles: File[], position: { x: number; y: number }, context: CanvasFileContext) {
  const { signal, availableNodes } = context;
  const files = useWorkspaceFiles(context.directory);
  for (const [index, file] of droppedFiles.entries()) {
    if (signal.aborted) break;
    try {
      const fileType = file.type.split(";")[0]!.trim().toLowerCase();
      const extension = file.name.split(".").pop()!.toLowerCase();
      const mimeType = !fileType || fileType === "application/octet-stream" ? fileMimeTypes[extension] ?? fileType : fileType;
      const kind = mimeType.startsWith("image/") ? "image" : mimeType.startsWith("audio/") ? "audio" : mimeType.startsWith("video/") ? "video"
        : mimeType.startsWith("text/") || /^application\/(json|xml|javascript|x-ndjson)$/.test(mimeType) ? "text" : undefined;
      if (!kind) throw new Error(`${file.name}：该文件类型暂不支持导入画布`);
      const dataType = kind === "text" ? "STRING" : kind.toUpperCase();
      const keys = kind === "text" ? ["text"] : ["stagedPath", "name", "mimeType"];
      // ACT: 文件拖入优先选端口较少的匹配节点；插件需同时声明对应输出和上传/正文参数，不能从节点名称猜能力。
      const candidates = availableNodes.filter(node => node.handles.some(handle => handle.type === "source" && handle.dataType === dataType))
        .flatMap(node => node.actions.filter(action => {
          const properties = action.parameters.properties as Record<string, unknown> | undefined;
          const required = action.parameters.required;
          return properties && keys.every(key => key in properties) && (!Array.isArray(required) || required.every(key => keys.includes(String(key))));
        }).map(action => ({ node, action })))
        .sort((left, right) => left.node.handles.length - right.node.handles.length || left.node.actions.length - right.node.actions.length);
      const target = candidates[0];
      if (!target) throw new Error(`${file.name}：没有启用支持此文件的后端节点动作`);
      let args: Record<string, unknown>;
      if (kind === "text") {
        args = { text: await file.text() };
      } else {
        for (const path of ["assets", "assets/uploads"]) {
          await files.mkdir(path).catch(error => { if (error?.response?.data?.data?.code !== "EEXIST") throw error; });
        }
        const stagedPath = `assets/uploads/${crypto.randomUUID()}`;
        await files.write(stagedPath, file, true, signal);
        args = { stagedPath, name: file.name, mimeType };
      }
      signal.throwIfAborted();
      const id = await context.addNode(target.node.type, file.name, { x: position.x + index * 32, y: position.y + index * 32 });
      signal.throwIfAborted();
      await context.execute(id, target.action.name, args, target.node.executionRevision);
    } catch (error) {
      // 结果未知时保留暂存文件与已创建节点，页面离开不能删掉后台可能仍在读取的输入。
      if (!signal.aborted) showError(error);
    }
  }
}

function showError(error: unknown) {
  ElMessage.error(axios.isAxiosError<{ message: string }>(error) ? error.response?.data.message || error.message : error instanceof Error ? error.message : "文件导入失败");
}
