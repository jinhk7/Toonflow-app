const rules = [
  {
    type: "input", field: "baseUrl" as const, title: "Agnes 本地适配器地址",
    value: "http://127.0.0.1:8788", props: { placeholder: "http://127.0.0.1:8788" },
  },
  {
    type: "input", field: "apiKey" as const, title: "适配器代理 Key", value: "",
    props: { type: "password", showPassword: true, autocomplete: "off" },
  },
] as const;

type Context = ProviderContext<ProviderConfig<typeof rules>>;
let nextQueryAt = 0;

function configuration(context: Context) {
  const apiKey = context.config.apiKey?.trim().replace(/^Bearer(?:\s+|$)/i, "").trim();
  if (!apiKey || /\s/.test(apiKey)) throw new Error("请填写 Agnes 本地适配器的代理 Key，不能填写平台 Key 或管理员密码");
  let url: URL;
  try { url = new URL(context.config.baseUrl?.trim() || "http://127.0.0.1:8788"); }
  catch { throw new Error("适配器地址无效"); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash
    || !["/", "/v1", "/v1/"].includes(url.pathname)) throw new Error("适配器地址须为 HTTP(S) 服务根地址，可带 /v1，不能含凭据、查询参数或其他路径");
  if (/(?:^|\.)agnes-ai\.(?:cn|com)$/.test(url.hostname)) throw new Error("本供应商只连接本地 Agnes 适配器，请勿填写 Agnes 官方平台地址");
  return { baseUrl: url.origin, apiKey, keyIdentity: context.tool.hash(apiKey).toString(16) };
}

function publicUrl(value: string) {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("素材或成片 URL 无效"); }
  const host = url.hostname.toLowerCase();
  if (url.protocol !== "https:" || url.username || url.password || url.hash || (url.port && url.port !== "443")
    || !host.includes(".") || host.endsWith(".localhost") || host.endsWith(".local") || host.startsWith("[")
    || /^(?:0|10|127)\.|^169\.254\.|^192\.168\.|^172\.(?:1[6-9]|2\d|3[01])\.|^100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(host))
    throw new Error("素材及成片须为可公开访问的 HTTPS URL；DNS、尺寸、字节数和音频总时长由适配器继续校验");
  return url.href;
}

function prepareMedia(input: MediaInput, kind: "image" | "audio") {
  if (input.type === "url") {
    if (input.mimeType && !input.mimeType.toLowerCase().startsWith(kind + "/")) throw new Error("参考素材类型不匹配：" + kind);
    return { url: publicUrl(input.url), kind, bytes: 0 };
  }
  let mimeType = input.mimeType;
  let base64: string;
  if (input.type === "binary") {
    if (!ArrayBuffer.isView(input.data) || !("BYTES_PER_ELEMENT" in input.data) || input.data.BYTES_PER_ELEMENT !== 1
      || !input.data.byteLength || input.data.byteLength >= 15000000) throw new Error("单个素材须为非空字节数组且小于 15 MB");
    base64 = Buffer.from(input.data).toString("base64");
  } else {
    if (typeof input.data !== "string" || input.data.length > 21000000) throw new Error("素材 Base64 无效或超过大小上限");
    const inline = /^data:([^;,]+);base64,([\s\S]+)$/i.exec(input.data);
    if (inline) mimeType = inline[1]!;
    base64 = (inline?.[2] ?? input.data).replace(/\s/g, "");
    if (!base64 || !/^[A-Za-z0-9+/]+={0,2}$/.test(base64) || base64.length % 4 === 1) throw new Error("素材 Base64 无效");
    const bytes = Buffer.from(base64, "base64");
    if (bytes.toString("base64").replace(/=+$/, "") !== base64.replace(/=+$/, "")) throw new Error("素材 Base64 无效");
    base64 = bytes.toString("base64");
  }
  if (!mimeType?.toLowerCase().startsWith(kind + "/")) throw new Error("参考素材类型不匹配：" + kind);
  if (kind === "image" && !["image/png", "image/jpeg", "image/webp"].includes(mimeType.toLowerCase().split(";")[0]!)) throw new Error("本地图片仅支持 PNG、JPEG、WebP");
  const bytes = Buffer.from(base64, "base64").byteLength;
  if (!bytes || bytes >= 15000000) throw new Error("单个素材须非空且小于 15 MB");
  return { base64, kind, bytes };
}

async function payloadOf(context: Context, request: VideoRequest) {
  if (request.model !== "agnes-video-2.5-flash") throw new Error("仅支持 agnes-video-2.5-flash");
  if (typeof request.prompt !== "string" || !request.prompt.trim() || request.prompt.length > 30000) throw new Error("视频描述须为 1–30000 字符");
  if (request.videos?.length) throw new Error("Flash 不支持参考视频");
  if (request.generateAudio === false) throw new Error("此接口没有关闭声音的参数");
  if (request.watermark === true) throw new Error("此接口没有水印开关");
  const seconds = request.duration ?? 5;
  if (!Number.isInteger(seconds) || seconds < 4 || seconds > 12) throw new Error("时长须为 4–12 整数秒");
  if (request.resolution !== undefined && request.resolution.toLowerCase() !== "720p") throw new Error("Flash 仅支持 720P");
  const ratio = request.ratio ?? "16:9";
  if (!["21:9", "16:9", "4:3", "1:1", "3:4", "9:16"].includes(ratio)) throw new Error("不支持的画面比例");
  const other = request.other ?? {};
  if (Object.keys(other).some(key => key !== "seed")) throw new Error("额外参数仅支持 seed；不支持 width、height、fps、quality 等参数");
  if (other.seed !== undefined && !Number.isSafeInteger(other.seed)) throw new Error("seed 须为可精确表示的 JSON 整数");
  const images = request.images ?? [];
  const audios = request.audios ?? [];
  if (images.length > 5 || audios.length > 3) throw new Error("最多支持 5 张图片和 3 段音频参考");
  let first = request.firstFrame;
  const last = request.lastFrame;
  const mode = request.mode ?? (first ? "endFrameOptional" : last ? "startFrameOptional" : images.length || audios.length ? ["imageReference:5", "audioReference:3"] : "text");
  const reference = Array.isArray(mode);
  if (reference) {
    const limits = { image: 0, audio: 0 };
    for (const item of mode) {
      const match = /^(image|audio)Reference:([0-9]+)$/.exec(item);
      if (!match) throw new Error("参考模式只支持图片和音频");
      const kind = match[1] as "image" | "audio";
      const limit = Number(match[2]);
      if (limit > (kind === "image" ? 5 : 3)) throw new Error("参考模式超过 Flash 素材数量上限");
      limits[kind] = limit;
    }
    if (images.length > limits.image || audios.length > limits.audio) throw new Error("参考素材超过当前模式声明的数量");
    if (first || last || (!images.length && !audios.length)) throw new Error("参考模式须提供图片或音频，不能混用首尾帧");
  } else if (mode === "text") {
    if (first || last || images.length || audios.length) throw new Error("文字模式不能携带参考素材");
  } else {
    const singleFallback = mode === "singleImage" && !first && images.length === 1;
    if (singleFallback) first = images[0];
    if (!["singleImage", "startEndRequired", "endFrameOptional", "startFrameOptional"].includes(mode)) throw new Error("不支持的视频模式");
    if (audios.length || (images.length && !singleFallback)) throw new Error("首尾帧模式不能混用普通参考素材");
    if ((mode === "singleImage" && (!first || last)) || (mode === "startEndRequired" && (!first || !last))
      || (mode === "endFrameOptional" && !first) || (mode === "startFrameOptional" && !last)) throw new Error("当前模式缺少必需帧，或包含不允许的帧");
  }
  // 先校验所有素材与已知图片总字节数，再开始发布；远程 URL 的大小和音频时长由适配器核实。
  const refs = [
    ...(first ? [{ field: "first_frame", input: first, kind: "image" as const }] : []),
    ...(last ? [{ field: "last_frame", input: last, kind: "image" as const }] : []),
    ...(reference ? images.map(input => ({ field: "images", input, kind: "image" as const })) : []),
    ...(reference ? audios.map(input => ({ field: "audios", input, kind: "audio" as const })) : []),
  ].map(ref => ({ ...ref, prepared: prepareMedia(ref.input, ref.kind) }));
  if (refs.filter(ref => ref.kind === "image").reduce((total, ref) => total + ref.prepared.bytes, 0) >= 50000000) throw new Error("输入图片总大小须小于 50 MB");
  const payload: Record<string, unknown> = {
    model: request.model, prompt: request.prompt.trim(), mode: reference ? "reference" : mode === "text" ? "text" : "keyframe",
    seconds: String(seconds), size: "720P", aspect_ratio: ratio, n: 1,
    ...(other.seed !== undefined ? { seed: other.seed } : {}),
  };
  for (const ref of refs) {
    context.signal?.throwIfAborted();
    let url = ref.prepared.url;
    if (!url) {
      const { data } = await callAdapter(context, "/v1/uploads", { kind: ref.kind, base64: ref.prepared.base64 });
      if (typeof data.url !== "string") throw new Error("素材上传未返回公网 URL，未创建视频；请在适配器核对 R2 上传结果");
      url = publicUrl(data.url);
    }
    if (ref.field === "images" || ref.field === "audios") {
      (payload[ref.field] ??= []);
      (payload[ref.field] as string[]).push(url);
    } else payload[ref.field] = url;
  }
  return payload;
}

function retryAfterMs(response: Response) {
  const value = response.headers.get("retry-after");
  if (value === null) return 60000;
  const seconds = Number(value);
  const delay = Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : Date.parse(value) - Date.now();
  return Number.isFinite(delay) ? Math.max(0, delay) : 60000;
}

async function callAdapter(context: Context, path: string, body?: Record<string, unknown>) {
  const { baseUrl, apiKey } = configuration(context);
  const uploading = path === "/v1/uploads";
  const operation = uploading ? "素材上传" : body ? "提交" : "查询";
  const signal = AbortSignal.any([AbortSignal.timeout(uploading ? 120000 : body ? 300000 : 30000), ...(context.signal ? [context.signal] : [])]);
  signal.throwIfAborted();
  let response: Response;
  try {
    response = await context.tool.fetch(baseUrl + path, {
      method: body ? "POST" : "GET", signal, redirect: "error",
      headers: { Authorization: "Bearer " + apiKey, Accept: "application/json", ...(body ? { "Content-Type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  } catch {
    if (context.signal?.aborted) throw context.signal.reason;
    throw new Error(uploading ? "素材上传失败或超时，未创建视频；请核对适配器及 R2，已发布的素材由适配器保留策略清理" : body ? "提交连接失败或等待超过 300 秒，接受状态未知；远端任务没有因此取消。请在 Agnes 管理页核对原任务，禁止自动重提" : "查询连接失败或超时，原任务仍保留，可继续查询；没有取消远端生成");
  }
  let data: Record<string, unknown> = {};
  try {
    const value = await response.json();
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid response");
    data = value as Record<string, unknown>;
  } catch {
    const requestId = response.headers.get("x-request-id");
    throw Object.assign(new Error((uploading ? "素材上传响应无效，未创建视频" : body ? "提交响应无效，接受状态未知，禁止自动重提" : "查询响应无效，已暂停续查，保留原任务")
      + (requestId ? "；request_id=" + context.tool.errorMessage(requestId) : "")), { retryable: false, status: response.status });
  }
  if (!response.ok) {
    const waitExpired = !body && response.status === 408 && data.code === "LOCAL_WAIT_EXPIRED";
    const detail = waitExpired ? "Agnes 本地 600 秒等待已结束并释放本地名额；原上游任务仍保留，请在管理页核对，不会自动续查或重新生成"
      : uploading && data.code === "R2_NOT_CONFIGURED" ? "请先在 Agnes 管理页配置 R2 存储" : uploading && response.status === 404 ? "适配器缺少 /v1/uploads 上传接口，请升级适配器" : context.tool.errorMessage(data) || "HTTP " + response.status;
    const requestId = data.request_id ?? response.headers.get("x-request-id");
    throw Object.assign(new Error(`${operation}失败（HTTP ${response.status}）：${detail}`
      + (requestId ? "；request_id=" + context.tool.errorMessage(requestId) : "")
      + (uploading ? "；未创建视频，不会自动重试上传或生成" : body ? "；不会自动重提，请先核对 Agnes 管理页" : "；保留原任务 ID")), {
      status: response.status, ...(response.status === 429 ? { retryAfterMs: retryAfterMs(response) } : {}),
      ...(waitExpired ? { code: "LOCAL_WAIT_EXPIRED", retryable: false } : {}),
    });
  }
  if (uploading && response.status !== 201) throw new Error("素材上传未返回约定的 HTTP 201，未创建视频；请核对适配器版本");
  return { data, requestId: response.headers.get("x-request-id") };
}

async function submitVideo(this: Context, request: VideoRequest): Promise<MediaTaskSubmitResult> {
  this.signal?.throwIfAborted();
  const identity = configuration(this);
  const payload = await payloadOf(this, request);
  const { data, requestId } = await callAdapter(this, "/v1/videos", payload);
  if (typeof data.video_id !== "string" || !/^video_[A-Za-z0-9_-]{1,160}$/.test(data.video_id)
    || (data.model !== undefined && data.model !== request.model)
    || !["queued", "in_progress", "completed", "failed"].includes(String(data.status)))
    throw new Error("提交响应没有可核对的 video_id 或状态；不能用 id/task_id 代替，禁止自动重提"
      + (requestId ? "；request_id=" + this.tool.errorMessage(requestId) : ""));
  // ACT: 宿主只持久化 taskId；将远端 ID、原适配器地址和非秘密 Key 指纹一起保存，配置变更后暂停而非换身份查询。
  return { taskId: JSON.stringify(["agnesLocalVideo", 1, data.video_id, identity.baseUrl, identity.keyIdentity]) };
}

async function queryVideoTask(this: Context, taskId: string): Promise<MediaTaskQueryResult> {
  this.signal?.throwIfAborted();
  const identity = configuration(this);
  let saved: unknown;
  try { saved = JSON.parse(taskId); } catch { /* 无原身份的历史 ID 不猜测查询地址。 */ }
  if (!Array.isArray(saved) || saved.length !== 5 || saved[0] !== "agnesLocalVideo" || saved[1] !== 1
    || typeof saved[2] !== "string" || !/^video_[A-Za-z0-9_-]{1,160}$/.test(saved[2]))
    throw Object.assign(new Error("任务身份无效或缺少原适配器身份，请在 Agnes 管理页核对"), { retryable: false });
  if (saved[3] !== identity.baseUrl || saved[4] !== identity.keyIdentity)
    throw Object.assign(new Error("适配器地址或代理 Key 已改变，请恢复原配置后查询；不会切换平台 Key 或重新提交"), { retryable: false });
  // ACT: 宿主的通用轮询间隔是 3 秒；本供应商在下一次只读查询前执行服务端退避，无需修改或重启宿主。
  while (nextQueryAt > Date.now()) await wait(Math.min(nextQueryAt - Date.now(), 2147483647), this.signal);
  let data: Record<string, unknown>;
  try { ({ data } = await callAdapter(this, "/agnesapi?video_id=" + encodeURIComponent(saved[2]) + "&model_name=agnes-video-2.5-flash")); }
  catch (error) {
    const info = error as { status?: number; retryAfterMs?: number };
    if (info.status === 429) nextQueryAt = Date.now() + (info.retryAfterMs ?? 60000);
    throw error;
  }
  if (data.video_id !== undefined && data.video_id !== saved[2]) throw Object.assign(new Error("查询返回了不同的 video_id，已暂停续查"), { retryable: false });
  if (data.model !== undefined && data.model !== "agnes-video-2.5-flash") throw Object.assign(new Error("查询返回了不同模型，已暂停续查"), { retryable: false });
  if (data.status === "completed") {
    let url: string;
    try { if (typeof data.url !== "string") throw new Error("missing url"); url = publicUrl(data.url); }
    catch { throw Object.assign(new Error("远端已完成但成片 URL 无效，保留任务供人工核对；不会重新生成"), { retryable: false }); }
    return { status: "completed", assets: [{ mediaType: "video", type: "url", url, mimeType: "video/mp4" }] };
  }
  if (data.status === "failed") return { status: "failed", errorMessage: this.tool.errorMessage(data) || "Agnes 远端视频生成失败" };
  if (data.status === "queued" || data.status === "in_progress") {
    nextQueryAt = Date.now() + 10000;
    return { status: "pending" };
  }
  throw Object.assign(new Error("适配器返回未知任务状态，已暂停续查，不能将 unknown 视为取消或重新生成"), { retryable: false });
}

function wait(ms: number, signal?: AbortSignal) {
  signal?.throwIfAborted();
  return new Promise<void>((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(signal?.reason); };
    const timer = setTimeout(() => { signal?.removeEventListener("abort", abort); resolve(); }, ms);
    signal?.addEventListener("abort", abort, { once: true });
  });
}

export default {
  id: "agnesLocalVideo", label: "Agnes 本地适配器 · Flash", version: "1.1.1", apiUrl: "http://127.0.0.1:8788",
  readme: "连接本地 Agnes 视频适配器，地址从 Toonflow 服务端访问，可配置 Tailscale 服务地址。代理 Key 使用 Agnes 管理页的独立访问 Key，不是平台 Key 或管理员密码。支持文字、单图、首尾帧和最多 5 张图片/3 段音频参考；4–12 整数秒、720P、六种比例；不支持参考视频、静音、水印、宽高或帧率开关。本地图片/音频通过代理 Key 鉴权的 /v1/uploads 发布，需要适配器已配置 R2；上传失败不会创建视频。适配器继续校验图片大小/尺寸与音频总时长。公网 HTTPS 素材直接引用。创建只发送一次，持久化 video_id 及原适配器身份；未知接受状态需人工核对。300 秒只限制单次提交等待，不取消远端任务。查询完成后收取官方 url，不依赖适配器缓存。配置变化后暂停查询，请恢复原地址与代理 Key。",
  rules,
  models: [{
    id: "agnes-video-2.5-flash", label: "Agnes Video 2.5 Flash", type: "video",
    mode: ["text", "singleImage", "startEndRequired", "endFrameOptional", "startFrameOptional", ["imageReference:5", "audioReference:3"]],
    audio: true, imageRatios: ["21:9", "16:9", "4:3", "1:1", "3:4", "9:16"],
    durationResolutionMap: [{ duration: [4, 5, 6, 7, 8, 9, 10, 11, 12], resolution: ["720p"] }],
  }] satisfies ProviderModel[],
  submitVideo,
  queryVideoTask,
  async generateVideo(request: VideoRequest): Promise<MediaAsset[]> {
    const { taskId } = await submitVideo.call(this, request);
    for (;;) {
      let result: MediaTaskQueryResult;
      try { result = await queryVideoTask.call(this, taskId); }
      catch (error) {
        const info = error as { status?: number; retryAfterMs?: number };
        if (info.status !== 429) throw Object.assign(new Error((this.tool.errorMessage(error) || "已停止本地等待")
          + "；原 video_id=" + JSON.parse(taskId)[2] + "，请在适配器核对，不会重新生成"), info);
        let remaining = info.retryAfterMs ?? 60000;
        while (remaining > 0) {
          const delay = Math.min(remaining, 2147483647);
          await wait(delay, this.signal);
          remaining -= delay;
        }
        continue;
      }
      if (result.status === "completed") return result.assets!;
      if (result.status === "failed") throw new Error(result.errorMessage || "视频生成失败");
      await wait(10000, this.signal);
    }
  },
} satisfies ProviderDefinition<typeof rules>;
