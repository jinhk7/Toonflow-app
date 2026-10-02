<template>
  <div class="agentConversation">
    <div class="messageViewport t-chat t-chat--normal">
      <div ref="messageList" class="messageList t-chat__list" role="region" aria-label="对话消息" tabindex="0">
        <chat-item v-if="!messages.length && !disabled" role="assistant" variant="text">
          <template #content>
            <section class="welcomeMessage" aria-label="开始新对话">
              <div class="welcomeHeader">
                <span class="welcomeIcon" aria-hidden="true"><span class="welcomeLogo" :style="{ maskImage: `url(${logoUrl})` }" /></span>
                <div>
                  <p class="welcomeLabel">你好，我是 Toonflow 助手</p>
                  <h3>从一个想法开始</h3>
                </div>
              </div>
              <p class="welcomeDescription">聊聊你的故事、画面或镜头，让我们一起把想法落到画布上。</p>
              <div class="welcomeSuggestions">
                <el-button v-for="item in welcomeSuggestions" :key="item.label" class="welcomeSuggestion" text bg :disabled="locked" :aria-label="`填入提示：${item.label}`" @click="fillPrompt(item.prompt)">
                  <component :is="item.icon" :size="19" aria-hidden="true" />
                  <span class="suggestionContent"><strong>{{ item.label }}</strong><span>{{ item.description }}</span></span>
                  <icon-arrow-up-right class="suggestionArrow" :size="15" aria-hidden="true" />
                </el-button>
              </div>
              <p class="welcomeHint">点击填入提示，也可以直接输入，或粘贴图片、视频。</p>
            </section>
          </template>
        </chat-item>
        <div class="messageSpace" :style="{ height: `${messageVirtualizer.getTotalSize()}px` }">
          <div
            v-for="{ item, row } in visibleMessages"
            :key="item.id"
            :ref="measureMessage"
            :data-index="row.index"
            :data-message-id="item.id"
            class="messageRow"
            :style="{ transform: `translateY(${row.start}px)` }"
            :class="{ userMessage: item.role === 'user', editingMessage: editingId === item.id }">
            <chat-item :role="item.role" :variant="item.role === 'user' ? 'base' : 'text'" :textLoading="!!item.streaming && !compacting && !item.parts?.some(part => part.type === 'tool' || part.content)" animation="moving">
              <template #content>
                <div class="messageContent">
                  <div v-if="item.report" class="reportHeader"><icon-users-group :size="14" />{{ item.report.name }} 上报</div>
                  <template v-for="part in item.parts" :key="part.id">
                    <chat-reasoning v-if="part.type === 'thinking' && part.content" class="messageReasoning" :collapsed="part.collapsed ?? true" expandIconPlacement="left" @update:collapsed="part.collapsed = $event">
                      <template #header>
                        <span class="reasoningHeader">
                          <icon-atom :size="14" />
                          <span>思考</span>
                          <span v-if="part.duration !== undefined" class="thinkingDuration">{{ part.duration.toFixed(1) }} 秒</span>
                        </span>
                      </template>
                      <messageMarkdown v-if="!(part.collapsed ?? true)" :content="part.content" :streaming="!!item.streaming" :directory="directory" />
                    </chat-reasoning>
                    <toolMessage v-else-if="part.type === 'tool'" v-model:collapsed="part.collapsed" :tool="part.tool" :directory="directory" @copy="copyMessage" />
                    <messageMarkdown v-else-if="part.type === 'text' && part.content" :content="part.content" :streaming="!!item.streaming" :directory="directory" />
                  </template>
                  <attachmentList v-if="item.attachments?.length" :attachments="item.attachments" :directory="directory" />
                  <div v-if="item.role === 'user'" class="messageText"><mentionContent :content="item.content" :mentions="item.mentions" :directory="directory" /></div>
                  <div v-if="item.error" class="messageError" role="alert">{{ item.error }}</div>
                </div>
              </template>
            </chat-item>
            <div v-if="!item.streaming" class="messageActions">
              <template v-if="editingId === item.id">
                <el-button text size="small" :disabled="busy || deletingId !== undefined" @click="cancelEdit"><icon-x :size="14" />取消</el-button>
                <span class="editingHint">正在下方编辑</span>
              </template>
              <template v-else>
                <el-button v-if="item.content" class="messageAction" text circle aria-label="复制消息" title="复制消息" @click="copyMessage(mentionPlainText(item.content, item.mentions))"><icon-copy :size="14" /></el-button>
                <template v-if="item.role === 'user'">
                  <el-button class="messageAction" text circle :disabled="locked || remoteRunning" aria-label="编辑消息" title="编辑消息" @click="editMessage(item)"><icon-pencil :size="14" /></el-button>
                </template>
                <el-button v-if="!item.report" class="messageAction" text circle :loading="deletingId === item.id" :disabled="locked || remoteRunning" aria-label="删除消息" title="删除消息" @click="deleteMessage(item)"><icon-trash v-if="deletingId !== item.id" :size="14" /></el-button>
              </template>
            </div>
          </div>
        </div>
      </div>
      <el-button v-if="messages.length && !atLatestMessage" class="scrollBottom" circle aria-label="回到最新消息" title="回到最新消息" @click="messageVirtualizer.scrollToEnd()"><icon-arrow-down :size="18" /></el-button>
    </div>
    <div v-if="compacting" class="compactionStatus" role="status">
      <el-icon class="is-loading" aria-hidden="true"><icon-loader-2 :size="14" /></el-icon>
      <span>正在压缩上下文…</span>
    </div>
    <div class="messageInput">
      <div v-if="connectionError" class="connectionStatus" role="status">{{ connectionError }}</div>
      <el-button v-if="pendingInput" size="small" :disabled="busy" @click="retryPendingMessage">查询并恢复待确认消息</el-button>
      <div v-if="editingId" class="editingBanner"><span>编辑消息</span><el-button text size="small" :disabled="busy" @click="cancelEdit">取消</el-button></div>
      <div
        class="senderResizeHandle"
        role="separator"
        aria-orientation="horizontal"
        aria-label="调整输入框高度"
        aria-valuemin="44"
        :aria-valuemax="senderMaxHeight"
        :aria-valuenow="senderHeight"
        tabindex="0"
        title="拖动调整输入框高度"
        @focus="senderHeight = sender?.chatElement.rollBox.clientHeight ?? 44"
        @pointerdown="startSenderResize"
        @pointermove="moveSenderResize"
        @pointerup="stopSenderResize"
        @pointercancel="stopSenderResize"
        @lostpointercapture="stopSenderResize"
        @keydown.up.prevent="setSenderHeight((sender?.chatElement.rollBox.clientHeight ?? 44) + 16)"
        @keydown.down.prevent="setSenderHeight((sender?.chatElement.rollBox.clientHeight ?? 44) - 16)" />
      <attachmentList v-if="draftAttachments.length" class="draftAttachments" :attachments="draftAttachments" :directory="directory" removable @remove="draftAttachments.splice($event, 1)" />
      <div ref="senderElement" class="senderEditor" @keydown.capture="handleSenderKeydown"></div>
      <teleport v-for="target in draftMentionTargets" :key="target.key" :to="target.element"><mentionThumbnail v-bind="mentionThumbnailProps(target.mention)" :directory="directory"><icon-photo :size="14" /></mentionThumbnail></teleport>
      <mentionContent ref="draftMentionPreview" :mentions="draftMentions" :directory="directory" removable @remove="removeDraftMention" />
      <div class="senderActions">
        <modelPopover v-model="selectedModel" v-model:reasoningEffort="reasoningEffort" :active="active" :disabled="disabled" />
        <el-button v-if="currentRunId && remoteRunning" class="runControlButton" text size="small" :disabled="disabled || deletingId !== undefined" @click="pauseRun">暂停后续</el-button>
        <el-button v-if="currentRunId && remoteRunning" class="runControlButton" text size="small" :disabled="disabled || deletingId !== undefined" @click="terminateRun">终止流程</el-button>
        <el-button v-if="currentRunId && resumableRun" class="runControlButton" text size="small" :disabled="disabled || deletingId !== undefined" @click="resumeRun">继续运行</el-button>
        <mentionMenu ref="mentionMenuRef" :directory="directory" :active="active" :disabled="locked || !directory" :query="mentionQuery" :editor="senderElement" :currentCanvasId="currentCanvasId" @open="captureMentionPosition" @select="insertMentions" @dismiss="mentionQuery = undefined" />
        <skillMenu ref="skillMenuRef" :directory="directory" :active="active" :disabled="locked || !directory" :query="skillQuery" :editor="senderElement" @select="selectSkill" @dismiss="skillQuery = undefined" />
        <el-popover
          v-model:visible="contextMenuVisible"
          trigger="click"
          placement="top"
          :width="280"
          :offset="10"
          :showArrow="false"
          popperClass="agentContextPopover">
          <template #reference>
            <el-button class="contextButton" text circle aria-label="查看上下文用量" title="查看上下文用量">
              <icon-circle-dashed :size="14" />
            </el-button>
          </template>
          <div class="contextUsage">
            <div class="contextHeader"><span>上下文用量</span><span class="contextHint">估算</span></div>
            <template v-if="contextUsage?.tokens != null">
              <div class="contextTokens">
                <span>{{ contextUsage.tokens.toLocaleString() }} / {{ contextWindow.toLocaleString() }} tok</span>
                <span>{{ contextPercent.toFixed(1) }}%</span>
              </div>
              <el-progress :percentage="Math.min(100, contextPercent)" :showText="false" />
            </template>
            <span v-else class="contextHint">{{ contextUsage ? "等待下一次回复更新用量" : "尚无用量数据" }}</span>
            <div v-if="stats" class="contextStats">
              <div class="contextHeader">对话累计用量</div>
              <div class="contextTokens"><span>输入</span><span>{{ inputTokens.toLocaleString() }} tok</span></div>
              <div class="contextTokens"><span>输出</span><span>{{ stats.tokens.output.toLocaleString() }} tok</span></div>
              <div v-if="inputTokens > 0" class="contextTokens"><span>缓存命中</span><span>{{ (stats.tokens.cacheRead / inputTokens * 100).toFixed(1) }}%</span></div>
              <div v-if="stats.tokensPerSecond !== undefined" class="contextTokens"><span>生成速度</span><span>{{ stats.tokensPerSecond.toFixed(1) }} tok/s</span></div>
            </div>
          </div>
        </el-popover>
        <el-button class="sendButton" type="primary" circle :disabled="!busy && locked" :aria-label="busy ? '停止生成' : editingId ? '重发消息' : '发送消息'" :title="busy ? '停止生成' : editingId ? '重发消息' : '发送消息'" @click="busy ? stopMessage() : submitMessage()">
          <icon-player-stop-filled v-if="busy" :size="14" />
          <icon-arrow-up v-else :size="16" />
        </el-button>
      </div>
    </div>
    <authorizationPrompt :runId="currentRunId" :errorMessage="authorizationError" />
    <el-dialog v-model="reviewOpen" title="核对未知副作用" width="min(560px, 92vw)">
      <p>以下调用的外部结果未知；核对后只允许跳过，不会重新执行。</p>
      <div v-for="item in reviewCalls" :key="item.toolCallId" class="reviewCall">
        <strong>{{ item.toolName }} · {{ item.toolCallId }}</strong>
        <pre>{{ JSON.stringify(item.args, null, 2) }}</pre>
        <el-button type="warning" :loading="reviewingId === item.toolCallId" @click="confirmReview(item.toolCallId)">确认已核对，跳过此调用</el-button>
      </div>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { computed, inject, nextTick, onBeforeUnmount, onMounted, reactive, ref, shallowRef, watch, type ComponentPublicInstance } from "vue";
import { defaultRangeExtractor, observeElementRect, useVirtualizer } from "@tanstack/vue-virtual";
import axios from "axios";
import {
  IconArrowUp, IconArrowDown, IconAtom, IconCopy,
  IconCircleDashed, IconPencil, IconPlayerStopFilled, IconX, IconLoader2,
  IconTrash, IconLayoutGrid, IconMovie, IconPhoto, IconArrowUpRight, IconUsersGroup,
} from "@tabler/icons-vue";
import { ElMessage } from "element-plus";
import logoUrl from "@toonflow/assets/logo.svg";
import modelPopover from "@/components/modelPopover.vue";
import skillMenu from "./skillMenu.vue";
import mentionMenu from "./mentionMenu.vue";
import mentionContent from "./mentionContent.vue";
import mentionThumbnail from "./mentionThumbnail.vue";
import { mentionName, mentionParts, mentionPlainText, mentionThumbnailProps } from "./mentionText";
import toolMessage from "./toolMessage.vue";
import attachmentList from "./attachmentList.vue";
import useWorkspaceFiles from "@/lib/workspaceFiles";
import { writeClipboardText } from "@/lib/clipboard";
import anonymousData from "@/lib/anonymousData";
import { modelChoices } from "@/stores/settings";
import { useWorkspaceStore } from "@/stores/workspace";
import type { AgentAttachment, AgentConversation, AgentMessage } from "./types";
import type { AgentEvent, AgentMention } from "@toonflow/server/agent/types";
import { createConversationStream } from "./replyStream";
import { acceptAgentMessage, controlAgentRun, fetchAgentRunSnapshot, getAcceptedAgentMessage, clearPendingAgentMessage, pendingAgentMessages, reviewAgentRun, subscribeAgentRunEvents, type AgentAcceptInput, type AgentRunSnapshot } from "./runClient";
import authorizationPrompt from "./authorizationPrompt.vue";
import type { CanvasContext } from "@toonflow/tool-canvas/runtime";
import { ExecutionRequestError, getExecutionClientId } from "@toonflow/nodes-scaffold/runtime";
import chatItem from "@tdesign-vue-next/chat/es/chat-item";
import chatReasoning from "@tdesign-vue-next/chat/es/chat-reasoning";
import messageMarkdown from "@/components/messageMarkdown.vue";
import xSender, { type AnyTagProps } from "x-sender";
import "tdesign-vue-next/es/style/index.css";
import "@tdesign-vue-next/chat/es/style/index.css";
import "x-sender/lib/XSender.css";

const props = defineProps<{ active: boolean; initialSession: AgentConversation | null; sessionFile?: string; disabled: boolean; directory?: string; canvasId?: string; selectedNodeIds?: string[] }>();
const emit = defineEmits<{ session: [file: string]; sent: [prompt: string]; event: [event: AgentEvent] }>();
const workspaceStore = useWorkspaceStore();
const directory = props.directory ?? workspaceStore.project?.directory;
const draftAttachments = ref<AgentAttachment[]>([]);
const createCanvasContext = inject<(() => CanvasContext | undefined) | undefined>("canvas", undefined);
const getAgentCanvasContext = inject<(() => { id: string; selectedNodeIds: string[] } | undefined) | undefined>("agentCanvasContext", undefined);
const messages = ref<AgentMessage[]>([]);
const stream = createConversationStream(messages);
stream.restore(props.initialSession?.messages ?? []);
const remoteRunning = ref(props.initialSession?.running ?? false);
const currentRunId = ref(props.initialSession?.eventCursor?.runId ?? props.initialSession?.activeRun?.runId);
const runStatus = ref(props.initialSession?.activeRun?.status);
const authorizationError = ref<string>();
const reviewOpen = ref(false);
const reviewCalls = ref<NonNullable<AgentRunSnapshot["reviewCalls"]>>([]);
const reviewingId = ref<string>();
let eventCursor = props.initialSession?.eventCursor?.afterSeq ?? props.initialSession?.activeRun?.lastEventSeq ?? 0;
let reconnectController: AbortController | undefined;
let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
let reconnectDelay = 1000;
let disposed = false;
const connectionError = ref("");
const pendingInput = ref<AgentAcceptInput>();
const boundSessionFile = ref(props.sessionFile);
const currentCanvasId = computed(() => props.canvasId ?? getAgentCanvasContext?.()?.id ?? createCanvasContext?.()?.id);
const stats = ref(props.initialSession?.stats);
const contextUsage = ref(props.initialSession?.contextUsage);
const busy = ref(false);
const compacting = ref(false);
const deletingId = ref<string>();
const locked = computed(() => props.disabled || busy.value || deletingId.value !== undefined);
const resumableRun = computed(() => {
  return Boolean(currentRunId.value && runStatus.value && ["paused", "needsReview", "error", "waitingApproval"].includes(runStatus.value));
});
const editingId = ref<string>();
const draftMentions = ref<AgentMention[]>([]);
const draftMentionTargets = shallowRef<{ key: symbol; element: HTMLElement; mention: AgentMention }[]>([]);
const draftMentionPreview = ref<InstanceType<typeof mentionContent>>();
let editDraft: { model: AnyTagProps[][]; mentions: AgentMention[]; attachments: AgentAttachment[] } | undefined;
const messageList = ref<HTMLDivElement>();
const atLatestMessage = ref(true);
let messageListInitialized = false;
let messageScrollOffset = 0;
const messageKeys = computed(() => messages.value.map(item => item.id));
const retainedMessages = computed(() => messages.value.flatMap((item, index) => item.streaming || item.id === editingId.value ? [index] : []));
const messageVirtualizer = useVirtualizer<HTMLDivElement, HTMLDivElement>(computed(() => {
  const keys = messageKeys.value;
  const retained = retainedMessages.value;
  return {
    count: keys.length,
    getScrollElement: () => messageList.value ?? null,
    getItemKey: (index: number) => keys[index]!,
    estimateSize: () => 240,
    overscan: 3,
    paddingStart: 12,
    anchorTo: "end" as const,
    followOnAppend: true,
    scrollEndThreshold: 48,
    useAnimationFrameWithResizeObserver: true,
    useCachedMeasurements: !props.active,
    // ACT: v-show 隐藏时保留视口与行高，避免零尺寸清空正在输入的工具表单。
    observeElementRect: (instance, onChange) => observeElementRect(instance, rect => { if (rect.height) onChange(rect); }),
    rangeExtractor: range => [...new Set([...defaultRangeExtractor(range), ...retained])].sort((left, right) => left - right),
    onChange(instance) {
      if (!messageListInitialized || !props.active || !messageList.value?.clientHeight) return;
      atLatestMessage.value = instance.isAtEnd();
      messageScrollOffset = instance.scrollOffset ?? 0;
    },
  };
}));
const visibleMessages = computed(() => messageVirtualizer.value.getVirtualItems().map(row => ({ row, item: messages.value[row.index]! })));

function measureMessage(element: Element | ComponentPublicInstance | null) {
  messageVirtualizer.value.measureElement(element instanceof HTMLDivElement ? element : null);
}

watch([() => props.active, messageList], async ([active, element]) => {
  if (!active || !element) return;
  await nextTick();
  if (!props.active) return;
  if (!messageListInitialized || atLatestMessage.value) messageVirtualizer.value.scrollToEnd();
  else messageVirtualizer.value.scrollToOffset(messageScrollOffset);
  messageListInitialized = true;
}, { immediate: true, flush: "post" });
let sender: xSender | undefined;
let controller: AbortController | undefined;
const senderElement = ref<HTMLElement>();
const skillMenuRef = ref<InstanceType<typeof skillMenu>>();
const skillQuery = ref<string>();
const mentionMenuRef = ref<InstanceType<typeof mentionMenu>>();
const mentionQuery = ref<string>();
let mentionPosition: { node: ReturnType<xSender["getCurrentNode"]>; remove: number } | undefined;
let insertingMentions = false;
const senderHeight = ref(44);
const senderMaxHeight = ref(Math.max(44, window.innerHeight / 2));
let senderResize: { pointerId: number; y: number; height: number } | undefined;
const pendingMessage = props.initialSession?.parentFile ? undefined : workspaceStore.pendingAgentMessage;
const selectedModel = ref(pendingMessage?.model ?? (props.initialSession?.providerId && props.initialSession.modelId
  ? JSON.stringify([props.initialSession.providerId, props.initialSession.modelId]) : ""));
const contextMenuVisible = ref(false);
const reasoningEffort = ref(pendingMessage?.reasoningEffort ?? (props.initialSession?.thinkingLevel === "off" ? "" : props.initialSession?.thinkingLevel ?? ""));
const selectedModelChoice = computed(() => modelChoices.value.find(item => item.value === selectedModel.value));
const contextWindow = computed(() => contextUsage.value?.contextWindow ?? selectedModelChoice.value?.contextWindow ?? 262144);
const contextPercent = computed(() => (contextUsage.value?.tokens ?? 0) / contextWindow.value * 100);
const inputTokens = computed(() => stats.value ? stats.value.tokens.input + stats.value.tokens.cacheRead + stats.value.tokens.cacheWrite : 0);
const welcomeSuggestions = [
  { label: "搭建创作画布", description: "把创意串成清晰的节点流程", icon: IconLayoutGrid, prompt: "帮我搭建一个创作画布，先和我确认需要的节点与流程。" },
  { label: "梳理故事分镜", description: "拆解故事，安排画面与镜头", icon: IconMovie, prompt: "帮我把故事整理成分镜，先和我确认故事内容、时长和画面风格。" },
  { label: "生成图片素材", description: "为角色和场景寻找视觉方向", icon: IconPhoto, prompt: "帮我生成图片素材，先和我确认画面内容、风格和使用的模型。" },
];
watch([locked, () => props.active], ([locked, active]) => {
  if (!active || locked) sender?.disable();
  else sender?.enable();
});
watch([() => props.active, () => props.initialSession?.activeRun?.runId], ([active, runId]) => {
  if (!active) contextMenuVisible.value = false;
  else if ((runId || boundSessionFile.value) && !controller && !reconnectController) void reconnectActiveRun();
}, { immediate: true });

async function refreshRunStatus(runId: string, signal?: AbortSignal) {
  const snapshot = await fetchAgentRunSnapshot(runId, signal);
  if (currentRunId.value !== runId) return snapshot;
  runStatus.value = snapshot.status;
  remoteRunning.value = snapshot.live;
  return snapshot;
}

function scheduleReconnect(delay = reconnectDelay) {
  clearTimeout(reconnectTimer);
  if (disposed || document.hidden || !props.active) return;
  reconnectTimer = setTimeout(() => { void reconnectActiveRun(); }, delay);
}

async function reloadConversation(signal: AbortSignal) {
  const file = boundSessionFile.value;
  if (!directory || !file) return;
  const { data } = await axios.get<{ code: number; data: AgentConversation; message?: string }>("/api/agent/get", {
    params: { directory, sessionFile: file }, signal,
  });
  signal.throwIfAborted();
  if (data.code !== 200) throw new Error(data.message || "读取会话快照失败");
  const session = data.data;
  stream.restore(session.messages);
  stats.value = session.stats;
  contextUsage.value = session.contextUsage;
  for (const agent of session.subAgents ?? []) emit("event", { type: "subAgent", agent });
  if (session.eventCursor) { currentRunId.value = session.eventCursor.runId; eventCursor = session.eventCursor.afterSeq; }
  if (session.activeRun) {
    currentRunId.value = session.activeRun.runId;
    runStatus.value = session.activeRun.status;
    eventCursor = session.eventCursor?.runId === session.activeRun.runId ? session.eventCursor.afterSeq : session.activeRun.lastEventSeq;
    for (const question of session.activeRun.waitingQuestions) {
      const part = messages.value.flatMap(message => message.parts ?? []).find(part => part.type === "tool" && part.tool.id === question.toolCallId);
      if (part?.type === "tool" && part.tool.question?.callId !== question.callId) part.tool.question = question as NonNullable<typeof part.tool.question>;
    }
  }
  remoteRunning.value = session.running ?? false;
}

async function reconnectActiveRun() {
  if (!directory || controller || reconnectController || disposed || document.hidden) return;
  if (!currentRunId.value && !boundSessionFile.value) return;
  clearTimeout(reconnectTimer);
  const connection = new AbortController();
  reconnectController = connection;
  let interrupted = false;
  try {
    await reloadConversation(connection.signal);
    const runId = currentRunId.value;
    if (!runId) return;
    const snapshot = await refreshRunStatus(runId, connection.signal);
    if (connection.signal.aborted || !snapshot.live && snapshot.lastEventSeq <= eventCursor) return;
    busy.value = snapshot.live;
    connectionError.value = "";
    await subscribeAgentRunEvents(runId, eventCursor, async (event, meta) => {
      if (props.initialSession?.parentFile) {
        if (event.type === "subAgentEvent" && event.file === boundSessionFile.value) applyEvent(event.event);
      } else applyEvent(event);
      if (meta?.seq !== undefined) eventCursor = meta.seq;
      if (event.type === "done" || event.type === "error") {
        await reloadConversation(connection.signal);
        await refreshRunStatus(runId, connection.signal);
      }
      reconnectDelay = 1000;
    }, connection.signal);
  } catch (error) {
    if (!connection.signal.aborted) {
      interrupted = true;
      connectionError.value = error instanceof Error ? error.message : "连接中断，正在恢复后台运行";
      reconnectDelay = Math.min(reconnectDelay * 2, 30_000);
    }
  } finally {
    if (reconnectController === connection) {
      reconnectController = undefined;
      stream.suspend();
      compacting.value = false;
      busy.value = false;
      scheduleReconnect(interrupted ? reconnectDelay : 10_000);
    }
  }
}

async function retryPendingMessage() {
  const input = pendingInput.value;
  if (!input || busy.value || controller || disposed) return;
  const connection = new AbortController();
  controller = connection;
  busy.value = true;
  try {
    const accepted = await getAcceptedAgentMessage(input.directory, input.clientMessageId, connection.signal)
      ?? await acceptAgentMessage(input, connection.signal);
    clearPendingAgentMessage(input.clientMessageId);
    pendingInput.value = undefined;
    currentRunId.value = accepted.runId;
    boundSessionFile.value = accepted.sessionFile;
    emit("session", accepted.sessionFile);
    connectionError.value = "";
  } catch (error) {
    if (error instanceof ExecutionRequestError && error.status < 500 && error.status !== 409) pendingInput.value = undefined;
    if (!connection.signal.aborted) connectionError.value = error instanceof Error ? error.message : "查询受理记录失败，消息已保留";
  } finally {
    controller = undefined;
    busy.value = false;
    if (!pendingInput.value) void reconnectActiveRun();
  }
}

function restoreConnection() {
  if (document.hidden) {
    clearTimeout(reconnectTimer);
    reconnectController?.abort();
    return;
  }
  if (!props.active) return;
  if (pendingInput.value) void retryPendingMessage();
  else void reconnectActiveRun();
}

onMounted(() => {
  pendingInput.value = directory ? pendingAgentMessages(directory, boundSessionFile.value)[0] : undefined;
  document.addEventListener("visibilitychange", restoreConnection);
  window.addEventListener("online", restoreConnection);
  window.addEventListener("pageshow", restoreConnection);
  restoreConnection();
});
onBeforeUnmount(() => {
  disposed = true;
  clearTimeout(reconnectTimer);
  controller?.abort();
  reconnectController?.abort();
  stream.suspend();
  document.removeEventListener("visibilitychange", restoreConnection);
  window.removeEventListener("online", restoreConnection);
  window.removeEventListener("pageshow", restoreConnection);
});

function applyEvent(event: AgentEvent) {
  switch (event.type) {
    case "canvasCall":
      connectionError.value = "服务端仍使用旧画布执行协议，请完成后端迁移";
      break;
    case "subAgent": emit("event", event); break;
    case "subAgentEvent": {
      let inner = event.event;
      while (inner.type === "subAgentEvent") inner = inner.event;
      if (inner.type === "canvasCall") connectionError.value = "子任务仍使用旧画布执行协议，请完成后端迁移";
      else emit("event", event);
      break;
    }
    case "report":
      if (event.parentFile !== boundSessionFile.value) { emit("event", event); break; }
      if (!messages.value.some(message => message.id === event.id)) messages.value.push({
        id: event.id, role: "assistant", content: event.content,
        parts: [{ id: event.id, type: "text", content: event.content }], report: { file: event.file, name: event.name },
      });
      break;
    case "compaction": compacting.value = event.active; break;
    case "run":
      if (currentRunId.value !== event.runId) eventCursor = 0;
      currentRunId.value = event.runId;
      runStatus.value = "running";
      remoteRunning.value = true;
      authorizationError.value = undefined;
      break;
    case "session": boundSessionFile.value = event.file; emit("session", event.file); break;
    case "stats": stats.value = event.stats; contextUsage.value = event.contextUsage; break;
    case "done":
      remoteRunning.value = false;
      runStatus.value = "completed";
      stream.receive(event);
      break;
    case "error":
      remoteRunning.value = false;
      runStatus.value = "error";
      if (event.message.includes("尚未授权")) authorizationError.value = event.message;
      stream.receive(event);
      break;
    default: stream.receive(event);
  }
}

function receiveEvent(event: AgentEvent) {
  // 子会话有自己的游标订阅时，由该订阅归并；父会话转发的同一增量不能再次追加。
  if (props.initialSession?.parentFile && reconnectController && currentRunId.value) return;
  if (event.type === "done" || event.type === "error") {
    remoteRunning.value = false;
    compacting.value = false;
  } else if (["userMessage", "text", "thinking", "tool"].includes(event.type)) remoteRunning.value = true;
  applyEvent(event);
}

defineExpose({ receiveEvent });

function getDraftContent() {
  return sender?.getModel().map((line, lineIndex) => line.map((tag, tagIndex) => {
    if (tag.type === "Mention") return `{{mention:${tag.id}}}`;
    if (tag.type === "Write") return tag.text;
    return sender?.chatEditor.NODES[lineIndex]?.children[tagIndex]?.$el.textContent ?? "";
  }).join("")).join("\n").replace(/[\ufeff\u200b]/g, "") ?? "";
}

function captureMentionPosition() {
  const node = sender?.getCurrentNode();
  mentionPosition = node?.instance?.$el.isConnected ? { node: { ...node }, remove: mentionQuery.value === undefined ? 0 : mentionQuery.value.length + 1 } : undefined;
  skillQuery.value = undefined;
}

function updateMentionQuery() {
  if (!sender || insertingMentions || sender.chatEditor.isComposition || !sender.chatElement.richText.contains(sender.getSelection().anchorNode)) return;
  const current = sender.getCurrentNode();
  const before = current?.instance?.type === "Write" ? current.instance.text.slice(0, current.offset) : "";
  mentionQuery.value = /(?:^|[^\w@])@([^\s@]*)$/.exec(before)?.[1];
  if (mentionQuery.value !== undefined) captureMentionPosition();
}

function handleSenderKeydown(event: KeyboardEvent) {
  const id = event.target instanceof HTMLElement ? event.target.closest<HTMLElement>("[data-agent-mention]")?.dataset.agentMention : undefined;
  if (id && ["Enter", " "].includes(event.key)) {
    event.preventDefault();
    event.stopPropagation();
    draftMentionPreview.value?.preview(id);
    return;
  }
  if (mentionMenuRef.value?.handleKeydown(event)) return;
  skillMenuRef.value?.handleKeydown(event);
}

async function insertMentions(mentions: AgentMention[]) {
  const instance = sender;
  if (!instance || locked.value || !props.active) return;
  const currentIds = new Set(instance.getTagData().mention.map(item => item.id));
  if (currentIds.size + mentions.length > 20) return ElMessage.warning("每条消息最多提及 20 个输出或素材");
  insertingMentions = true;
  try {
    if (mentionPosition?.node.instance.$el.isConnected) mentionPosition.node.instance.focus(mentionPosition.node.offset);
    else instance.focus("last");
    if (mentionPosition?.remove) await instance.backspace(-mentionPosition.remove);
    for (const mention of mentions) {
      if (sender !== instance || !props.active) break;
      draftMentions.value.push(mention);
      await instance.setMention({ id: mention.id, name: mentionName(mention) });
    }
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : "添加提及失败");
  } finally {
    mentionQuery.value = undefined;
    mentionPosition = undefined;
    insertingMentions = false;
  }
}

async function removeDraftMention(id: string) {
  if (!locked.value) await sender?.removeMention([id]);
}

function submitMessage() {
  return sendMessage(editingId.value ? messages.value.find(item => item.id === editingId.value) : undefined);
}

async function selectSkill(name: string) {
  const instance = sender;
  if (!instance || locked.value) return;
  const model = instance.getModel();
  const first = model[0]?.[0];
  if (first?.type === "Write") first.text = `/skill:${name} ${first.text.replace(skillQuery.value !== undefined ? /^\/\S*/ : /^\s*\/skill:\S+(?:\s+|$)/, "")}`;
  if (!model.length) model.push([]);
  if (first?.type !== "Write") model[0]!.unshift({ type: "Write", text: `/skill:${name} ` });
  skillQuery.value = undefined;
  mentionMenuRef.value?.closeMenu();
  await instance.reset({ clearHistory: false, chatNode: model });
  if (sender === instance) instance.focus("last");
}

async function fillPrompt(prompt: string) {
  const instance = sender;
  if (!instance || locked.value) return;
  draftMentions.value = [];
  await instance.reset({ clearHistory: false, chatNode: [[{ type: "Write", text: prompt }]] });
  if (sender === instance) instance.focus("last");
}

async function copyMessage(content: string) {
  try {
    await writeClipboardText(content);
    ElMessage.success("已复制");
  } catch {
    ElMessage.error("复制失败，请重试");
  }
}

async function editMessage(item: AgentMessage) {
  const instance = sender;
  if (!instance || locked.value || remoteRunning.value || item.role !== "user") return;
  if (!editingId.value) editDraft = { model: instance.getModel(), mentions: [...draftMentions.value], attachments: [...draftAttachments.value] };
  editingId.value = item.id;
  draftMentions.value = [...item.mentions ?? []];
  draftAttachments.value = [...item.attachments ?? []];
  mentionMenuRef.value?.closeMenu();
  const model: AnyTagProps[][] = item.content.split("\n").map(line => mentionParts(line, item.mentions).map(part => part.mention
    ? { type: "Mention", id: part.mention.id, name: mentionName(part.mention) } : { type: "Write", text: part.text }));
  await instance.reset({ chatNode: model });
  if (sender === instance) instance.focus("last");
}

async function restoreEditingDraft() {
  const draft = editDraft;
  editDraft = undefined;
  editingId.value = undefined;
  draftMentions.value = draft?.mentions ?? [];
  draftAttachments.value = draft?.attachments ?? [];
  await sender?.reset({ chatNode: draft?.model });
}

async function cancelEdit() {
  if (busy.value || deletingId.value !== undefined) return;
  await restoreEditingDraft();
}

async function deleteMessage(item: AgentMessage) {
  if (locked.value || remoteRunning.value || item.streaming || item.report) return;
  deletingId.value = item.id;
  try {
    if (item.entryId || item.replyTo) {
      if (!directory || !props.sessionFile) throw new Error("请重新打开对话后再删除");
      const { data } = await axios.delete<{ code: number; data: AgentConversation; message?: string }>("/api/agent/message", {
        data: {
          directory, sessionFile: props.sessionFile,
          ...(item.replyTo ? { replyTo: item.replyTo } : { entryIds: [item.entryId!] }),
        },
      });
      if (data.code !== 200) throw new Error(data.message || "删除消息失败");
      stats.value = data.data.stats;
      contextUsage.value = data.data.contextUsage;
    }
    messages.value = messages.value.filter(message => message.id !== item.id);
  } catch (error) {
    const message = axios.isAxiosError<{ message?: string }>(error) ? error.response?.data?.message : undefined;
    ElMessage.error(message || (error instanceof Error ? error.message : "删除消息失败"));
  } finally {
    deletingId.value = undefined;
  }
}

function setSenderHeight(height: number) {
  if (!sender) return;
  senderMaxHeight.value = Math.max(44, window.innerHeight / 2);
  senderHeight.value = Math.max(44, Math.min(senderMaxHeight.value, Math.round(height)));
  sender.chatElement.rollBox.style.height = `${senderHeight.value}px`;
}

function startSenderResize(event: PointerEvent) {
  if (event.button !== 0 || senderResize || !sender) return;
  event.preventDefault();
  senderResize = { pointerId: event.pointerId, y: event.clientY, height: sender.chatElement.rollBox.getBoundingClientRect().height };
  senderHeight.value = senderResize.height;
  (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
}

function moveSenderResize(event: PointerEvent) {
  if (senderResize?.pointerId !== event.pointerId) return;
  setSenderHeight(senderResize.height + senderResize.y - event.clientY);
}

function stopSenderResize(event: PointerEvent) {
  if (senderResize?.pointerId === event.pointerId) senderResize = undefined;
}

async function pauseRun() {
  if (!currentRunId.value) return;
  try {
    await controlAgentRun(currentRunId.value, "pause");
    runStatus.value = "paused";
    ElMessage.success("已暂停后续步骤");
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : "暂停失败");
  }
}

async function resumeRun() {
  if (!currentRunId.value) return;
  try {
    const snapshot = await fetchAgentRunSnapshot(currentRunId.value);
    reviewCalls.value = snapshot.reviewCalls ?? [];
    if (reviewCalls.value.length) { reviewOpen.value = true; return; }
    await controlAgentRun(currentRunId.value, "resume");
    runStatus.value = "running";
    remoteRunning.value = true;
    ElMessage.success("已继续运行");
    void reconnectActiveRun();
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : "继续运行失败");
  }
}
async function confirmReview(toolCallId: string) {
  if (!currentRunId.value) return;
  reviewingId.value = toolCallId;
  try {
    const snapshot = await reviewAgentRun(currentRunId.value, toolCallId);
    reviewCalls.value = snapshot.reviewCalls ?? [];
    if (!reviewCalls.value.length) reviewOpen.value = false;
  } catch (error) { ElMessage.error(error instanceof Error ? error.message : "核对失败"); }
  finally { reviewingId.value = undefined; }
}

async function terminateRun() {
  if (!currentRunId.value) return;
  try {
    await controlAgentRun(currentRunId.value, "terminate");
    await refreshRunStatus(currentRunId.value);
    ElMessage.success("已终止本次流程");
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : "终止失败");
  }
}

async function stopMessage() {
  if (currentRunId.value && remoteRunning.value) {
    try { await controlAgentRun(currentRunId.value, "stopGeneration"); }
    catch (error) { ElMessage.error(error instanceof Error ? error.message : "停止生成失败"); return; }
  }
  controller?.abort();
  reconnectController?.abort();
}

async function uploadAttachments(attachments: AgentAttachment[], directory: string, signal: AbortSignal) {
  if (!attachments.some(item => item.file)) return;
  const files = useWorkspaceFiles(directory);
  for (const path of ["assets", "assets/chat"]) {
    await files.mkdir(path).catch(error => {
      if (error?.response?.data?.data?.code !== "EEXIST") throw error;
    });
    signal.throwIfAborted();
  }
  for (const attachment of attachments) {
    if (!attachment.file) continue;
    const extension = attachment.name.match(/\.[a-zA-Z0-9]{1,10}$/)?.[0].toLowerCase() ?? "";
    const path = `assets/chat/${crypto.randomUUID()}${extension}`;
    await files.write(path, attachment.file, true, signal);
    attachment.path = path;
    attachment.file = undefined;
    signal.throwIfAborted();
  }
}

async function sendMessage(source?: AgentMessage) {
  const instance = sender;
  const editing = source && editingId.value === source.id;
  const prompt = (source && !editing ? source.content : getDraftContent()).trim();
  const attachments = reactive((source && !editing ? source.attachments ?? [] : draftAttachments.value).map(item => ({ ...item })));
  const mentionedIds = source && !editing ? (source.mentions ?? []).filter(mention => prompt.includes(`{{mention:${mention.id}}}`)).map(mention => mention.id)
    : instance?.getTagData().mention.map(mention => mention.id) ?? [];
  const references = source && !editing ? source.mentions ?? [] : draftMentions.value;
  const mentions = JSON.parse(JSON.stringify(references.filter(mention => mentionedIds.includes(mention.id)))) as AgentMention[];
  if (mentionedIds.some(id => !mentions.some(mention => mention.id === id))) return ElMessage.warning("存在无法读取的提及，请删除后重新选择");
  if (!source && editingId.value !== undefined) return;
  const resendIndex = source ? messages.value.findIndex(item => item.id === source.id) : -1;
  if (source && (source.role !== "user" || resendIndex < 0)) return;
  const resendFrom = source ? source.entryId ?? messages.value.slice(resendIndex + 1).find(item => item.role === "user" && item.entryId)?.entryId : undefined;
  if (locked.value || pendingInput.value || !instance || !prompt && !attachments.length) return;
  const model = selectedModelChoice.value;
  if (!directory) return ElMessage.warning("请先打开项目");
  if (!model) return ElMessage.warning("请先选择模型");

  const requestController = new AbortController();
  const canvasId = currentCanvasId.value;
  const selectedNodeIds = [...(props.selectedNodeIds ?? getAgentCanvasContext?.()?.selectedNodeIds ?? [])];
  const clientMessageId = crypto.randomUUID();
  controller = requestController;
  busy.value = true;
  connectionError.value = "";
  instance.disable();
  const userMessage = reactive<AgentMessage>({ id: clientMessageId, role: "user", content: prompt, attachments, mentions });
  const finishStats = anonymousData.startAgent();
  let accepted = false;
  try {
    await uploadAttachments(attachments, directory, requestController.signal);
    const input: AgentAcceptInput = {
      clientMessageId, clientId: getExecutionClientId(), prompt, directory, mentions,
      attachments: attachments.map(({ name, path, mimeType }) => ({ name, path, mimeType })),
      providerId: model.providerId, modelId: model.modelId,
      thinkingLevel: reasoningEffort.value || undefined, sessionFile: boundSessionFile.value, resendFrom,
      canvas: canvasId ? { id: canvasId, selectedNodeIds } : undefined,
    };
    pendingInput.value = input;
    const receipt = await acceptAgentMessage(input, requestController.signal);
    accepted = true;
    pendingInput.value = undefined;
    boundSessionFile.value = receipt.sessionFile;
    currentRunId.value = receipt.runId;
    eventCursor = 0;
    remoteRunning.value = true;
    runStatus.value = "running";
    emit("session", receipt.sessionFile);
    if (source) {
      messages.value.splice(resendIndex, messages.value.length - resendIndex, userMessage);
      stats.value = undefined;
      contextUsage.value = undefined;
      await restoreEditingDraft();
    } else {
      messages.value.push(userMessage);
      draftAttachments.value = [];
      draftMentions.value = [];
      if (sender === instance) await instance.reset();
    }
    finishStats("success");
    emit("sent", mentionPlainText(prompt, mentions) || attachments[0]?.name || "新对话");
  } catch (error) {
    finishStats("failed");
    if (error instanceof ExecutionRequestError && error.status < 500 && error.status !== 409) pendingInput.value = undefined;
    if (!disposed && !requestController.signal.aborted) {
      connectionError.value = error instanceof Error ? error.message : "发送结果待确认，消息草稿已保留";
      ElMessage.error(connectionError.value);
    }
  } finally {
    if (controller === requestController) controller = undefined;
    busy.value = false;
    if (accepted && !disposed) void reconnectActiveRun();
  }
}

function pasteAttachments(event: ClipboardEvent) {
  const files = Array.from(event.clipboardData?.files ?? []);
  if (!files.length) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  if (locked.value) return;
  for (const file of files) {
    if (!/^(image|video)\//.test(file.type)) {
      ElMessage.warning("只支持图片和视频文件");
      continue;
    }
    if (!file.size || file.size > 100 * 1024 * 1024) {
      ElMessage.warning("附件不能为空且不能超过 100 MB");
      continue;
    }
    if (draftAttachments.value.length >= 20) {
      ElMessage.warning("每条消息最多添加 20 个附件");
      break;
    }
    draftAttachments.value.push({ name: file.name, path: "", mimeType: file.type, file });
  }
}

watch(senderElement, (element, _previous, onCleanup) => {
  if (!element) return;
  const instance = new xSender(element, {
    autoFocus: props.active,
    placeholder: "输入消息，@ 提及节点输出或全局素材…",
    chatStyle: { minHeight: "44px", maxHeight: "50vh", fontSize: "14px", lineHeight: "24px" },
    keyboardSendFun: event => event.key === "Enter" && !event.shiftKey && !event.isComposing,
    keyboardWrapFun: event => event.key === "Enter" && event.shiftKey && !event.isComposing,
  });
  sender = instance;
  if (!props.active || locked.value) instance.disable();
  instance.bus.on("agentConversation", xSender.EventSet.EVENT_COMMON_SEND, () => void submitMessage());
  instance.bus.on("agentConversation", xSender.EventSet.EVENT_COMMON_CHANGE, () => {
    skillQuery.value = /^\/([^\s/]*)$/.exec(instance.getText())?.[1];
    const targets: typeof draftMentionTargets.value = [];
    for (const line of instance.chatEditor.NODES) for (const tag of line.children) {
      if (tag.type !== "Mention") continue;
      tag.$el.dataset.agentMention = tag.id;
      tag.$el.setAttribute("role", "button");
      tag.$el.setAttribute("tabindex", "0");
      tag.$el.setAttribute("aria-label", `预览 ${tag.name}`);
      const mention = draftMentions.value.find(item => item.id === tag.id);
      if (!mention || !mentionThumbnailProps(mention).thumbnail) continue;
      const content = tag.$el.querySelector<HTMLElement>(".chat-tag-mention");
      if (!content) continue;
      let element = content.querySelector<HTMLElement>(".agentMentionThumbnail");
      if (!element) {
        element = document.createElement("span");
        element.className = "agentMentionThumbnail";
        const label = document.createElement("span");
        label.className = "agentMentionLabel";
        label.textContent = content.textContent;
        content.replaceChildren(element, label);
      }
      targets.push({ key: draftMentionTargets.value.find(target => target.element === element)?.key ?? Symbol(), element, mention });
    }
    draftMentionTargets.value = targets;
    void instance.nextTick(() => { if (sender === instance) updateMentionQuery(); });
  });
  instance.bus.on("agentConversation", xSender.EventSet.EVENT_COMMON_TAG_CLICK, (tag: { type: string; id?: string }) => {
    if (tag.type === "Mention" && tag.id) draftMentionPreview.value?.preview(tag.id);
  });
  const editor = instance.chatElement.richText;
  editor.setAttribute("role", "textbox");
  editor.setAttribute("aria-label", "消息");
  editor.setAttribute("aria-multiline", "true");
  element.addEventListener("paste", pasteAttachments, true);
  const updateCursor = (event: Event) => { if (!(event instanceof KeyboardEvent) || event.key !== "Escape") updateMentionQuery(); };
  editor.addEventListener("keyup", updateCursor);
  editor.addEventListener("compositionend", updateCursor);
  onCleanup(() => {
    controller?.abort();
    reconnectController?.abort();
    draftMentionTargets.value = [];
    sender = undefined;
    senderResize = undefined;
    element.removeEventListener("paste", pasteAttachments, true);
    editor.removeEventListener("keyup", updateCursor);
    editor.removeEventListener("compositionend", updateCursor);
    instance.destroy();
  });
});

watch(() => !props.initialSession?.parentFile && !!workspaceStore.pendingAgentMessage && props.active && !locked.value && !!senderElement.value && !!currentCanvasId.value, async ready => {
  const message = workspaceStore.pendingAgentMessage;
  const instance = sender;
  if (!ready || !message || !instance || message.directory !== directory) return;
  workspaceStore.pendingAgentMessage = null;
  await fillPrompt(message.prompt);
  if (sender === instance && props.active) void sendMessage();
}, { flush: "post" });
</script>

<style lang="scss">
.agentConversation {
  display: flex;
  flex: 1;
  flex-direction: column;
  min-height: 0;
  overflow: hidden;

  .messageViewport {
    flex: 1;
    min-height: 0;

    .messageList {
      overflow-anchor: none;
      scrollbar-gutter: stable;
    }

    .messageSpace {
      position: relative;
      width: 100%;
    }

    .scrollBottom {
      position: absolute;
      right: 16px;
      bottom: 12px;
      z-index: 1;
    }

    .welcomeMessage {
      display: flex;
      flex-direction: column;
      gap: 18px;
      padding: 28px 16px 16px;
      color: var(--el-text-color-primary);

      .welcomeHeader {
        display: flex;
        align-items: center;
        gap: 12px;

        .welcomeIcon {
          display: grid;
          place-items: center;
          flex-shrink: 0;
          width: 42px;
          height: 42px;
          border-radius: var(--ui-radius-large);
          background: var(--el-color-primary-light-9);
          color: var(--el-color-primary);

          .welcomeLogo {
            width: 28px;
            height: 28px;
            background: currentColor;
            mask-size: contain;
            mask-position: center;
            mask-repeat: no-repeat;
          }
        }

        .welcomeLabel { margin: 0 0 4px; font-size: 12px; color: var(--el-text-color-secondary); }
        h3 { margin: 0; font-size: 18px; font-weight: 600; line-height: 1.4; }
      }

      .welcomeDescription { margin: 0; font-size: 13px; line-height: 1.7; color: var(--el-text-color-regular); }

      .welcomeSuggestions {
        display: flex;
        flex-direction: column;
        gap: 8px;

        .welcomeSuggestion {
          height: auto;
          margin: 0;
          padding: 12px;
          text-align: left;
          white-space: normal;
          line-height: 1.5;

          > span { display: flex; align-items: center; gap: 12px; width: 100%; min-width: 0; }
          svg { flex-shrink: 0; color: var(--el-text-color-secondary); }
          .suggestionContent {
            display: flex;
            flex: 1;
            flex-direction: column;
            gap: 2px;
            min-width: 0;
            strong { font-size: 13px; font-weight: 500; }
            span { font-size: 12px; color: var(--el-text-color-secondary); }
          }
          .suggestionArrow { color: var(--el-text-color-placeholder); }
        }
      }

      .welcomeHint { margin: 0; font-size: 12px; line-height: 1.6; color: var(--el-text-color-secondary); }
    }

    .messageRow {
      position: absolute;
      top: 0;
      left: 0;
      width: 100%;
      box-sizing: border-box;
      padding: 0 12px 12px;

      .messageActions {
        display: flex;
        align-items: center;
        gap: 4px;
        margin-top: 4px;

        .el-button {
          margin: 0;

          .tabler-icon {
            flex-shrink: 0;
          }
        }

        .messageAction {
          width: 24px;
          height: 24px;
          padding: 0;
          color: var(--el-text-color-secondary);
        }
      }

      &.userMessage .messageActions {
        justify-content: flex-end;
      }

      &.editingMessage .t-chat__inner.user .t-chat__content .t-chat__detail {
        width: 100%;
        max-width: 100%;
        padding: 0;
        background: transparent;
      }
    }

    .t-chat__inner {
      margin-bottom: 0;

      .t-chat__content {
        min-width: 0;
        padding-top: 0;

        .t-chat__detail {
          width: 100%;
          max-width: 100%;
          padding: 0;
        }
      }

      &.user .t-chat__content .t-chat__detail {
        width: auto;
        max-width: 80%;
        padding: 6px 10px;
        border-radius: calc(var(--ui-radius) * 1.25);
        background: color-mix(in srgb, var(--el-text-color-secondary) 12%, var(--el-bg-color));
      }
    }

    .messageContent {
      display: flex;
      flex-direction: column;
      gap: 4px;
      min-width: 0;
      overflow-wrap: anywhere;
      color: var(--el-text-color-primary);

      .messageReasoning {
        padding-top: 0;

        .t-collapse-panel__wrapper {
          background: transparent;

          .t-collapse-panel__header {
            padding: 2px 0;
            font-size: 13px;
            line-height: 20px;
          }

          .t-collapse-panel__icon {
            width: 16px;
            height: 20px;
            margin-right: 6px;

            .t-fake-arrow {
              transform: rotate(-90deg);
            }

            &.t-collapse-panel__icon--active .t-fake-arrow {
              transform: rotate(0deg);
            }
          }

          .t-collapse-panel__body {
            background: transparent;

            .t-collapse-panel__content {
              padding: 4px 0 4px 22px;
              background: transparent;
              color: var(--el-text-color-secondary);
            }
          }
        }
      }

      .reasoningHeader {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        color: var(--el-text-color-secondary);

        .thinkingDuration {
          font-variant-numeric: tabular-nums;
        }
      }

      .messageText {
        white-space: pre-wrap;
        font-size: 13px;
        line-height: 1.6;
      }

      .messageError {
        color: var(--el-color-danger);
        font-size: 12px;
      }

      .reportHeader {
        display: flex;
        align-items: center;
        gap: 6px;
        color: var(--el-text-color-secondary);
        font-size: 12px;
      }

      .messageMarkdown {
        display: block;
        min-width: 0;
        max-width: 100%;
        font-size: 13px;
        line-height: 1.6;
      }
    }
  }

  .compactionStatus {
    display: flex;
    flex-shrink: 0;
    align-items: center;
    gap: 6px;
    margin: 0 12px 8px;
    color: var(--el-text-color-secondary);
    font-size: 12px;
  }

  .messageInput {
    --chat-text: var(--el-text-color-primary);
    --chat-text-placeholder: var(--el-text-color-placeholder);
    --chat-rect-padding: 12px;
    --chat-mention-text: var(--el-color-primary);
    position: relative;
    flex-shrink: 0;
    margin: 0 12px 8px;
    border: 1px solid var(--el-border-color-light);
    border-radius: calc(var(--ui-radius) * 2.75);
    background: var(--el-bg-color);
    box-shadow: 0 4px 16px rgb(0 0 0 / 8%);

    &:focus-within {
      border-color: var(--el-color-primary-light-5);
    }

    .senderResizeHandle {
      position: absolute;
      z-index: 12;
      top: -4px;
      right: 12px;
      left: 12px;
      height: 8px;
      border-radius: 4px;
      cursor: ns-resize;
      touch-action: none;
      user-select: none;

      &:focus-visible {
        outline: 2px solid var(--el-color-primary);
        outline-offset: 2px;
      }
    }

    .draftAttachments {
      padding: 12px 12px 0;
    }

    .senderEditor .chat-placeholder-wrap {
      font-size: 14px;
      font-style: normal;
      line-height: 24px;
    }

    .editingBanner {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 3px 12px;
      border-bottom: 1px solid var(--el-border-color-lighter);
      color: var(--el-text-color-secondary);
      font-size: 12px;
    }

    .senderEditor .chat-tag-mention {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      max-width: 100%;
      vertical-align: middle;
      border-radius: var(--el-border-radius-small);
      background: var(--el-color-primary-light-9);
      color: var(--el-color-primary);
      white-space: normal;
      overflow-wrap: anywhere;
      cursor: pointer;

      .agentMentionThumbnail {
        display: inline-flex;
        flex-shrink: 0;

        .mentionThumbnail { width: 24px; height: 24px; border-radius: 3px; }
      }
      .agentMentionLabel { min-width: 0; }
    }

    .senderActions {
      display: flex;
      justify-content: flex-end;
      align-items: center;
      gap: 12px;
      padding: 2px 8px 6px;

      > .el-button {
        margin-left: 0;
      }

      .modelPopover {
        flex: 1;
        margin-right: auto;
      }

      .contextButton {
        width: 24px;
        height: 24px;
        margin: 0;
        padding: 0;

        &.is-text {
          background-color: transparent;
        }
      }

      .sendButton {
        width: 34px;
        height: 34px;
        border: none;
        transform: translateY(-2px);
      }
    }
  }

}
.agentContextPopover {
  .contextUsage {
    display: flex;
    flex-direction: column;
    gap: 12px;

    .contextStats {
      display: flex;
      flex-direction: column;
      gap: 8px;
    }

    .contextHeader,
    .contextTokens {
      display: flex;
      justify-content: space-between;
      gap: 8px;
    }

    .contextHeader {
      color: var(--el-text-color-primary);
    }

    .contextTokens {
      font-size: 12px;
      font-variant-numeric: tabular-nums;
    }

    .contextHint {
      color: var(--el-text-color-secondary);
      font-size: 12px;
    }
  }
}
</style>
