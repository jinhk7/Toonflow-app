import { Router } from "express";
import { z } from "zod";
import { validateFields } from "@/lib/middleware";
import { success } from "@/lib/responseFormat";
import { agentInputSchema } from "@/agent/runtime/input";
import { acceptAgentRun } from "@/agent/runtime/runHost";
import u from "@/utils";

const inputSchema = agentInputSchema.extend({ clientMessageId: z.string().min(1).max(128) });

export default Router().post("/", validateFields(inputSchema.shape), async (req, res) => {
  const { directory, ...input } = inputSchema.parse(req.body);
  const cwd = await u.workspace.resolveWorkspace(directory);
  const accepted = await acceptAgentRun({ ...input, cwd });
  res.status(accepted.duplicate ? 200 : 202).json(success(accepted));
});
