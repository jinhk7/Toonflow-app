import type { AgentEvent } from "@toonflow/server/agent/types";
import { readAgentEvents } from "./replyStream";

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
    headers: { "Content-Type": "application/json", "x-toonflow-workspace": "1" },
    body: JSON.stringify({ runId, action, ...(canvas ? { canvas } : {}) }),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) throw new Error(payload?.message || "运行控制失败");
  return payload?.data as AgentRunSnapshot | { runId: string; action: string };
}

export async function fetchAgentRunSnapshot(runId: string) {
  const response = await fetch(`/api/agent/run/get?runId=${encodeURIComponent(runId)}`, {
    headers: { "x-toonflow-workspace": "1" },
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) throw new Error(payload?.message || "读取运行状态失败");
  return payload?.data as AgentRunSnapshot;
}

export async function grantAgentAuthorization(runId: string, toolCallId: string, remaining = 1) {
  const response = await fetch("/api/agent/authorize/grant", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-toonflow-workspace": "1" },
    body: JSON.stringify({ runId, toolCallId, remaining }),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) throw new Error(payload?.message || "授权失败");
  return payload?.data as AgentRunSnapshot;
}

export async function subscribeAgentRunEvents(runId: string, afterSeq: number, onEvent: (event: AgentEvent, meta?: { seq: number }) => void, signal?: AbortSignal) {
  const response = await fetch(`/api/agent/events/get?runId=${encodeURIComponent(runId)}&afterSeq=${afterSeq}`, {
    headers: { "x-toonflow-workspace": "1" },
    signal,
  });
  for await (const raw of readAgentEvents(response, signal ?? AbortSignal.timeout(600_000))) {
    const event = raw as AgentEvent & { runSeq?: number };
    const seq = event.runSeq;
    if (seq !== undefined) delete (event as { runSeq?: number }).runSeq;
    onEvent(event, seq !== undefined ? { seq } : undefined);
  }
}


export async function reviewAgentRun(runId: string, toolCallId: string) {
  const response = await fetch("/api/agent/run/review", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-toonflow-workspace": "1" },
    body: JSON.stringify({ runId, toolCallId }),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) throw new Error(payload?.message || "核对运行步骤失败");
  return payload?.data as AgentRunSnapshot;
}
