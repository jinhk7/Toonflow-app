import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import type { NodeExecutionAction, NodeExecutionContext, NodeExecutionDefinition } from "@toonflow/nodes-scaffold/execution";
import type { NodeOutput, NodeOutputs } from "@toonflow/nodes-scaffold/values";

const maxFileBytes = 100 * 1024 * 1024;
const mimeTypeSchema = z.string().regex(/^video\/[a-zA-Z0-9.+-]+$/);
const setFileSchema = z.strictObject({
  path: z.string().min(1).max(4096),
  mimeType: mimeTypeSchema,
  expectedOutput: z.json().optional().meta({ default: null }),
});
const uploadFileSchema = z.strictObject({
  name: z.string().min(1).max(255),
  mimeType: mimeTypeSchema,
  stagedPath: z.string().max(4096).regex(/^assets\/uploads\/[a-zA-Z0-9.-]+$/),
});

async function setOutput(path: string, mimeType: string, context: NodeExecutionContext) {
  const output: NodeOutput = { dataType: "VIDEO", value: { url: path, mimeType } };
  await context.setOutput("video", output);
  return { ...output, nodeVersion: context.node.version };
}

const setFile: NodeExecutionAction<typeof setFileSchema> = {
  name: "setVideo",
  snapshotInputs: false,
  description: "选择工作区内已有的视频文件作为此节点的输出，path 使用工作区相对路径",
  editor: { label: "视频素材", values: { path: { node: "data.outputs.video.value.url" }, mimeType: { node: "data.outputs.video.value.mimeType" }, expectedOutput: { node: "data.outputs.video" } }, fields: { path: { label: "工作区视频路径" }, mimeType: { label: "媒体类型" }, expectedOutput: { hidden: true } } },
  parameters: setFileSchema,
  async execute({ path, mimeType, expectedOutput }, context) {
    context.signal.throwIfAborted();
    if (expectedOutput !== undefined && !isDeepStrictEqual(expectedOutput, (context.node.data.outputs as NodeOutputs | undefined)?.video ?? null)) throw Object.assign(new Error("视频输出已被其他操作修改，请保留草稿并核对当前输出"), { status: 409 });
    if (typeof context.node.data.exportProgress === "number") throw new Error("视频正在导出，请完成后再替换输出");
    const content = await context.read(path);
    context.signal.throwIfAborted();
    if (!content.byteLength || content.byteLength > maxFileBytes) throw new Error("视频不能为空且不能超过 100 MB");
    return setOutput(path, mimeType, context);
  },
};

const uploadFile: NodeExecutionAction<typeof uploadFileSchema> = {
  name: "uploadVideo",
  snapshotInputs: false,
  description: "读取工作区暂存的视频文件并设置此节点的输出",
  parameters: uploadFileSchema,
  async execute({ stagedPath, name, mimeType }, context) {
    context.signal.throwIfAborted();
    if (typeof context.node.data.exportProgress === "number") throw new Error("视频正在导出，请完成后再替换输出");
    if (!context.node.id || /[\\/]/.test(context.node.id) || context.node.id === "." || context.node.id === "..") throw new Error("节点 ID 不能作为文件夹名称");
    const bytes = await context.read(stagedPath);
    context.signal.throwIfAborted();
    if (!bytes.byteLength || bytes.byteLength > maxFileBytes) throw new Error("视频不能为空且不能超过 100 MB");
    const extension = name.match(/\.[a-zA-Z0-9]{1,10}$/)?.[0].toLowerCase() ?? "";
    const fileId = createHash("sha256").update(context.commandId).digest("hex");
    const path = `assets/${context.node.id}/${fileId}${extension}`;
    // ACT: 同一受理命令使用固定路径，复制节点仍引用的旧素材保留。
    await context.write(path, bytes);
    context.signal.throwIfAborted();
    return setOutput(path, mimeType, context);
  },
};

export default {
  protocolVersion: 2,
  name: "videoNode",
  stateVersion: 1,
  handles: [{ id: "video", type: "source", dataType: "VIDEO", label: "视频输出" }],
  defaultData: { label: "视频" },
  layoutSize: { width: 258, height: 162 },
  actions: [setFile, uploadFile],
} satisfies NodeExecutionDefinition;
