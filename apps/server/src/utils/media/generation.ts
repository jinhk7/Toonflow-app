import { mkdir, readFile, realpath, stat, rm } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { createHash } from "node:crypto";
import { mediaProviders, type Provider } from "@toonflow/providers";
import type { GeneratedMedia, MediaGenerationRequest, MediaModel, MediaReference } from "@toonflow/tools-scaffold/runtime";
import conf from "@/utils/conf";
import { getMediaProvider, listMediaProviders, loadMediaProviderSource } from "@/utils/media/provider";
import { lockWorkspaceFiles, resolveWorkspacePath, writeWorkspaceFile } from "@/utils/workspace/files";

const maxMediaSize = 100 * 1024 * 1024;
const mediaExtensions: Record<string, string> = {
  "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif",
  "image/avif": "avif", "image/bmp": "bmp", "image/tiff": "tiff",
  "video/mp4": "mp4", "video/webm": "webm", "video/quicktime": "mov", "video/ogg": "ogv",
  "audio/mpeg": "mp3", "audio/wav": "wav", "audio/ogg": "ogg", "audio/webm": "webm",
  "audio/flac": "flac", "audio/aac": "aac", "audio/mp4": "m4a", "audio/opus": "opus", "audio/pcm": "pcm",
};

function invalid(message: string): never {
  throw Object.assign(new Error(message), { status: 400 });
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function imageOptions(value: unknown, pattern: RegExp) {
  return Array.isArray(value) ? [...new Set(value.filter((item): item is string => typeof item === "string" && item.length <= 64 && item === item.trim() && pattern.test(item)))] : undefined;
}

export async function listMediaModels(): Promise<MediaModel[]> {
  const installedProviders = await listMediaProviders();
  return installedProviders.flatMap(provider => provider.models.flatMap(model => {
    if (model.type !== "image" && model.type !== "video" && model.type !== "audio") return [];
    const builtIn = (mediaProviders as readonly Provider[]).find(item => item.id === provider.id)?.models.find(item => item.id === model.id);
    return [{
      providerId: provider.id, providerLabel: provider.label, modelId: model.id, label: model.label, type: model.type,
      mode: model.mode, durationResolutionMap: model.durationResolutionMap, audio: model.audio,
      ...(model.type === "audio" ? { voices: model.voices } : {}),
      ...(model.type === "image" ? {
        imageSizes: imageOptions(Array.isArray(model.imageSizes) ? model.imageSizes : builtIn?.imageSizes, /^[^\u0000-\u001f\u007f]+$/),
        imageRatios: imageOptions(Array.isArray(model.imageRatios) ? model.imageRatios : builtIn?.imageRatios, /^[1-9]\d{0,3}:[1-9]\d{0,3}$/),
      } : {}),
    } as MediaModel];
  }));
}

function detectMimeType(bytes: Uint8Array, fallback: string) {
  const header = Buffer.from(bytes.buffer, bytes.byteOffset, Math.min(bytes.byteLength, 16));
  const text = header.toString("ascii");
  const mimeType = fallback.split(";")[0].trim().toLowerCase();
  if (header.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "image/png";
  if (header[0] === 255 && header[1] === 216 && header[2] === 255) return "image/jpeg";
  if (/^GIF8[79]a/.test(text)) return "image/gif";
  if (text.startsWith("RIFF") && text.slice(8, 12) === "WEBP") return "image/webp";
  if (text.startsWith("RIFF") && text.slice(8, 12) === "WAVE") return "audio/wav";
  if (text.startsWith("fLaC")) return "audio/flac";
  if (text.startsWith("OggS")) return mimeType.startsWith("video/") ? "video/ogg" : mimeType === "audio/opus" ? "audio/opus" : "audio/ogg";
  if (header[0] === 0xff && (header[1]! & 0xf6) === 0xf0) return "audio/aac";
  if (text.startsWith("ID3") || (header[0] === 0xff && (header[1]! & 0xe0) === 0xe0 && (header[1]! & 0x06) !== 0)) return "audio/mpeg";
  if (text.slice(4, 8) === "ftyp") {
    if (/avif|avis/.test(text.slice(8))) return "image/avif";
    if (/^M4[AB] $/.test(text.slice(8, 12)) || mimeType.startsWith("audio/")) return "audio/mp4";
    return text.slice(8, 12) === "qt  " ? "video/quicktime" : "video/mp4";
  }
  if (header.subarray(0, 4).equals(Buffer.from([26, 69, 223, 163]))) return mimeType.startsWith("audio/") ? "audio/webm" : "video/webm";
  return ({ "image/jpg": "image/jpeg", "audio/mp3": "audio/mpeg", "audio/x-wav": "audio/wav", "audio/wave": "audio/wav", "audio/x-flac": "audio/flac" } as Record<string, string>)[mimeType] ?? mimeType;
}

export async function readReference(cwd: string, reference: MediaReference, mediaType: string, signal?: AbortSignal): Promise<Extract<MediaInput, { type: "base64" }>> {
  signal?.throwIfAborted();
  const { path } = await resolveWorkspacePath(cwd, reference.path);
  const info = await stat(path);
  if (!info.isFile() || info.size > maxMediaSize) invalid("参考媒体须为不超过 100 MB 的文件");
  const bytes = await readFile(path, { signal });
  if (!bytes.length || bytes.length > maxMediaSize) invalid("参考媒体为空或超过 100 MB");
  const mimeType = detectMimeType(bytes, reference.mimeType);
  if (!mimeType.startsWith(`${mediaType}/`)) invalid(`参考媒体类型须为 ${mediaType}`);
  return { type: "base64", data: bytes.toString("base64"), mimeType };
}
export function mediaInputDirectory(jobId: string) {
  return join(dirname(conf.path), "mediaInputs", jobId);
}

export async function snapshotMediaRequest(cwd: string, jobId: string, request: MediaGenerationRequest): Promise<MediaGenerationRequest> {
  const target = mediaInputDirectory(jobId);
  await mkdir(target, { recursive: true, mode: 0o700 });
  async function copyReference(reference: MediaReference, type: string, name: string) {
    const { path } = await resolveWorkspacePath(cwd, reference.path);
    const info = await stat(path);
    if (!info.isFile() || !info.size || info.size > maxMediaSize) invalid("参考媒体为空或超过 100 MB");
    const bytes = await readFile(path);
    if (!bytes.length || bytes.length > maxMediaSize) invalid("参考媒体为空或超过 100 MB");
    const mimeType = detectMimeType(bytes, reference.mimeType);
    if (!mimeType.startsWith(type + "/")) invalid("参考媒体类型须为 " + type);
    await writeWorkspaceFile(join(target, name), bytes, true);
    return { ...reference, path: name, mimeType };
  }
  try {
    const copy = async (items: MediaReference[] | undefined, type: string) => {
      if (!items) return undefined;
      const result: MediaReference[] = [];
      for (const [index, item] of items.entries()) result.push(await copyReference(item, type, type + index));
      return result;
    };
    return { ...request, images: await copy(request.images, "image"), videos: await copy(request.videos, "video"),
      audios: await copy(request.audios, "audio"),
      firstFrame: request.firstFrame ? await copyReference(request.firstFrame, "image", "firstFrame") : undefined,
      lastFrame: request.lastFrame ? await copyReference(request.lastFrame, "image", "lastFrame") : undefined };
  } catch (error) {
    await rm(target, { recursive: true, force: true });
    throw error;
  }
}

async function downloadAsset(url: string, signal?: AbortSignal) {
  // 收取也必须能退出：超时保留结果快照，用户只重试下载而不是重新生成。
  signal = AbortSignal.any([AbortSignal.timeout(5 * 60_000), ...(signal ? [signal] : [])]);
  if (!/^https?:\/\//i.test(url)) invalid("生成结果必须使用 HTTP 或 HTTPS 地址");
  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error(`下载生成结果失败（HTTP ${response.status}）`);
  if (Number(response.headers.get("content-length")) > maxMediaSize) {
    await response.body?.cancel();
    invalid("生成文件不能超过 100 MB");
  }
  const reader = response.body?.getReader();
  if (!reader) invalid("生成结果为空");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      signal?.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxMediaSize) invalid("生成文件不能超过 100 MB");
      chunks.push(value);
    }
  } finally { await reader.cancel(); }
  return { bytes: Buffer.concat(chunks, size), mimeType: response.headers.get("content-type") ?? "" };
}

async function assetBytes(asset: MediaAsset, mediaType: "image" | "video" | "audio", signal?: AbortSignal) {
  if (!asset || asset.mediaType !== mediaType) invalid("供应商返回的媒体类型不正确");
  let bytes: Uint8Array;
  let mimeType = asset.mimeType ?? "";
  if (asset.type === "url") {
    const result = await downloadAsset(asset.url, signal);
    bytes = result.bytes;
    mimeType = result.mimeType || mimeType;
  } else if (asset.type === "base64") {
    const data = /^data:([^;,]+);base64,([\s\S]+)$/.exec(asset.data);
    const content = (data?.[2] ?? asset.data).replace(/\s/g, "");
    if (content.length > Math.ceil(maxMediaSize / 3) * 4 || !/^[a-zA-Z0-9+/]*={0,2}$/.test(content) || content.length % 4 === 1) invalid("生成结果的 base64 内容无效或超过 100 MB");
    bytes = Buffer.from(content, "base64");
    mimeType = data?.[1] ?? mimeType;
  } else if (asset.type === "binary" && ArrayBuffer.isView(asset.data) && asset.data.BYTES_PER_ELEMENT === 1) {
    bytes = asset.data;
  } else { return invalid("供应商返回了无效的媒体结果"); }
  if (!bytes.byteLength || bytes.byteLength > maxMediaSize) invalid("生成文件为空或超过 100 MB");
  mimeType = detectMimeType(bytes, mimeType);
  if (!mimeType.startsWith(`${mediaType}/`) || !mediaExtensions[mimeType]) invalid("生成结果不是支持的图片、视频或音频格式");
  return { bytes, mimeType };
}

const loadedMediaProvider = {} as Awaited<ReturnType<typeof loadMediaProviderSource>>;
export type LoadedMediaProvider = typeof loadedMediaProvider;

export async function loadMediaGenerationProvider(
  cwd: string,
  mediaType: "image" | "video" | "audio",
  request: MediaGenerationRequest,
  signal?: AbortSignal,
  expectedRevision?: string,
): Promise<LoadedMediaProvider> {
  signal?.throwIfAborted();
  if (!request.prompt.trim()) invalid("请输入生成提示词");
  const providerInfo = await getMediaProvider(request.providerId);
  if (!expectedRevision || providerInfo.revision !== expectedRevision)
    throw Object.assign(new Error("媒体供应商版本已变化或历史任务缺少版本，不能自动继续"), { status: 409 });
  const model = providerInfo.models.find(item => item.id === request.modelId && item.type === mediaType);
  if (!model) invalid("所选媒体模型不存在或类型不匹配，请重新选择");
  const configurations = record(conf.get("settings", {}).mediaProviderConfigs);
  const directory = await realpath(cwd);
  const provider = await loadMediaProviderSource(providerInfo.source, record(configurations[providerInfo.id]), signal, undefined, directory);
  const rules = Array.isArray(provider.rules) ? provider.rules : [];
  if (rules.some(rule => rule.field === "apiKey") && (typeof provider.config.apiKey !== "string" || !provider.config.apiKey.trim())) {
    invalid("请先在媒体模型设置中配置供应商 API Key");
  }
  return provider;
}

export async function buildProviderMediaRequest(
  cwd: string,
  mediaType: "image" | "video" | "audio",
  request: MediaGenerationRequest,
  provider: LoadedMediaProvider,
  signal?: AbortSignal,
  snapshotDirectory?: string,
) {
  signal?.throwIfAborted();
  const directory = await realpath(cwd);
  const references = async (items: MediaReference[] | undefined, type: string) => items
    ? Promise.all(items.map(item => readReference(snapshotDirectory ?? directory, item, type, signal)))
    : undefined;
  const images = await references(request.images, "image");
  signal?.throwIfAborted();
  if (mediaType === "audio") {
    return {
      model: request.modelId,
      text: request.prompt,
      audios: await references(request.audios, "audio"),
      voice: request.voice,
      speed: request.speed,
      volume: request.volume,
      format: request.format,
      sampleRate: request.sampleRate,
    };
  }
  if (mediaType === "image") {
    return { model: request.modelId, prompt: request.prompt, images, ratio: request.ratio, size: request.size };
  }
  return {
    model: request.modelId,
    prompt: request.prompt,
    images,
    videos: await references(request.videos, "video"),
    audios: await references(request.audios, "audio"),
    firstFrame: request.firstFrame ? await readReference(snapshotDirectory ?? directory, request.firstFrame, "image", signal) : undefined,
    lastFrame: request.lastFrame ? await readReference(snapshotDirectory ?? directory, request.lastFrame, "image", signal) : undefined,
    ratio: request.ratio,
    resolution: request.resolution,
    duration: request.duration,
    generateAudio: request.generateAudio,
    mode: request.mode,
  };
}

// 供应商返回值由任务收取阶段校验；不能把已返回的畸形成果误判为提交结果未知。
export async function generateProviderAssets(
  cwd: string,
  mediaType: "image" | "video" | "audio",
  request: MediaGenerationRequest,
  provider: LoadedMediaProvider,
  signal?: AbortSignal,
  preparedRequest?: Awaited<ReturnType<typeof buildProviderMediaRequest>>,
): Promise<MediaAsset[]> {
  const providerRequest = preparedRequest ?? await buildProviderMediaRequest(cwd, mediaType, request, provider, signal);
  if (mediaType === "audio") {
    if (typeof provider.generateAudio !== "function") invalid("此供应商不支持音频生成");
    const assets = await provider.generateAudio(providerRequest as never);
    return assets;
  }
  if (mediaType === "image") {
    if (typeof provider.generateImage !== "function") invalid("此供应商不支持图片生成");
    const assets = await provider.generateImage(providerRequest as never);
    return assets;
  }
  if (typeof provider.generateVideo !== "function") invalid("此供应商不支持视频生成");
  const assets = await provider.generateVideo(providerRequest as never);
  return assets;
}

function jobOutputDirectory(request: MediaGenerationRequest, jobId: string) {
  const base = request.outputDirectory ?? "assets/generated";
  return `${base.replace(/\\/g, "/").replace(/\/+$/, "")}/jobs/${jobId}`;
}

export type CollectedMedia = GeneratedMedia & { index: number; sha256: string };

export async function persistProviderAssets(
  cwd: string,
  mediaType: "image" | "video" | "audio",
  jobId: string,
  request: MediaGenerationRequest,
  assets: MediaAsset[],
  signal?: AbortSignal,
  progress?: { files: CollectedMedia[]; save: (files: CollectedMedia[]) => void },
): Promise<GeneratedMedia[]> {
  signal?.throwIfAborted();
  const directory = await realpath(cwd);
  const outputDirectory = jobOutputDirectory(request, jobId);
  await resolveWorkspacePath(directory, outputDirectory, true);
  const result: GeneratedMedia[] = [];
  for (const [index, asset] of assets.entries()) {
    signal?.throwIfAborted();
    const saved = progress?.files.find(file => file.index === index);
    if (saved) {
      const expected = `${outputDirectory}/${mediaType}${index}.${mediaExtensions[saved.mimeType]}`;
      if (saved.path !== expected || saved.mediaType !== mediaType) throw new Error("已收取文件记录与任务不匹配，拒绝覆盖");
      const { path } = await resolveWorkspacePath(directory, saved.path);
      const bytes = await readFile(path);
      if (createHash("sha256").update(bytes).digest("hex") !== saved.sha256) throw new Error("已收取的任务成果已变化，拒绝覆盖");
      result.push({ path: saved.path, mimeType: saved.mimeType, mediaType });
      continue;
    }
    const { bytes, mimeType } = await assetBytes(asset, mediaType, signal);
    const output = await resolveWorkspacePath(directory, outputDirectory, true);
    const release = lockWorkspaceFiles([output.path]);
    try {
      await mkdir(output.path, { recursive: true });
      const file = join(outputDirectory, mediaType + index + "." + mediaExtensions[mimeType]);
      const { path } = await resolveWorkspacePath(directory, file);
      signal?.throwIfAborted();
      try { await writeWorkspaceFile(path, bytes, true); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const saved = await readFile(path);
        if (!Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).equals(saved)) throw new Error("已保存的任务成果内容不一致，拒绝覆盖");
      }
      const collected = { path: relative(directory, path).replace(/\\/g, "/"), mimeType, mediaType };
      result.push(collected);
      if (progress) {
        progress.files.push({ ...collected, index, sha256: createHash("sha256").update(bytes).digest("hex") });
        progress.save(progress.files);
      }
    } finally { release(); }
  }
  return result;
}

export type GenerateMediaOptions = {
  signal?: AbortSignal;
  idempotencyKey?: string;
};

export async function generateMedia(
  cwd: string,
  mediaType: "image" | "video" | "audio",
  request: MediaGenerationRequest,
  signalOrOptions?: AbortSignal | GenerateMediaOptions,
): Promise<GeneratedMedia[]> {
  const options: GenerateMediaOptions = signalOrOptions instanceof AbortSignal
    ? { signal: signalOrOptions }
    : signalOrOptions ?? {};
  const { submitAndWaitMediaJob } = await import("@/utils/media/mediaJobs");
  return submitAndWaitMediaJob(cwd, mediaType, request, options);
}
