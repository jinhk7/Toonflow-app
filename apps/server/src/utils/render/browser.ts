import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";

type PendingCall = { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> };

export async function findBrowser(configured?: string) {
  const candidates = configured ? [configured] : [
    process.env.TOONFLOW_RENDER_BROWSER,
    process.platform === "win32" ? "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe" : undefined,
    process.platform === "win32" ? "C:/Program Files/Google/Chrome/Application/chrome.exe" : undefined,
    process.platform === "darwin" ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" : undefined,
    Bun.which("chromium"), Bun.which("chromium-browser"), Bun.which("google-chrome"),
  ];
  for (const candidate of candidates) {
    if (candidate && await stat(candidate).then(value => value.isFile()).catch(() => false)) return candidate;
  }
  throw new Error("独立渲染需要本机 Chromium、Chrome 或 Edge，请配置 TOONFLOW_RENDER_BROWSER");
}

export async function startBrowser(browserPath: string, profile: string, signal: AbortSignal) {
  signal.throwIfAborted();
  const child = Bun.spawn([browserPath,
    "--headless=new", "--no-first-run", "--no-default-browser-check", "--disable-background-networking", "--disable-component-update",
    "--disable-sync", "--disable-extensions", "--disable-default-apps", "--metrics-recording-only", "--no-proxy-server",
    "--remote-debugging-address=127.0.0.1", "--remote-debugging-port=0", `--user-data-dir=${profile}`,
    "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--disable-background-timer-throttling",
    "--disable-renderer-backgrounding", "--disable-backgrounding-occluded-windows", "--mute-audio", "about:blank",
  ], { stdin: "ignore", stdout: "ignore", stderr: "ignore", windowsHide: true });
  let socket: WebSocket | undefined;
  const pending = new Map<number, PendingCall>();
  let nextId = 0;
  let closing: Promise<void> | undefined;
  function rejectPending(error: Error) {
    for (const call of pending.values()) { clearTimeout(call.timer); call.reject(error); }
    pending.clear();
  }
  function call(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<unknown> {
    if (socket?.readyState !== WebSocket.OPEN) return Promise.reject(new Error("渲染浏览器连接已关闭"));
    return new Promise((resolve, reject) => {
      const id = ++nextId;
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`渲染浏览器响应超时：${method}`)); }, 30000);
      pending.set(id, { resolve, reject, timer });
      socket!.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }
  function close() {
    closing ??= (async () => {
      const timer = setTimeout(() => { if (child.exitCode === null) child.kill(); }, 2000);
      try {
        if (socket?.readyState === WebSocket.OPEN) await call("Browser.close").catch(() => undefined);
        socket?.close();
        await child.exited;
      } finally {
        clearTimeout(timer);
        rejectPending(new Error("渲染浏览器已停止"));
      }
    })();
    return closing;
  }
  const abort = () => { rejectPending(new Error("渲染任务已取消")); void close(); };
  signal.addEventListener("abort", abort, { once: true });
  try {
    const started = Date.now();
    let activePort = "";
    while (!activePort) {
      signal.throwIfAborted();
      if (child.exitCode !== null) throw new Error(`渲染浏览器启动失败（退出码 ${child.exitCode}）`);
      if (Date.now() - started > 15000) throw new Error("渲染浏览器启动超时");
      activePort = await readFile(join(profile, "DevToolsActivePort"), "utf8").catch((error: NodeJS.ErrnoException) => {
        // Windows 上 Chromium 写此文件时短暂独占；仅在本次启动的 15 秒期限内等待。
        if (error.code !== "ENOENT" && error.code !== "EBUSY") throw error;
        return "";
      });
      if (!/^\d+\r?\n\/devtools\/browser\/[\da-f-]+\s*$/i.test(activePort)) activePort = "";
      if (!activePort) await Bun.sleep(50);
    }
    const [port, endpoint] = activePort.trim().split(/\r?\n/);
    socket = new WebSocket(`ws://127.0.0.1:${port}${endpoint}`);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("渲染浏览器连接超时")), 10000);
      socket!.addEventListener("open", () => { clearTimeout(timer); resolve(); }, { once: true });
      socket!.addEventListener("error", () => { clearTimeout(timer); reject(new Error("渲染浏览器连接失败")); }, { once: true });
    });
    socket.addEventListener("message", event => {
      const message = JSON.parse(String(event.data)) as { id?: number; result?: unknown; error?: { message: string }; method?: string; params?: Record<string, unknown>; sessionId?: string };
      if (!message.id) return;
      const entry = pending.get(message.id);
      if (!entry) return;
      clearTimeout(entry.timer);
      pending.delete(message.id);
      if (message.error) entry.reject(new Error(message.error.message));
      else entry.resolve(message.result);
    });
    socket.addEventListener("close", () => rejectPending(new Error("渲染浏览器连接断开")));
    signal.throwIfAborted();
    return {
      call,
      onEvent(listener: (message: { method?: string; params?: Record<string, unknown>; sessionId?: string }) => void) {
        socket!.addEventListener("message", event => listener(JSON.parse(String(event.data))));
      },
      async close() { signal.removeEventListener("abort", abort); await close(); },
    };
  } catch (error) {
    signal.removeEventListener("abort", abort);
    await close();
    throw error;
  }
}
