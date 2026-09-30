import type { Provider } from "@toonflow/providers";
import type { MediaJobRow } from "@/utils/media/jobLedger";

export function providerAsyncCapability(provider: Provider, mediaType: MediaJobRow["mediaType"]) {
  if (mediaType === "image") {
    return {
      submit: provider.submitImage,
      query: provider.queryImageTask,
      generate: provider.generateImage,
    };
  }
  if (mediaType === "video") {
    return {
      submit: provider.submitVideo,
      query: provider.queryVideoTask,
      generate: provider.generateVideo,
    };
  }
  return {
    submit: provider.submitAudio,
    query: provider.queryAudioTask,
    generate: provider.generateAudio,
  };
}

export function parsePendingAssets(json: string | null): MediaAsset[] | undefined {
  if (!json) return undefined;
  const value = JSON.parse(json) as unknown;
  if (!Array.isArray(value)) return undefined;
  return value.map((asset: MediaAsset) => {
    if (asset?.type !== "binary" || ArrayBuffer.isView(asset.data)) return asset;
    // 兼容旧账本中 Uint8Array 被 JSON.stringify 为数字键对象的快照。
    const entries = Object.entries(asset.data ?? {});
    if (!entries.length || entries.length > 100 * 1024 * 1024
      || entries.some(([key, byte], index) => key !== String(index) || !Number.isInteger(byte) || Number(byte) < 0 || Number(byte) > 255))
      throw new Error("旧二进制结果快照无效，无法安全恢复");
    return { ...asset, type: "base64", data: Buffer.from(entries.map(([, byte]) => Number(byte))).toString("base64") } as MediaAsset;
  });
}
