import { createHash } from "node:crypto";
import type { MediaGenerationRequest } from "@toonflow/tools-scaffold/runtime";

function stableValue(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(stableValue);
  const record = value as Record<string, unknown>;
  return Object.keys(record).sort().reduce<Record<string, unknown>>((acc, key) => {
    acc[key] = stableValue(record[key]);
    return acc;
  }, {});
}

export function digestMediaRequest(
  mediaType: "image" | "video" | "audio",
  request: MediaGenerationRequest,
  binding?: { canvasPath: string; nodeId: string; outputSlot: string; expectedNodeVersion: number },
) {
  const payload = stableValue({ mediaType, ...request, binding });
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}
