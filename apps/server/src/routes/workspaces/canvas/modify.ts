import { Router } from "express";
import { z } from "zod";
import u from "@/utils";
import { validateFields } from "@/lib/middleware";
import { success } from "@/lib/responseFormat";

const item = z.record(z.string(), z.unknown()).and(z.object({ id: z.string().min(1).max(255) }));
const change = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("node"), id: z.string().min(1).max(255), expectedVersion: z.number().int().nonnegative(), dependencies: z.record(z.string(), z.number().int().nonnegative()).optional(), value: item.nullable() }),
  z.object({ kind: z.literal("edge"), id: z.string().min(1).max(255), expectedVersion: z.number().int().nonnegative(), dependencies: z.record(z.string(), z.number().int().nonnegative()).optional(), value: item.nullable() }),
  z.object({ kind: z.literal("output"), nodeId: z.string().min(1).max(255), slot: z.string().min(1).max(255), expectedVersion: z.number().int().nonnegative(), expectedNodeVersion: z.number().int().nonnegative().optional(), value: z.unknown() }),
  z.object({ kind: z.literal("viewport"), expectedVersion: z.number().int().nonnegative(), value: z.object({ x: z.number().finite(), y: z.number().finite(), zoom: z.number().positive().finite() }) }),
]);

export default Router().post("/", validateFields({
  directory: z.string().min(1).max(4096), path: z.string().min(1).max(4096),
  operationId: z.string().uuid(), changes: z.array(change).min(1).max(500),
}), async (req, res) => {
  const { path } = await u.workspaceFile.resolveWorkspaceFile(req, req.body.directory, req.body.path);
  res.set("Cache-Control", "no-store").json(success(await u.graph.modifyGraph(path, req.body.operationId, req.body.changes)));
});
