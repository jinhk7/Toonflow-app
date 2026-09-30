import { dirname } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { getAgentRun, getAgentRunDatabase, getPendingQuestion, listWaitingQuestionsForRun } from "@/agent/runtime/store";
import { lockWorkspaceFiles, resolveWorkspacePath } from "@/utils/workspace/files";

function listAnsweredQuestionsForRun(runId: string) {
  const rows = getAgentRunDatabase().prepare(`
    SELECT callId, toolCallId, answerJson FROM agent_pending_questions
    WHERE runId = ? AND status = 'answered' AND answerJson IS NOT NULL
    ORDER BY createdAt ASC
  `).all(runId) as { callId: string; toolCallId: string; answerJson: string }[];
  return rows.map(row => ({
    callId: row.callId,
    toolCallId: row.toolCallId,
    answer: JSON.parse(row.answerJson) as { answer: string; skipped?: boolean },
  }));
}

function findToolCallName(history: SessionManager, toolCallId: string) {
  for (const entry of history.getBranch()) {
    if (entry.type !== "message" || entry.message.role !== "assistant") continue;
    for (const part of entry.message.content) {
      if (part.type === "toolCall" && part.id === toolCallId) return part.name;
    }
  }
  return "question";
}

export async function applyAnsweredQuestionsToSession(cwd: string, sessionFile: string, runId: string) {
  if (listWaitingQuestionsForRun(runId).length) return false;
  const answered = listAnsweredQuestionsForRun(runId);
  if (!answered.length) return false;
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
      if (existing.has(item.toolCallId)) continue;
      const text = item.answer.answer || "已确认";
      history.appendMessage({
        role: "toolResult",
        toolCallId: item.toolCallId,
        toolName: findToolCallName(history, item.toolCallId),
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

export async function applyStoredQuestionAnswer(callId: string) {
  const stored = getPendingQuestion(callId);
  if (!stored || stored.status !== "answered" || !stored.answer) return false;
  const record = getAgentRun(stored.runId);
  if (!record?.sessionFile) return false;
  return applyAnsweredQuestionsToSession(stored.cwd, record.sessionFile, stored.runId);
}
