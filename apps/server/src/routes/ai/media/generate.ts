import { Router } from "express";
import { z } from "zod";
import { imageGenerationSchema, videoGenerationSchema } from "@toonflow/tool-media-generation/runtime";
import { validateFields } from "@/lib/middleware";
import { success, error } from "@/lib/responseFormat";
import u from "@/utils";
import {
  acceptMediaJob,
  getMediaJobByIdempotency,
  waitForMediaJob,
} from "@/utils/media/mediaJobs";

export default Router().post("/", validateFields({
  directory: z.string().min(1).max(4096),
  mediaType: z.enum(["image", "video"]),
  idempotencyKey: z.string().min(1).max(256).optional(),
  wait: z.boolean().optional(),
  canvasPath: z.string().min(1).max(4096).optional(),
  nodeId: z.string().min(1).max(255).optional(),
  outputSlot: z.enum(["image", "video"]).optional(),
  expectedNodeVersion: z.number().int().nonnegative().optional(),
}), async (req, res) => {
  const { directory, mediaType, idempotencyKey, wait, canvasPath, nodeId, outputSlot, expectedNodeVersion, ...request } = req.body;
  const parsed = (mediaType === "image" ? imageGenerationSchema : videoGenerationSchema).safeParse(request);
  if (!parsed.success) {
    res.status(400).json(error("参数错误", parsed.error.issues, 400));
    return;
  }
  const specified = [canvasPath, nodeId, outputSlot, expectedNodeVersion].filter(value => value !== undefined).length;
  if (specified && specified !== 4) return res.status(400).json(error("节点绑定字段必须同时提供", null, 400));
  const cwd = await u.workspace.resolveWorkspace(req, directory);
  const accepted = await acceptMediaJob({
    cwd,
    mediaType,
    request: parsed.data,
    idempotencyKey: idempotencyKey ?? crypto.randomUUID(),
    binding: specified ? { canvasPath, nodeId, outputSlot, expectedNodeVersion } : undefined,
  });
  if (accepted.kind === "conflict") {
    res.status(409).json(error("相同幂等键的请求摘要不一致", accepted.existing, 409));
    return;
  }
  if (wait === false) {
    res.status(202).json(success(accepted.job));
    return;
  }
  try {
    const files = await waitForMediaJob(accepted.job.jobId);
    if (!res.destroyed) res.json(success(files));
  } catch (err) {
    if (res.destroyed) return;
    const status = typeof err === "object" && err && "status" in err ? Number((err as { status: number }).status) : 500;
    const message = err instanceof Error ? err.message : "媒体任务失败";
    const job = typeof err === "object" && err && "job" in err ? (err as { job: unknown }).job : getMediaJobByIdempotency(cwd, accepted.job.idempotencyKey);
    res.status(status >= 400 && status < 600 ? status : 500).json(error(message, job ?? null, status >= 400 ? status : 500));
  }
});
