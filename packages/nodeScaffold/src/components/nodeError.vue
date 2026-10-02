<template>
  <div class="nodeErrorContent">
    <div class="errorLabel">错误详情</div>
    <div class="errorDetail" tabindex="0">{{ message }}</div>
    <el-button v-if="!explanation || explaining" class="explainButton" size="small" :loading="explaining" :disabled="explaining" @click="explainError">
      {{ explaining ? "正在解释…" : explanationError ? "重试 AI 解释" : "AI 解释" }}
    </el-button>
    <div v-if="explanation || explanationError" class="explanation" aria-live="polite">
      <div class="errorLabel">{{ explanationError ? "暂时无法解释" : "AI 解释" }}</div>
      <div class="explanationText" tabindex="0">{{ explanationError || explanation }}</div>
      <div v-if="explanation && !explanationError" class="explanationHint">由 {{ modelLabel }} 解释，原因是推测，供排查参考。</div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, watch } from "vue";
import { ElButton, ElNotification } from "element-plus";
import { createExecutionClient, executionRequest } from "../executionClient";
import type { NodeJobView } from "../execution";

const props = defineProps<{ message: string; context: string; directory?: string; signal: AbortSignal }>();
const explaining = ref(false);
const explanation = ref("");
const explanationError = ref("");
const modelLabel = ref("");
let commandId = crypto.randomUUID();
let job: NodeJobView | undefined;

watch([explanation, explanationError, explaining], () => ElNotification.updateOffsets(), { flush: "post" });

async function explainError() {
  if (explaining.value || props.signal.aborted) return;
  explaining.value = true;
  explanationError.value = "";
  const signal = AbortSignal.any([props.signal, AbortSignal.timeout(60000)]);
  try {
    if (!props.directory) throw new Error("请先打开项目，再重试 AI 解释。");
    const client = createExecutionClient(props.directory);
    if (job?.status === "failed" || job?.status === "cancelled") { commandId = crypto.randomUUID(); job = undefined; }
    // 响应丢失或等待超时后沿用同一标识，关闭通知只停止观察。
    job ??= await executionRequest<NodeJobView>("/api/ai/explain", {
      method: "POST", headers: { "Content-Type": "application/json" }, signal,
      body: JSON.stringify({ directory: props.directory, commandId, context: props.context.slice(0, 200), message: props.message.slice(0, 8000) }),
    });
    while (job.status === "accepted" || job.status === "running") {
      await new Promise<void>((resolve, reject) => {
        const cancel = () => { clearTimeout(timer); reject(signal.reason); };
        const timer = setTimeout(() => { signal.removeEventListener("abort", cancel); resolve(); }, 500);
        signal.addEventListener("abort", cancel, { once: true });
        if (signal.aborted) cancel();
      });
      job = await client.getJob(job.jobId, signal);
    }
    signal.throwIfAborted();
    if (job.status !== "completed") throw new Error(job.errorMessage || "解释任务需要核对，请在任务历史中查看。");
    const result = job.result as { text?: unknown } | undefined;
    if (typeof result?.text !== "string" || !result.text.trim()) throw new Error("模型没有返回解释，请重试。");
    modelLabel.value = job.summary?.modelLabel ?? "已配置模型";
    explanation.value = result.text.trim();
  } catch (error) {
    if (!props.signal.aborted) explanationError.value = signal.aborted ? "等待超时，后台任务会继续；点击重试可查看原任务。"
      : error instanceof Error ? error.message : "解释暂时不可用，请稍后重试。";
  } finally {
    explaining.value = false;
  }
}
</script>

<style lang="scss">
.nodeErrorNotification {
  width: min(440px, calc(100vw - 32px));

  .el-notification__group {
    min-width: 0;
    flex: 1;
  }

  .nodeErrorContent {
    text-align: left;

    .errorLabel {
      margin-bottom: 4px;
      color: var(--el-text-color-secondary);
      font-size: 12px;
    }

    .errorDetail {
      max-height: 20vh;
      overflow: auto;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
    }

    .explainButton {
      margin-top: 12px;
    }

    .explanation {
      margin-top: 12px;
      padding-top: 12px;
      border-top: 1px solid var(--el-border-color-lighter);

      .explanationText {
        max-height: 30vh;
        overflow: auto;
        white-space: pre-wrap;
        overflow-wrap: anywhere;
      }

      .explanationHint {
        margin-top: 8px;
        color: var(--el-text-color-secondary);
        font-size: 12px;
      }
    }
  }
}
</style>
