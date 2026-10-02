import type { BrowserFfmpegRequest } from "@toonflow/ffmpeg";
import { createWorkspaceFfmpeg, executeRemoteFfmpeg } from "@/utils/ffmpeg";
import { registerNodeJobHandler, reportNodeJobEvent } from "@/utils/jobs";

registerNodeJobHandler("ffmpeg", async (input, context) => {
  const request = input as unknown as BrowserFfmpegRequest;
  const factory = await createWorkspaceFfmpeg(context.directory, context.signal);
  let failure: Error | undefined;
  let result: unknown;
  await executeRemoteFfmpeg(factory, { ...request, directory: context.directory }, event => {
    reportNodeJobEvent(context.jobId, "ffmpeg", { event: event.event, args: event.args });
    if (event.event === "error") {
      const details = event.args[0] as { message?: string; name?: string; code?: string } | undefined;
      failure = Object.assign(new Error(details?.message ?? "FFmpeg 执行失败"), details);
    } else if (event.event === "result") result = event.args[0];
    else if (event.event === "end") result = { stdout: event.args[0], stderr: event.args[1] };
    else if (event.event === "progress") {
      const progress = event.args[0] as { percent?: number } | undefined;
      if (typeof progress?.percent === "number") context.reportProgress(progress.percent / 100);
    }
  }, context.signal);
  if (failure) throw failure;
  context.signal.throwIfAborted();
  return result;
}, "review");
