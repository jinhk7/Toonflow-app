import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import type { NodeExecutionAction, NodeExecutionContext, NodeExecutionDefinition } from "@toonflow/nodes-scaffold/execution";
import type { NodeOutput, NodeOutputs } from "@toonflow/nodes-scaffold/values";

const maxFileBytes = 100 * 1024 * 1024;
const mimeTypeSchema = z.string().regex(/^audio\/[a-zA-Z0-9.+-]+$/);
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
  const output: NodeOutput = { dataType: "AUDIO", value: { url: path, mimeType } };
  await context.setOutput("audio", output);
  return { ...output, nodeVersion: context.node.version };
}

const setFile: NodeExecutionAction<typeof setFileSchema> = {
  name: "setAudio",
  snapshotInputs: false,
  description: "选择工作区内已有的音频文件作为此节点的输出，path 使用工作区相对路径",
  editor: { label: "音频素材", values: { path: { node: "data.outputs.audio.value.url" }, mimeType: { node: "data.outputs.audio.value.mimeType" }, expectedOutput: { node: "data.outputs.audio" } }, fields: { path: { label: "工作区音频路径" }, mimeType: { label: "媒体类型" }, expectedOutput: { hidden: true } } },
  parameters: setFileSchema,
  async execute({ path, mimeType, expectedOutput }, context) {
    context.signal.throwIfAborted();
    if (expectedOutput !== undefined && !isDeepStrictEqual(expectedOutput, (context.node.data.outputs as NodeOutputs | undefined)?.audio ?? null)) throw Object.assign(new Error("音频输出已被其他操作修改，请保留草稿并核对当前输出"), { status: 409 });
    const content = await context.read(path);
    context.signal.throwIfAborted();
    if (!content.byteLength || content.byteLength > maxFileBytes) throw new Error("音频不能为空且不能超过 100 MB");
    return setOutput(path, mimeType, context);
  },
};

const uploadFile: NodeExecutionAction<typeof uploadFileSchema> = {
  name: "uploadAudio",
  snapshotInputs: false,
  description: "读取工作区暂存的音频文件并设置此节点的输出",
  parameters: uploadFileSchema,
  async execute({ stagedPath, name, mimeType }, context) {
    context.signal.throwIfAborted();
    if (!context.node.id || /[\\/]/.test(context.node.id) || context.node.id === "." || context.node.id === "..") throw new Error("节点 ID 不能作为文件夹名称");
    const bytes = await context.read(stagedPath);
    context.signal.throwIfAborted();
    if (!bytes.byteLength || bytes.byteLength > maxFileBytes) throw new Error("音频不能为空且不能超过 100 MB");
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
  name: "audioNode",
  stateVersion: 1,
  handles: [{ id: "audio", type: "source", dataType: "AUDIO", label: "音频输出" }],
  defaultData: { label: "音频" },
  layoutSize: { width: 320, height: 162 },
  actions: [setFile, uploadFile],
} satisfies NodeExecutionDefinition;
