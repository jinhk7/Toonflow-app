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
  return Array.isArray(value) ? value as MediaAsset[] : undefined;
}
