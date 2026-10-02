import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import type { FfmpegFactory } from "@toonflow/ffmpeg";
import type { RenderJobContext, RenderJobInput, RenderJobResult } from "@toonflow/nodes-scaffold/execution";
import { renderJobSchema } from "@toonflow/node-director3d/render";
import { findBrowser, startBrowser } from "./browser";

export type RendererOptions = {
  entryPath: string;
  browserPath?: string;
  createFfmpeg(directory: string, signal: AbortSignal): FfmpegFactory | Promise<FfmpegFactory>;
};
type Evaluation = { result: { value: unknown }; exceptionDetails?: { text?: string; exception?: { description?: string } } };

/** 核心用已安装的渲染 artifact 和现有 FFmpeg 工厂注册；此模块不访问项目图或真实配置。 */
export function createRenderer(options: RendererOptions) {
  async function execute(value: RenderJobInput, context: RenderJobContext): Promise<RenderJobResult> {
    const signal = AbortSignal.any([context.signal, AbortSignal.timeout(15 * 60 * 1000)]);
    signal.throwIfAborted();
    const input = renderJobSchema.parse(value);
    if (Buffer.byteLength(JSON.stringify(input)) > 2000000) throw new Error("渲染输入不能超过 2 MB");
    const directory = await realpath(context.directory);
    if (!(await stat(directory)).isDirectory()) throw new Error("渲染任务目录不存在");
    const browserPath = await findBrowser(options.browserPath);
    const factory = input.format === "video" ? await options.createFfmpeg(directory, signal) : undefined;
    signal.throwIfAborted();
    const entry = await readFile(options.entryPath);
    if (entry.byteLength > 32 * 1024 * 1024) throw new Error("渲染入口超过 32 MB");
    const scratch = await mkdtemp(join(directory, "render"));
    const profile = join(scratch, "browserProfile");
    const frames = join(scratch, "frames");
    let browser: Awaited<ReturnType<typeof startBrowser>> | undefined;
    let server: ReturnType<typeof Bun.serve> | undefined;
    let completed = false;
    try {
      await mkdir(profile);
      await mkdir(frames);
      server = Bun.serve({
        hostname: "127.0.0.1", port: 0,
        fetch(request) {
          const path = new URL(request.url).pathname;
          if (path === "/") return new Response('<!doctype html><meta charset="utf-8"><script type="module" src="/renderWorker.js"></script>', { headers: { "Content-Type": "text/html" } });
          if (path === "/renderWorker.js") return new Response(entry, { headers: { "Content-Type": "text/javascript" } });
          return new Response("Not Found", { status: 404 });
        },
      });
      browser = await startBrowser(browserPath, profile, signal);
      const { targetId } = await browser.call("Target.createTarget", { url: "about:blank" }) as { targetId: string };
      const { sessionId } = await browser.call("Target.attachToTarget", { targetId, flatten: true }) as { sessionId: string };
      const origin = server.url.origin;
      browser.onEvent(message => {
        if (message.method !== "Fetch.requestPaused" || message.sessionId !== sessionId) return;
        const request = message.params!.request as { url: string };
        const allowed = new URL(request.url).origin === origin;
        void browser!.call(allowed ? "Fetch.continueRequest" : "Fetch.failRequest", {
          requestId: message.params!.requestId, ...(!allowed ? { errorReason: "BlockedByClient" } : {}),
        }, sessionId).catch(() => undefined);
      });
      await browser.call("Runtime.enable", {}, sessionId);
      await browser.call("Page.enable", {}, sessionId);
      await browser.call("Fetch.enable", { patterns: [{ urlPattern: "*" }] }, sessionId);
      await browser.call("Page.navigate", { url: server.url.href }, sessionId);
      async function evaluate(expression: string) {
        signal.throwIfAborted();
        const result = await browser!.call("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, sessionId) as Evaluation;
        if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? "渲染执行失败");
        return result.result.value;
      }
      const loading = Date.now();
      while (!(await evaluate("Boolean(window.toonflowRenderer)"))) {
        if (Date.now() - loading > 15000) throw new Error("渲染入口加载失败");
        await Bun.sleep(50);
      }
      const metadata = await evaluate(`window.toonflowRenderer.initialize(${JSON.stringify(input)})`) as Record<string, unknown>;
      const duration = input.duration ?? input.plan?.duration ?? 0;
      const frameCount = input.format === "image" ? 1 : Math.ceil(duration * input.frameRate);
      const output = join(scratch, input.format === "image" ? "renderImage.png" : "renderVideo.mp4");
      let frameBytes = 0;
      for (let frameIndex = 0; frameIndex < frameCount; frameIndex++) {
        signal.throwIfAborted();
        const time = input.format === "image" ? input.time ?? 0 : frameIndex / input.frameRate;
        const encoded = await evaluate(`window.toonflowRenderer.renderAt(${time})`);
        if (typeof encoded !== "string") throw new Error("渲染 worker 未返回 PNG 帧");
        const png = Buffer.from(encoded, "base64");
        if (png.length < 8 || png.readUInt32BE(0) !== 0x89504e47 || png.readUInt32BE(4) !== 0x0d0a1a0a) throw new Error("渲染 worker 返回的 PNG 无效");
        frameBytes += png.length;
        // ACT: 先沿用 PNG 帧序列；暂存超过 1 GB 时停止，后续可改为带背压的原始帧管道。
        if (frameBytes > 1024 * 1024 * 1024) throw new Error("渲染帧暂存超过 1 GB，请降低尺寸或缩短时长");
        await writeFile(input.format === "image" ? output : join(frames, `frame${String(frameIndex).padStart(5, "0")}.png`), png, { flag: "wx" });
        context.reportProgress((frameIndex + 1) / frameCount * (input.format === "image" ? 0.99 : 0.85));
      }
      await evaluate("window.toonflowRenderer.dispose(); true");
      await browser.close();
      browser = undefined;
      server.stop(true);
      server = undefined;
      if (factory) {
        const command = factory(relative(directory, join(frames, "frame%05d.png")))
          .inputOptions([`-framerate ${input.frameRate}`, "-start_number 0"])
          .videoCodec("libx264")
          .outputOptions([`-frames:v ${frameCount}`, "-pix_fmt yuv420p", "-movflags +faststart"])
          .output(relative(directory, output));
        await new Promise<void>((resolve, reject) => {
          let progressError: unknown;
          const cancel = () => command.kill("SIGKILL");
          const finish = (error?: unknown) => {
            signal.removeEventListener("abort", cancel);
            if (signal.aborted) reject(signal.reason);
            else if (error || progressError) reject(error ?? progressError);
            else resolve();
          };
          signal.addEventListener("abort", cancel, { once: true });
          command.on("start", () => { if (signal.aborted || progressError) cancel(); });
          command.on("progress", progress => {
            try { context.reportProgress(0.85 + Math.min(0.14, (progress.frames ?? 0) / frameCount * 0.14)); }
            catch (error) { progressError = error; cancel(); }
          });
          command.once("end", () => finish());
          command.once("error", error => finish(error));
          if (signal.aborted) { finish(); return; }
          command.run();
        });
      }
      signal.throwIfAborted();
      const outputSize = (await stat(output)).size;
      if (!outputSize || outputSize > 100 * 1024 * 1024) throw new Error("渲染产物为空或超过 100 MB，请降低尺寸或缩短时长");
      context.reportProgress(1);
      completed = true;
      return {
        artifacts: [{ path: relative(directory, output).replaceAll("\\", "/"), mimeType: input.format === "image" ? "image/png" : "video/mp4" }],
        metadata: { ...metadata, frameCount, frameRate: input.frameRate, duration: input.format === "video" ? frameCount / input.frameRate : undefined, outputSize },
      };
    } finally {
      try { await browser?.close(); }
      finally {
        server?.stop(true);
        // 仅清理本次 mkdtemp 创建且仍直属任务目录的暂存目录，成功时保留产物供核心发布。
        if (dirname(scratch) === directory) {
          if (completed) {
            await rm(profile, { recursive: true, force: true });
            await rm(frames, { recursive: true, force: true });
          } else await rm(scratch, { recursive: true, force: true });
        }
      }
    }
  }
  return { execute };
}
