import { z } from "zod";
import { agentAttachmentsSchema } from "@/agent/runtime/sessions";
import { agentMentionsSchema } from "@/agent/runtime/mentions";

export const agentCanvasTargetSchema = z.object({
  id: z.string().min(1).max(4096).optional(),
  canvasPath: z.string().min(1).max(4096).optional(),
  selectedNodeIds: z.array(z.string().min(1).max(256)).max(1000).optional(),
  // 兼容旧请求的字段；服务端从实际插件注册表取得工具，不执行客户端定义。
  tools: z.array(z.unknown()).max(1000).optional(),
});

export const agentInputSchema = z.object({
  prompt: z.string().trim().max(1000000),
  directory: z.string().min(1).max(4096),
  clientMessageId: z.string().min(1).max(128).optional(),
  clientId: z.string().min(1).max(128).optional(),
  attachments: agentAttachmentsSchema.optional(),
  mentions: agentMentionsSchema.optional(),
  providerId: z.string().min(1),
  modelId: z.string().min(1),
  thinkingLevel: z.enum(["off", "low", "medium", "high"]).optional(),
  sessionFile: z.string().regex(/^[\w-]+\.jsonl$/).optional(),
  resendFrom: z.string().min(1).max(128).optional(),
  canvas: agentCanvasTargetSchema.optional(),
});

export type AgentCanvasTarget = Omit<z.infer<typeof agentCanvasTargetSchema>, "tools">;
