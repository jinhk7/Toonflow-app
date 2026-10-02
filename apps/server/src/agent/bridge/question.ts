import { z } from "zod";
import type { QuestionAnswer, QuestionContext, QuestionRequest } from "@toonflow/tools-scaffold/runtime";
import type { AgentEvent } from "@/agent/runtime/types";
import { finishPendingQuestion, getPendingQuestion, insertPendingQuestion } from "@/agent/runtime/store";
import { maybeContinueRunAfterQuestions } from "@/agent/runtime/runContinuation";

type PendingQuestion = {
  cwd: string;
  request: QuestionRequest;
  cancel(): void;
  finish(result: QuestionAnswer | Error): void;
};

// ACT: 提问持久化到运行账本；HTTP 断开不取消，仅终止运行或用户作答结束。
const pendingQuestions = new Map<string, PendingQuestion>();

export function createQuestionContext(
  cwd: string,
  send: (event: Extract<AgentEvent, { type: "question" }>) => void,
  onCancel?: () => void,
  options?: { runId?: string; sessionFile?: string },
) {
  const activeQuestions = new Set<string>();
  let disposed = false;
  const context: QuestionContext = {
    async ask(toolCallId, request, signal) {
      if (disposed) throw new Error("提问所属对话已结束");
      signal?.throwIfAborted();
      const callId = crypto.randomUUID();
      if (options?.runId) insertPendingQuestion({ callId, runId: options.runId, cwd, toolCallId, request, sessionFile: options.sessionFile });
      return new Promise((resolve, reject) => {
        const finish = (result: QuestionAnswer | Error) => {
          if (!pendingQuestions.delete(callId)) return;
          activeQuestions.delete(callId);
          signal?.removeEventListener("abort", abort);
          if (result instanceof Error) reject(result);
          else resolve(result);
        };
        const abort = () => {
          if (options?.runId) finishPendingQuestion(callId, "cancelled");
          finish(new Error("提问已取消"));
        };
        pendingQuestions.set(callId, { cwd, request, finish, cancel() { onCancel?.(); abort(); } });
        activeQuestions.add(callId);
        signal?.addEventListener("abort", abort, { once: true });
        try { send({ ...request, type: "question", toolCallId, callId }); }
        catch (error) { finish(error instanceof Error ? error : new Error("发送提问失败")); }
      });
    },
  };
  return {
    context,
    dispose() {
      disposed = true;
      for (const callId of activeQuestions) {
        if (options?.runId) finishPendingQuestion(callId, "cancelled");
        pendingQuestions.get(callId)?.finish(new Error("提问所属对话已结束"));
      }
    },
    detach() {
      // 页面断开时保留等待中的提问，后台运行继续等待作答。
    },
  };
}

export function answerQuestion(cwd: string, callId: string, response: { answer?: string; values?: unknown; cancelled?: boolean; skipped?: boolean }) {
  const pending = pendingQuestions.get(callId);
  const stored = getPendingQuestion(callId);
  if ((!pending || pending.cwd !== cwd) && (!stored || stored.cwd !== cwd)) {
    throw Object.assign(new Error("提问不存在或已结束"), { status: 404 });
  }
  if (stored?.status === "answered" && stored.answer) return stored.answer;
  if (stored && stored.status !== "waiting") throw Object.assign(new Error("提问已结束"), { status: 409 });
  if (response.cancelled) {
    if (pending) pending.cancel();
    else finishPendingQuestion(callId, "cancelled");
    return;
  }
  if (response.skipped) {
    const result: QuestionAnswer = { answer: "用户跳过了本次提问", skipped: true };
    finishPendingQuestion(callId, result);
    pending?.finish(result);
    if (stored?.runId) void maybeContinueRunAfterQuestions(stored.runId);
    return result;
  }
  const fields = (pending?.request ?? stored?.request)?.fields;
  let result: QuestionAnswer;
  if (fields?.length) {
    const shape = Object.fromEntries(fields.map(field => {
      let schema: z.ZodType = z.string().trim().max(8000);
      if (field.type === "inputNumber") schema = z.number();
      else if (field.type === "switch") schema = z.boolean();
      else if (["radio", "select"].includes(field.type)) schema = z.enum(field.options!);
      else if (field.type === "checkbox") schema = z.array(z.enum(field.options!)).max(field.options!.length)
        .refine(value => new Set(value).size === value.length, "选项不能重复");
      if (field.required) schema = schema.refine(value => value !== "" && (!Array.isArray(value) || value.length > 0), `${field.title}不能为空`);
      else schema = z.preprocess(value => value === "" || value === null ? undefined : value, schema.optional());
      return [field.field, schema];
    }));
    const parsed = z.strictObject(shape).safeParse(response.values);
    if (!parsed.success) throw Object.assign(new Error("请按要求填写表单"), { status: 400 });
    const values = parsed.data as NonNullable<QuestionAnswer["values"]>;
    const answer = fields.filter(field => values[field.field] !== undefined).map(field => {
      const value = values[field.field];
      return `${field.title}：${Array.isArray(value) ? value.join("、") : typeof value === "boolean" ? value ? "是" : "否" : value}`;
    }).join("\n");
    result = { answer: answer || "未填写可选项", values };
  } else {
    const parsed = z.string().trim().min(1).max(8000).safeParse(response.answer);
    if (!parsed.success) throw Object.assign(new Error("请输入回答"), { status: 400 });
    result = { answer: parsed.data };
  }
  const runId = stored?.runId;
  finishPendingQuestion(callId, result);
  pending?.finish(result);
  if (runId) void maybeContinueRunAfterQuestions(runId);
  return result;
}
