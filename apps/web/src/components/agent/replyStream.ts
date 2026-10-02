import { reactive, type Ref } from "vue";
import { throttle } from "lodash-es";
import type { AgentEvent } from "@toonflow/server/agent/types";
import type { AgentMessage, AgentMessagePart } from "./types";
import { readExecutionEvents } from "@toonflow/nodes-scaffold/runtime";

export async function* readAgentEvents(response: Response, signal: AbortSignal) {
  for await (const event of readExecutionEvents<AgentEvent>(response, signal)) {
    yield event;
    if (event.type === "done" || event.type === "error") return;
  }
  throw new Error("连接已中断，正在恢复后台运行");
}

export function createReplyStream(reply: AgentMessage) {
  const parts = reply.parts!;
  let thinkingPart: Extract<AgentMessagePart, { type: "thinking" }> | undefined;
  let thinkingStartedAt = 0;
  let thinkingDuration = 0;
  const pendingContent = new Map<Exclude<AgentMessagePart, { type: "tool" }>, string>();
  // ACT: 合并 50 ms 内的文本增量，避免 Markdown 每个 token 都重新解析全文；结束时立即补齐。
  const flushContent = throttle(() => {
    for (const [part, content] of pendingContent) part.content = content;
    pendingContent.clear();
    if (thinkingPart) thinkingPart.duration = thinkingDuration + (performance.now() - thinkingStartedAt) / 1000;
  }, 50);

  function finishThinking() {
    if (!thinkingPart) return;
    flushContent.flush();
    thinkingPart.duration = thinkingDuration + (performance.now() - thinkingStartedAt) / 1000;
    thinkingPart.collapsed = true;
    thinkingPart = undefined;
  }

  function receive(event: Extract<AgentEvent, { type: "text" | "thinking" | "tool" | "question" }>) {
    if (event.type === "question") {
      const part = parts.find(part => part.type === "tool" && part.tool.id === event.toolCallId);
      if (part?.type !== "tool") throw new Error("提问缺少对应的工具调用");
      if (part.tool.question?.callId !== event.callId) part.tool.question = { callId: event.callId, title: event.title, question: event.question, options: event.options, fields: event.fields };
      return;
    }
    if (event.type === "tool") {
      const part = parts.find((part): part is Extract<AgentMessagePart, { type: "tool" }> => part.type === "tool" && part.id === event.blockId);
      if (part) Object.assign(part.tool, event.tool);
      else {
        finishThinking();
        parts.push({ id: event.blockId, type: "tool", tool: event.tool });
      }
      return;
    }
    const existing = parts.find((part): part is Exclude<AgentMessagePart, { type: "tool" }> => part.type !== "tool" && part.id === event.blockId);
    const part = existing ?? reactive<Exclude<AgentMessagePart, { type: "tool" }>>({ id: event.blockId, type: event.type, content: "" });
    if (!existing) parts.push(part);
    if (part.type === "thinking" && !event.done && thinkingPart !== part) {
      finishThinking();
      thinkingPart = part;
      thinkingStartedAt = performance.now();
      thinkingDuration = part.duration ?? 0;
      part.collapsed = false;
    }
    if (part.type === "text") finishThinking();
    pendingContent.set(part, event.content ?? (pendingContent.get(part) ?? part.content) + (event.delta ?? ""));
    flushContent();
    if (event.done) {
      flushContent.flush();
      if (part.type === "thinking" && thinkingPart === part) finishThinking();
    }
  }

  function finish() {
    flushContent.flush();
    flushContent.cancel();
    finishThinking();
    reply.content = parts.filter(part => part.type === "text").map(part => part.content).join("\n\n");
    reply.streaming = false;
    for (const part of parts) {
      if (part.type === "tool" && part.tool.status === "running") part.tool.status = "interrupted";
    }
  }

  function suspend() {
    flushContent.flush();
    flushContent.cancel();
    finishThinking();
  }

  return { receive, finish, suspend };
}

// 父会话请求和转发的子会话事件共用消息归并，切换界面不改变正在接收的回复。
export function createConversationStream(messages: Ref<AgentMessage[]>) {
  let reply: AgentMessage | undefined;
  let stream: ReturnType<typeof createReplyStream> | undefined;

  function finish() {
    stream?.finish();
    stream = undefined;
    reply = undefined;
  }

  function begin(message: AgentMessage) {
    finish();
    reply = message;
    stream = createReplyStream(message);
  }

  function ensureReply(userId?: string) {
    if (reply && userId && reply.replyTo && reply.replyTo !== userId) finish();
    if (!reply) {
      const user = messages.value.findLast(message => message.role === "user");
      const last = messages.value.findLast(message => message.role === "assistant" && message.streaming);
      const message = last ?? reactive<AgentMessage>({ id: crypto.randomUUID(), role: "assistant", content: "", parts: [], streaming: true, replyTo: userId ?? user?.entryId });
      if (!last) messages.value.push(message);
      begin(message);
    }
    if (userId) reply!.replyTo = userId;
    return stream!;
  }

  function receive(event: AgentEvent) {
    if (event.type === "userMessage") {
      const existing = messages.value.find(message => message.entryId === event.id)
        ?? messages.value.find(message => message.role === "user" && !message.entryId && message.content === event.content);
      if (existing) { existing.entryId = event.id; existing.error = undefined; existing.mentions = event.mentions; }
      else messages.value.push({ id: event.id, entryId: event.id, role: "user", content: event.content ?? "", attachments: event.attachments, mentions: event.mentions });
      ensureReply(event.id);
    } else if (["text", "thinking", "tool", "question"].includes(event.type)) {
      ensureReply().receive(event as Extract<AgentEvent, { type: "text" | "thinking" | "tool" | "question" }>);
    } else if (event.type === "error") {
      ensureReply();
      reply!.error = event.message;
      finish();
    } else if (event.type === "done") finish();
  }

  function suspend() {
    stream?.suspend();
    stream = undefined;
    reply = undefined;
  }

  return { begin, receive, finish, suspend };
}
