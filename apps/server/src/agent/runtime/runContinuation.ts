import { getAgentRun, listWaitingQuestionsForRun } from "@/agent/runtime/store";
import { applyAnsweredQuestionsToSession } from "@/agent/runtime/sessionRecovery";

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
  await applyAnsweredQuestionsToSession(record.cwd, record.sessionFile, runId);
  await continueRun(runId);
}
