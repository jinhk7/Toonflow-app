<template>
  <el-card class="mobileAgentPanel" shadow="never">
    <template #header>Agent 运行</template>
    <el-button :loading="loading" @click="loadRuns">刷新运行列表</el-button>
    <el-select v-model="runId" class="runSelect" placeholder="选择运行" @change="loadRun">
      <el-option v-for="run in runs" :key="run.runId" :label="`${run.status} · ${run.modelId} · ${run.runId.slice(0, 8)}`" :value="run.runId" />
    </el-select>
    <template v-if="snapshot">
      <p role="status">{{ snapshot.status }} · {{ snapshot.runId }}</p>
      <el-alert v-if="snapshot.errorMessage" type="warning" :title="snapshot.errorMessage" :closable="false" />
      <div class="actions">
        <el-button v-if="['preparing', 'running', 'waitingApproval'].includes(snapshot.status)" @click="control('pause')">暂停后续</el-button>
        <el-button v-if="['preparing', 'running', 'waitingApproval', 'paused', 'needsReview'].includes(snapshot.status)" type="danger" @click="control('terminate')">终止流程</el-button>
        <el-button v-if="['paused', 'error', 'needsReview', 'waitingApproval'].includes(snapshot.status)" type="primary" :disabled="!!snapshot.reviewCalls?.length || !!snapshot.waitingQuestions.length" @click="control('resume')">继续运行</el-button>
      </div>
      <section v-for="call in snapshot.pendingAuthorizations ?? []" :key="call.toolCallId" class="call">
        <h3>待授权：{{ call.toolName }} · {{ call.modelId }}</h3>
        <pre>{{ JSON.stringify(call.args, null, 2) }}</pre>
        <el-button type="warning" @click="grant(call.toolCallId)">授权此输入执行 1 次</el-button>
      </section>
      <section v-for="call in snapshot.reviewCalls ?? []" :key="call.toolCallId" class="call">
        <h3>外部结果未知：{{ call.toolName }} · {{ call.toolCallId }}</h3>
        <pre>{{ JSON.stringify(call.args, null, 2) }}</pre>
        <el-button type="warning" @click="review(call.toolCallId)">已人工核对，跳过此调用</el-button>
      </section>
      <section v-for="item in snapshot.waitingQuestions" :key="item.callId" class="call">
        <h3>{{ item.request.title }}</h3>
        <p>{{ item.request.question }}</p>
        <template v-if="item.request.fields?.length">
          <el-form labelPosition="top">
            <el-form-item v-for="field in item.request.fields" :key="field.field" :label="field.title" :required="field.required">
              <el-select v-if="field.type === 'radio' || field.type === 'select'" v-model="questionValues[item.callId][field.field]" :aria-label="field.title">
                <el-option v-for="option in field.options ?? []" :key="option" :label="option" :value="option" />
              </el-select>
              <el-checkbox-group v-else-if="field.type === 'checkbox'" v-model="questionValues[item.callId][field.field]">
                <el-checkbox v-for="option in field.options ?? []" :key="option" :value="option">{{ option }}</el-checkbox>
              </el-checkbox-group>
              <el-switch v-else-if="field.type === 'switch'" v-model="questionValues[item.callId][field.field]" :aria-label="field.title" />
              <el-input-number v-else-if="field.type === 'inputNumber'" v-model="questionValues[item.callId][field.field]" :aria-label="field.title" />
              <el-input v-else v-model="questionValues[item.callId][field.field]" :type="field.type === 'textarea' ? 'textarea' : 'text'" :maxlength="8000" :aria-label="field.title" />
            </el-form-item>
          </el-form>
        </template>
        <template v-else>
          <el-select v-if="item.request.options?.length" v-model="questionAnswers[item.callId]" clearable placeholder="选择或自行填写" class="answerInput">
            <el-option v-for="option in item.request.options" :key="option" :label="option" :value="option" />
          </el-select>
          <el-input v-model="questionAnswers[item.callId]" type="textarea" :maxlength="8000" placeholder="回答" :aria-label="item.request.title" />
        </template>
        <div class="actions">
          <el-button type="primary" @click="answer(item, false)">提交回答</el-button>
          <el-button @click="answer(item, true)">跳过</el-button>
        </div>
      </section>
    </template>
  </el-card>
</template>

<script setup lang="ts">
import { onMounted, onUnmounted, ref } from "vue";
import axios from "axios";
import { ElMessage, ElMessageBox } from "element-plus";
import { controlAgentRun, fetchAgentRunSnapshot, grantAgentAuthorization, reviewAgentRun, type AgentRunSnapshot } from "@/components/agent/runClient";

type Question = NonNullable<AgentRunSnapshot["waitingQuestions"]>[number];
type RunSummary = { runId: string; status: string; modelId: string };
const props = defineProps<{ directory: string }>();
const runs = ref<RunSummary[]>([]);
const runId = ref("");
const snapshot = ref<AgentRunSnapshot | null>(null);
const loading = ref(false);
const questionAnswers = ref<Record<string, string>>({});
const questionValues = ref<Record<string, Record<string, any>>>({});
let timer: ReturnType<typeof setInterval> | undefined;

async function loadRun() {
  if (!runId.value) return;
  try {
    snapshot.value = await fetchAgentRunSnapshot(runId.value);
    for (const item of snapshot.value.waitingQuestions) {
      if (questionValues.value[item.callId]) continue;
      questionValues.value[item.callId] = Object.fromEntries((item.request.fields ?? []).map(field => [field.field,
        field.type === "checkbox" ? [] : field.type === "switch" ? false : field.type === "inputNumber" ? undefined : ""]));
    }
  } catch (error) { ElMessage.error(error instanceof Error ? error.message : "读取运行失败"); }
}

async function loadRuns() {
  if (!props.directory) return;
  loading.value = true;
  try {
    const { data } = await axios.get<{ code: number; data: RunSummary[]; message?: string }>("/api/agent/run/list", {
      params: { directory: props.directory }, headers: { "x-toonflow-workspace": "1" },
    });
    if (data.code !== 200) throw new Error(data.message || "读取运行列表失败");
    runs.value = data.data;
    if (!runs.value.some(item => item.runId === runId.value)) runId.value = runs.value[0]?.runId ?? "";
    if (runId.value) await loadRun();
    else snapshot.value = null;
  } catch (error) { ElMessage.error(error instanceof Error ? error.message : "读取运行列表失败"); }
  finally { loading.value = false; }
}

async function control(action: "pause" | "resume" | "terminate") {
  if (!snapshot.value) return;
  if (action === "resume" || action === "terminate") {
    try { await ElMessageBox.confirm(`${action === "resume" ? "继续" : "终止"}运行 ${snapshot.value.runId}？${action === "resume" ? "继续可能调用所选模型；副作用工具仍需单独授权。" : "已提交的媒体任务会继续收取。"}`, "确认运行控制", { confirmButtonText: "确认", cancelButtonText: "取消" }); }
    catch { return; }
  }
  try { await controlAgentRun(snapshot.value.runId, action); await loadRun(); }
  catch (error) { ElMessage.error(error instanceof Error ? error.message : "操作失败"); }
}

async function grant(toolCallId: string) {
  if (!snapshot.value) return;
  try {
    await ElMessageBox.confirm(`只授权运行 ${snapshot.value.runId} 中工具调用 ${toolCallId} 的当前模型和页面所示输入执行 1 次？`, "确认授权", { confirmButtonText: "授权 1 次", cancelButtonText: "取消" });
    snapshot.value = await grantAgentAuthorization(snapshot.value.runId, toolCallId, 1);
  } catch (error) { if (error !== "cancel") ElMessage.error(error instanceof Error ? error.message : "授权失败"); }
}

async function review(toolCallId: string) {
  if (!snapshot.value) return;
  try {
    await ElMessageBox.confirm(`已在外部核对 ${toolCallId} 的实际结果？跳过该调用，不会重新执行。`, "确认逐项核对", { confirmButtonText: "已核对并跳过", cancelButtonText: "取消" });
    snapshot.value = await reviewAgentRun(snapshot.value.runId, toolCallId);
  } catch (error) { if (error !== "cancel") ElMessage.error(error instanceof Error ? error.message : "核对失败"); }
}

async function answer(item: Question, skipped: boolean) {
  const values = questionValues.value[item.callId];
  const response = skipped ? { skipped: true } : item.request.fields?.length ? { values } : { answer: questionAnswers.value[item.callId]?.trim() };
  try {
    const { data } = await axios.post<{ code: number; message?: string }>("/api/agent/answer", {
      directory: props.directory, callId: item.callId, ...response,
    }, { headers: { "x-toonflow-workspace": "1" } });
    if (data.code !== 200) throw new Error(data.message || "回答失败");
    await loadRun();
  } catch (error) { ElMessage.error(axios.isAxiosError(error) ? error.response?.data?.message || "回答失败" : error instanceof Error ? error.message : "回答失败"); }
}

onMounted(() => {
  void loadRuns();
  timer = setInterval(() => { if (runId.value && !document.hidden) void loadRun(); }, 5000);
});
onUnmounted(() => { if (timer) clearInterval(timer); });
</script>

<style scoped lang="scss">
.mobileAgentPanel {
  margin-top: 12px;
  .runSelect, .answerInput { width: 100%; margin-top: 8px; }
  .actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 8px; }
  .call { border-top: 1px solid var(--el-border-color-lighter); margin-top: 12px; padding-top: 12px; }
  pre { white-space: pre-wrap; overflow-wrap: anywhere; max-height: 220px; overflow: auto; }
}
</style>
