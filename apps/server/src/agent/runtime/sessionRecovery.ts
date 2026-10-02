import { dirname } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { getAgentRun, getAgentRunDatabase, getPendingQuestion, listWaitingQuestionsForRun, listRunUndeliveredInputs, recordAgentInputDelivery } from "@/agent/runtime/store";
import { lockWorkspaceFiles, resolveWorkspacePath, writeWorkspaceFile } from "@/utils/workspace/files";

function listAnsweredQuestionsForRun(runId: string) {
  const rows = getAgentRunDatabase().prepare(`
    SELECT callId, toolCallId, answerJson, sessionFile FROM agent_pending_questions
    WHERE runId = ? AND status = 'answered' AND answerJson IS NOT NULL
    ORDER BY createdAt ASC
  `).all(runId) as { callId: string; toolCallId: string; answerJson: string; sessionFile?: string | null }[];
  return rows.map(row => ({
    callId: row.callId,
    toolCallId: row.toolCallId,
    answer: JSON.parse(row.answerJson) as { answer: string; skipped?: boolean },
    sessionFile: row.sessionFile,
  }));
}

function findModelToolCall(history: SessionManager, executionId: string) {
  const mapping = history.getBranch().findLast(entry => entry.type === "custom" && entry.customType === "toonflowToolCall"
    && (entry.data as { toolCallId?: string } | undefined)?.toolCallId === executionId);
  const toolCallId = mapping?.type === "custom" ? (mapping.data as { modelToolCallId: string }).modelToolCallId : executionId;
  for (const entry of history.getBranch()) {
    if (entry.type !== "message" || entry.message.role !== "assistant") continue;
    for (const part of entry.message.content) {
      if (part.type === "toolCall" && part.id === toolCallId) return { id: part.id, name: part.name };
    }
  }
}

export async function applyAnsweredQuestionsToSession(cwd: string, sessionFile: string, runId: string) {
  if (listWaitingQuestionsForRun(runId).length) return false;
  const answered = listAnsweredQuestionsForRun(runId);
  if (!answered.length) return false;
  let changed = false;
  for (const file of new Set(answered.map(item => item.sessionFile ?? sessionFile))) {
    changed = await applyAnswers(cwd, file, answered.filter(item => (item.sessionFile ?? sessionFile) === file)) || changed;
  }
  return changed;
}

async function applyAnswers(cwd: string, sessionFile: string, answered: ReturnType<typeof listAnsweredQuestionsForRun>) {
  const { path } = await resolveWorkspacePath(cwd, `.agent/sessions/${sessionFile}`);
  const release = lockWorkspaceFiles([path]);
  try {
    const history = SessionManager.open(path, dirname(path), cwd);
    const existing = new Set(
      history.getBranch().flatMap(entry =>
        entry.type === "message" && entry.message.role === "toolResult" ? [entry.message.toolCallId] : [],
      ),
    );
    let changed = false;
    for (const item of answered) {
      const modelCall = findModelToolCall(history, item.toolCallId);
      if (!modelCall || existing.has(modelCall.id)) continue;
      const text = item.answer.answer || "已确认";
      history.appendMessage({
        role: "toolResult",
        toolCallId: modelCall.id,
        toolName: modelCall.name,
        content: [{ type: "text", text }],
        isError: false,
        timestamp: Date.now(),
      });
      changed = true;
    }
    return changed;
  } finally {
    release();
  }
}

export async function restoreUndeliveredAgentInputs(runId: string) {
  for (const receipt of listRunUndeliveredInputs(runId)) {
    if (receipt.mode !== "steer") continue;
    const { path } = await resolveWorkspacePath(receipt.cwd, `.agent/sessions/${receipt.sessionFile}`);
    const release = lockWorkspaceFiles([path]);
    try {
      const history = SessionManager.open(path, dirname(path), receipt.cwd);
      const saved = history.getEntries().find(entry => entry.type === "custom" && entry.customType === "toonflowUserMessage"
        && (entry.data as { clientMessageId?: string } | undefined)?.clientMessageId === receipt.clientMessageId);
      let messageId = saved?.type === "custom" ? (saved.data as { messageId: string }).messageId : undefined;
      if (!messageId) {
        const input = JSON.parse(receipt.inputJson) as { prompt: string };
        messageId = history.appendMessage({ role: "user", content: input.prompt, timestamp: Date.now() });
        history.appendCustomEntry("toonflowUserMessage", { messageId, content: input.prompt, attachments: [], mentions: [], clientMessageId: receipt.clientMessageId });
        await writeWorkspaceFile(path, [history.getHeader(), ...history.getEntries()].map(entry => JSON.stringify(entry)).join("\n") + "\n");
      }
      recordAgentInputDelivery(receipt.cwd, receipt.clientMessageId, messageId);
    } finally { release(); }
  }
}

export async function applyStoredQuestionAnswer(callId: string) {
  const stored = getPendingQuestion(callId);
  if (!stored || stored.status !== "answered" || !stored.answer) return false;
  const record = getAgentRun(stored.runId);
  if (!record?.sessionFile) return false;
  return applyAnsweredQuestionsToSession(stored.cwd, record.sessionFile, stored.runId);
}
