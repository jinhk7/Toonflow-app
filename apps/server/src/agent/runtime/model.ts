import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { getConfiguredModel } from "@/utils/ai";
import { createHash } from "node:crypto";

export function getAgentModelRevision(providerId: string, modelId: string) {
  return createHash("sha256").update(JSON.stringify(getConfiguredModel(providerId, modelId))).digest("hex");
}

export async function createAgentModel(providerId: string, modelId: string, thinkingLevel = "off", expectedRevision?: string) {
  const configured = getConfiguredModel(providerId, modelId);
  if (expectedRevision && getAgentModelRevision(providerId, modelId) !== expectedRevision) {
    throw Object.assign(new Error("模型供应商配置已变化，请核对配置后发起新消息"), { code: "AGENT_CONFIGURATION_CHANGED", status: 409 });
  }
  const { provider, model, baseUrl } = configured;
  const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false });
  runtime.registerProvider(providerId, {
    api: provider.protocol,
    baseUrl,
    models: [{
      id: model.id, name: model.label, reasoning: thinkingLevel !== "off",
      // ACT: 保留图片输入，由实际供应方判断该模型是否支持。
      input: ["text", "image"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: model.contextWindow, maxTokens: model.maxOutputTokens,
    }],
  });
  await runtime.setRuntimeApiKey(providerId, provider.apiKey);
  return { ...configured, runtime };
}
