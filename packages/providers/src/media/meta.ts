const rules = [
  {
    type: "input",
    field: "apiKey" as const,
    title: "API Key",
    value: "",
    props: { type: "password", showPassword: true, autocomplete: "off" },
  },
  {
    type: "input",
    field: "baseUrl" as const,
    title: "请求地址",
    value: "https://metaso.cn/api/minimax",
    props: { placeholder: "https://metaso.cn/api/minimax" },
  },
] as const;

const version = "2.0.1";

function mediaUrl(input: MediaInput) {
  if (input.type === "url") return input.url;
  const data = input.type === "binary" ? Buffer.from(input.data).toString("base64") : input.data;
  return data.startsWith("data:") ? data : `data:${input.mimeType};base64,${data}`;
}

function wait(signal: AbortSignal, ms: number) {
  signal.throwIfAborted();
  return new Promise<void>((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, ms);
    signal.addEventListener("abort", abort, { once: true });
  });
}

// 秘塔官方 API 弹窗说明仅替换 Host，查询协议沿用 MiniMax V2。
// https://platform.minimax.cn/docs/api-reference/video-generation-v2-query
async function queryVideoTask(this: ProviderContext<ProviderConfig<typeof rules>>, taskId: string): Promise<MediaTaskQueryResult> {
  const apiKey = this.config.apiKey?.trim();
  if (!apiKey) throw new Error("请填写 API Key");
  if (!taskId.trim()) throw new Error("任务 ID 不能为空");
  const baseUrl = (this.config.baseUrl?.trim() || "https://metaso.cn/api/minimax").replace(/\/$/, "");
  const signal = AbortSignal.any([AbortSignal.timeout(30_000), ...(this.signal ? [this.signal] : [])]);
  signal.throwIfAborted();
  const response = await this.tool.fetch(`${baseUrl}/v2/query/video_generation/${encodeURIComponent(taskId)}`, {
    headers: { Authorization: `Bearer ${apiKey}` },
    signal,
  });
  if (!response.ok) throw Object.assign(new Error(`查询任务失败：HTTP ${response.status}`), { status: response.status });
  const data = await response.json().catch(error => {
    signal.throwIfAborted();
    if (error?.name === "SyntaxError") throw Object.assign(new Error("任务查询返回无效 JSON"), { retryable: false });
    throw error;
  });
  signal.throwIfAborted();
  const task = data?.task;
  const status = task && typeof task === "object" && !Array.isArray(task) ? task.status : undefined;
  if (status === "succeeded") {
    try {
      const url = task.content?.url;
      if (typeof url !== "string" || !["http:", "https:"].includes(new URL(url).protocol)) return { status: "completed", assets: [] };
      return { status: "completed", assets: [{ mediaType: "video", type: "url", url }] };
    } catch { return { status: "completed", assets: [] }; }
  }
  if (status === "failed" || status === "cancelled") {
    return { status: "failed", errorMessage: this.tool.errorMessage?.(data) || (status === "cancelled" ? "视频任务已取消" : "视频生成失败") };
  }
  if (status === "queued" || status === "running") return { status: "pending" };
  throw Object.assign(new Error(typeof status === "string" && status ? "任务查询返回未知状态" : "任务查询未返回状态"), { retryable: false });
}

async function submitVideo(this: ProviderContext<ProviderConfig<typeof rules>>, request: VideoRequest): Promise<MediaTaskSubmitResult> {
  const apiKey = this.config.apiKey?.trim();
  if (!apiKey) throw new Error("请填写 API Key");
  const baseUrl = (this.config.baseUrl?.trim() || "https://metaso.cn/api/minimax").replace(/\/$/, "");

  const images = (request.images ?? []).map(mediaUrl);
  const videos = (request.videos ?? []).map(mediaUrl);
  const audios = (request.audios ?? []).map(mediaUrl);
  const frames = [
    ...(request.firstFrame ? [{ url: mediaUrl(request.firstFrame), role: "first_frame" }] : []),
    ...(request.lastFrame ? [{ url: mediaUrl(request.lastFrame), role: "last_frame" }] : []),
  ];
  const mode =
    request.mode ?? (frames.length ? "startFrameOptional" : videos.length || audios.length ? [] : images.length ? "singleImage" : "text");
  const isFrames = mode === "startEndRequired" || mode === "endFrameOptional" || mode === "startFrameOptional";

  const content: Record<string, unknown>[] = [{ type: "text", text: request.prompt }];
  if (Array.isArray(mode)) {
    images.forEach((url) => content.push({ role: "reference_image", type: "image_url", image_url: { url } }));
    videos.forEach((url) => content.push({ role: "reference_video", type: "video_url", video_url: { url } }));
    audios.forEach((url) => content.push({ role: "reference_audio", type: "audio_url", audio_url: { url } }));
  } else if (isFrames) {
    frames.forEach(({ url, role }) => content.push({ type: "image_url", image_url: { url }, role }));
  } else if (mode === "singleImage") {
    images.forEach((url) => content.push({ role: "reference_image", type: "image_url", image_url: { url } }));
  }

  // ACT: 上传与提交沿用 10 分钟上限，最终结果由 query 接口单次查询。
  const signal = AbortSignal.any([AbortSignal.timeout(10 * 60_000), ...(this.signal ? [this.signal] : [])]);
  const submitResponse = await this.tool.fetch(`${baseUrl}/v2/video_generation`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: request.model, duration: request.duration, resolution: request.resolution, ratio: request.ratio, content }),
    signal,
  });
  if (!submitResponse.ok) throw new Error(`提交任务失败：HTTP ${submitResponse.status}`);
  const submitData = await submitResponse.json();
  const taskId = submitData?.task_id;
  if (typeof taskId !== "string" || !taskId.trim()) throw new Error("提交任务未返回任务 ID");

  return { taskId };
}

export default {
  id: "meta",
  label: "秘塔版MiniMax H3",
  version,
  readme: `秘塔科技提供高性价比的 MiniMax H3 视频生成服务：768P 仅 0.09 元/秒，2K 仅 0.15 元/秒。支持原生 2K、音画同步，API 兼容 OpenAI 协议，同时支持 ComfyUI、无限画布，无需自行部署 GPU。
 \n 👉 点击 [前往平台](https://metaso.cn/minimax-h3/?s=toon) 获取密钥`,
  rules,
  models: [
    {
      id: "MiniMax-H3",
      label: "MiniMax-H3",
      type: "video",
      mode: ["text", "startFrameOptional", ["imageReference:9", "videoReference:3", "audioReference:3"]],
      audio: "optional",
      durationResolutionMap: [{ duration: [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], resolution: ["768P", "2K"] }],
    },
  ] satisfies ProviderModel[],
  submitVideo,
  queryVideoTask,
  async generateVideo(request: VideoRequest): Promise<MediaAsset[]> {
    const signal = AbortSignal.any([AbortSignal.timeout(10 * 60_000), ...(this.signal ? [this.signal] : [])]);
    const context = { ...this, signal };
    const { taskId } = await submitVideo.call(context, request);
    while (true) {
      const result = await queryVideoTask.call(context, taskId);
      if (result.status === "completed") {
        if (!result.assets?.length) throw new Error("未返回生成结果");
        return result.assets;
      }
      if (result.status === "failed") throw new Error(result.errorMessage || "视频生成失败");
      await wait(signal, 5000);
    }
  },
} satisfies ProviderDefinition<typeof rules>;
