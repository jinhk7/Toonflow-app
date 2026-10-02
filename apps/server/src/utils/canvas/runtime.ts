import { ensureAgentRunStore } from "@/agent/runtime/store";
import { ensureNodeJobsReady } from "@/utils/jobs";
import { registerBuiltinNodeJobHandlers } from "@/utils/canvas/jobs";
import { recoverResourceWrites } from "@/utils/canvas/content";
import { ensureCanvasCommandsReady } from "@/utils/canvas/context";
import { recoverGraphWrites } from "@/utils/workspace/graph";
import { ensureMediaJobsReady } from "@/utils/media/mediaJobs";
import { ensureAgentRuntimeReady } from "@/agent/runtime/runHost";
import "@/utils/jobs/ffmpeg";

let ready: Promise<void> | undefined;

export function initializeBackendExecution() {
  ready ??= (async () => {
    await ensureAgentRunStore();
    registerBuiltinNodeJobHandlers();
    await recoverGraphWrites();
    await recoverResourceWrites();
    ensureMediaJobsReady();
    await ensureNodeJobsReady();
    await ensureCanvasCommandsReady();
    await ensureAgentRuntimeReady();
  })();
  return ready;
}
