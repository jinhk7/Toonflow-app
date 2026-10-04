import type { AgentEvent } from "@toonflow/server/agent/types";
import { readAgentEvents } from "./replyStream";
import { executionRequest, ExecutionRequestError } from "@toonflow/nodes-scaffold/runtime";
import type { AgentMention } from "@toonflow/server/agent/types";

export type AgentAcceptInput = {
  clientMessageId: string;
  clientId?: string;
  directory: string;
  prompt: string;
  providerId: string;
  modelId: string;
  thinkingLevel?: string;
  sessionFile?: string;
  resendFrom?: string;
  mentions: AgentMention[];
  attachments: { name: string; path: string; mimeType: string }[];
  canvas?: { id: string; selectedNodeIds?: string[]; tools?: unknown[] };
};
export type AgentAcceptResult = { clientMessageId: string; runId: string; sessionFile: string; duplicate?: boolean };
const pendingPrefix = "toonflow.pendingAgent.";

export function pendingAgentMessages(directory: string, sessionFile?: string) {
  const pending: AgentAcceptInput[] = [];
  for (let index = 0; index < localStorage.length; index++) {
    const key = localStorage.key(index);
    if (!key?.startsWith(pendingPrefix)) continue;
    try {
      const input = JSON.parse(localStorage.getItem(key) ?? "null") as AgentAcceptInput | null;
      if (input?.directory === directory && input.sessionFile === sessionFile && typeof input.clientMessageId === "string") pending.push(input);
    } catch { /* 损坏的草稿不会变成新的提交 */ }
  }
  return pending;
}

export function clearPendingAgentMessage(clientMessageId: string) { localStorage.removeItem(`${pendingPrefix}${clientMessageId}`); }

export async function getAcceptedAgentMessage(directory: string, clientMessageId: string, signal?: AbortSignal) {
  try {
    const accepted = await executionRequest<AgentAcceptResult | null>(`/api/agent/accept/get?${new URLSearchParams({ directory, clientMessageId })}`, { signal });
    if (accepted !== null && (!accepted || accepted.clientMessageId !== clientMessageId || typeof accepted.runId !== "string" || !accepted.runId || typeof accepted.sessionFile !== "string" || !accepted.sessionFile)) throw new Error("受理记录缺少有效运行或会话凭据");
    return accepted;
  } catch (error) {
    if (error instanceof ExecutionRequestError && error.status === 404) return null;
    throw error;
  }
}

export async function acceptAgentMessage(input: AgentAcceptInput, signal?: AbortSignal) {
  // 发送前保留同一 ID、附件路径与提及值；刷新/首包丢失后的对账不会重新上传附件或生成新 ID。
  const body = JSON.stringify(input);
  localStorage.setItem(`${pendingPrefix}${input.clientMessageId}`, body);
  for (let attempt = 0; attempt < 2; attempt++) {
    signal?.throwIfAborted();
    try {
      const accepted = await executionRequest<AgentAcceptResult>("/api/agent/accept", {
        method: "POST", headers: { "Content-Type": "application/json", "x-toonflow-workspace": "1" }, body,
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(20_000)]) : AbortSignal.timeout(20_000),
      });
      if (accepted?.clientMessageId !== input.clientMessageId || typeof accepted.runId !== "string" || !accepted.runId || typeof accepted.sessionFile !== "string" || !accepted.sessionFile) throw new Error("服务端未返回有效受理凭据");
      clearPendingAgentMessage(input.clientMessageId);
      return accepted;
    } catch (error) {
      if (error instanceof ExecutionRequestError && error.status < 500) {
        if (error.status !== 409) clearPendingAgentMessage(input.clientMessageId);
        throw error;
      }
      signal?.throwIfAborted();
      const accepted = await getAcceptedAgentMessage(input.directory, input.clientMessageId, signal ? AbortSignal.any([signal, AbortSignal.timeout(10_000)]) : AbortSignal.timeout(10_000));
      if (accepted) { clearPendingAgentMessage(input.clientMessageId); return accepted; }
      if (attempt) throw error;
    }
  }
  throw new Error("消息未受理");
}

export type AgentRunSnapshot = {
  runId: string;
  status: string;
  intent: string;
  lastEventSeq: number;
  live: boolean;
  waitingQuestions: {
    callId: string;
    toolCallId: string;
    request: { title: string; question: string; options?: string[]; fields?: { field: string; title: string; type: "input" | "textarea" | "radio" | "checkbox" | "select" | "inputNumber" | "switch"; required?: boolean; options?: string[] }[] };
  }[];
  authorizations?: { scopeKey: string; scope: Record<string, unknown>; remaining: number | null; createdAt: string }[];
  pendingAuthorizations?: { toolCallId: string; toolName: string; args: unknown; modelId: string; scopeKey: string }[];
  reviewCalls?: { toolCallId: string; toolName: string; args: unknown; status: string }[];
  errorMessage?: string;
};

export async function controlAgentRun(runId: string, action: "pause" | "resume" | "terminate" | "stopGeneration", canvas?: { id: string; tools: unknown[] }) {
  const response = await fetch("/api/agent/run/control", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ runId, action, ...(canvas ? { canvas } : {}) }),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) throw new ExecutionRequestError(payload?.message || "运行控制失败", response.status);
  return payload?.data as AgentRunSnapshot | { runId: string; action: string };
}

export async function fetchAgentRunSnapshot(runId: string, signal?: AbortSignal) {
  const response = await fetch(`/api/agent/run/get?runId=${encodeURIComponent(runId)}`, {
    signal,
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) throw new Error(payload?.message || "读取运行状态失败");
  return payload?.data as AgentRunSnapshot;
}

export async function grantAgentAuthorization(runId: string, toolCallId: string, remaining = 1) {
  const response = await fetch("/api/agent/authorize/grant", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ runId, toolCallId, remaining }),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) throw new Error(payload?.message || "授权失败");
  return payload?.data as AgentRunSnapshot;
}

export async function subscribeAgentRunEvents(runId: string, afterSeq: number, onEvent: (event: AgentEvent, meta?: { seq: number }) => void | Promise<void>, signal?: AbortSignal) {
  const response = await fetch(`/api/agent/events/get?runId=${encodeURIComponent(runId)}&afterSeq=${afterSeq}`, {
    signal,
  });
  let cursor = afterSeq;
  for await (const raw of readAgentEvents(response, signal ?? AbortSignal.timeout(600_000))) {
    const event = raw as AgentEvent & { runSeq?: number };
    const seq = event.runSeq;
    if (seq === undefined || !Number.isSafeInteger(seq)) throw new Error("后台事件缺少有效游标，请刷新客户端后恢复");
    if (seq <= cursor) continue;
    if (seq !== undefined) delete (event as { runSeq?: number }).runSeq;
    await onEvent(event, seq !== undefined ? { seq } : undefined);
    if (seq !== undefined) cursor = seq;
    if (event.type === "done" || event.type === "error") return;
  }
}


export async function reviewAgentRun(runId: string, toolCallId: string) {
  const response = await fetch("/api/agent/run/review", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ runId, toolCallId }),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) throw new Error(payload?.message || "核对运行步骤失败");
  return payload?.data as AgentRunSnapshot;
}
