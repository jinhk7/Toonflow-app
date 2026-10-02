import { z } from "zod";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { registerNodeJobHandler } from "@/utils/jobs";
import { getConfiguredModel, streamAi, aiReferenceSchema } from "@/utils/ai";
import { getMediaJob, waitForMediaJob } from "@/utils/media/mediaJobs";
import { writeVersionedContent } from "@/utils/canvas/content";
import { appendWorkspaceEvent, requestDigest } from "@/utils/canvas/store";
import { loadNodeExecution } from "@/utils/plugins/nodeExecution";

const textInput = z.object({
  providerId: z.string().min(1), modelId: z.string().min(1), prompt: z.string(), systemPrompt: z.string().optional(),
  references: z.array(aiReferenceSchema).max(32).optional(), path: z.string().min(1).optional(),
  expectedRevision: z.string().regex(/^[a-f0-9]{64}$/).optional(), commandId: z.string().min(1),
  nodeId: z.string().optional(), canvasPath: z.string().optional(),
  nodeType: z.string().min(1), pluginRevision: z.string().min(1), configuredRevision: z.string().min(1),
  referenceContents: z.array(z.object({ dataType: z.enum(["STRING", "IMAGE", "VIDEO"]), value: z.string() })),
});
let registered = false;

export function registerBuiltinNodeJobHandlers() {
  if (registered) return;
  registerNodeJobHandler("text", async (raw, context) => {
    const input = textInput.parse(raw);
    const configured = getConfiguredModel(input.providerId, input.modelId);
    if (requestDigest(configured) !== input.configuredRevision) throw Object.assign(new Error("文本模型配置已变化，请核对后重试"), { code: "JOB_NEEDS_REVIEW" });
    await loadNodeExecution(input.nodeType, input.pluginRevision);
    const references = input.referenceContents;
    const stream = streamAi(configured, {
      systemPrompt: input.systemPrompt ?? "",
      messages: [{ role: "user", content: input.prompt, timestamp: Date.now() }],
    }, context.signal, references);
    let text = "";
    for await (const event of stream) {
      if (event.type === "text_delta") {
        text += event.delta;
        try { appendWorkspaceEvent(context.directory, "jobChanged", { jobId: context.jobId, text }, { commandId: input.commandId, nodeId: input.nodeId, canvasId: input.canvasPath }); }
        catch (error) { console.error("文本任务进度通知失败，继续保存生成结果", error); }
      }
    }
    const result = await stream.result();
    context.signal.throwIfAborted();
    if (result.stopReason === "error" || result.stopReason === "aborted") throw new Error(result.errorMessage ?? "文本生成失败");
    text = result.content.filter(item => item.type === "text").map(item => item.text).join("");
    await writeFile(join(context.scratchDirectory, "result.md"), text, "utf8");
    context.saveResult({ text, path: input.path });
    if (input.path) {
      if (!input.expectedRevision) throw Object.assign(new Error("缺少正文版本，未覆盖文件"), { status: 409 });
      try {
        const saved = await writeVersionedContent({ directory: context.directory, path: input.path, content: text, expectedRevision: input.expectedRevision, commandId: input.commandId });
        return { text, path: input.path, revision: saved.revision };
      } catch (error) {
        if ((error as { status?: number }).status === 409) throw Object.assign(new Error("正文已变化，生成结果保留在任务中，请核对后保存"), { code: "JOB_NEEDS_REVIEW" });
        throw error;
      }
    }
    return { text };
  }, "review");
  registerNodeJobHandler("media", async (input, context) => {
    await loadNodeExecution(z.string().parse(input.nodeType), z.string().parse(input.pluginRevision));
    const mediaJobId = z.string().min(1).parse(input.mediaJobId);
    const job = getMediaJob(mediaJobId);
    if (!job || job.workspaceDirectory !== context.directory) throw Object.assign(new Error("媒体任务不存在"), { status: 404 });
    if (job.status === "unknown") throw Object.assign(new Error("媒体提交结果未知，未重新生成"), { code: "JOB_NEEDS_REVIEW" });
    try { return await waitForMediaJob(mediaJobId, { signal: context.signal }); }
    catch (error) {
      if (getMediaJob(mediaJobId)?.status === "unknown") throw Object.assign(new Error("媒体提交结果未知，原任务保留待核对"), { code: "JOB_NEEDS_REVIEW" });
      throw error;
    }
  }, "safe");
  registered = true;
}
