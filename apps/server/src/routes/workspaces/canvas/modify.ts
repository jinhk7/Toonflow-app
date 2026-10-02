import { Router } from "express";
import { z } from "zod";
import u from "@/utils";
import { validateFields } from "@/lib/middleware";
import { success } from "@/lib/responseFormat";

const item = z.record(z.string(), z.unknown()).and(z.object({ id: z.string().min(1).max(255) }));
const change = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("node"), id: z.string().min(1).max(255), expectedVersion: z.number().int().nonnegative(), dependencies: z.record(z.string(), z.number().int().nonnegative()).optional(), value: item.nullable() }),
  z.object({ kind: z.literal("edge"), id: z.string().min(1).max(255), expectedVersion: z.number().int().nonnegative(), dependencies: z.record(z.string(), z.number().int().nonnegative()).optional(), value: item.nullable() }),
  z.object({ kind: z.literal("output"), nodeId: z.string().min(1).max(255), slot: z.string().min(1).max(255), expectedVersion: z.number().int().nonnegative(), value: z.unknown() }),
  z.object({ kind: z.literal("viewport"), expectedVersion: z.number().int().nonnegative(), value: z.object({ x: z.number().finite(), y: z.number().finite(), zoom: z.number().positive().finite() }) }),
]);

export default Router().post("/", validateFields({
  directory: z.string().min(1).max(4096), path: z.string().min(1).max(4096),
  operationId: z.string().uuid(), changes: z.array(change).min(1).max(500),
}), async (req, res) => {
  if (req.header("X-Toonflow-Protocol") !== "2") throw Object.assign(new Error("画布执行协议已升级，请刷新客户端"), { status: 428 });
  res.set("Cache-Control", "no-store").json(success(await u.canvasLifecycle.modifyCanvas(req.body.directory, req.body.path, req.body.operationId, req.body.changes)));
});
