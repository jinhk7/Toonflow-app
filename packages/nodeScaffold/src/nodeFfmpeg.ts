import type { BrowserFfmpegFactory } from "@toonflow/ffmpeg/browser";

export type { BrowserFfmpegFactory, BrowserFfmpegCommand, BrowserFfmpegOptions, FfprobeData } from "@toonflow/ffmpeg/browser";

export function useNodeFfmpeg(): (signal?: AbortSignal) => BrowserFfmpegFactory {
  return () => { throw new Error("旧客户端 FFmpeg 入口已停用，请使用节点后端注册动作"); };
}
