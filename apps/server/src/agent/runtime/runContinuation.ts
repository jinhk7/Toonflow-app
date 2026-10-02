import { appendRunEvent, getAgentRun, listWaitingQuestionsForRun, updateAgentRun } from "@/agent/runtime/store";

let continueRun: ((runId: string, canvas?: import("@toonflow/tools-scaffold/runtime").CanvasInfo) => Promise<unknown>) | undefined;
let isHosted: ((runId: string) => boolean) | undefined;

export function registerRunContinuation(deps: {
  continueAgentRun(runId: string, canvas?: import("@toonflow/tools-scaffold/runtime").CanvasInfo): Promise<unknown>;
  isRunHosted(runId: string): boolean;
}) {
  continueRun = deps.continueAgentRun;
  isHosted = deps.isRunHosted;
}

export async function maybeContinueRunAfterQuestions(runId: string) {
  if (!continueRun || !isHosted) return;
  if (isHosted(runId)) return;
  if (listWaitingQuestionsForRun(runId).length) return;
  const record = getAgentRun(runId);
  if (!record?.sessionFile) return;
  if (!["waitingApproval", "paused", "running"].includes(record.status)) return;
  if (record.intent === "pause" || record.intent === "terminate") return;
  if (record.status === "running") updateAgentRun(runId, { status: "paused" });
  try { await continueRun(runId); }
  catch (error) {
    const message = `回答已保存，但恢复运行失败：${error instanceof Error ? error.message : "未知错误"}`;
    updateAgentRun(runId, { errorMessage: message });
    appendRunEvent(runId, { type: "error", message });
  }
}
