<template>
  <div class="mobileLayout" :class="{ conversationLayout, compactEditing: conversationLayout && compactEditing }">
    <mobileOfflineBanner />
    <router-view />
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, provide, ref, watch } from "vue";
import { useRoute } from "vue-router";
import mobileOfflineBanner from "./components/mobileOfflineBanner.vue";

const route = useRoute();
const conversationLayout = computed(() => route.matched.some(record => record.path === "/mobile/agent"));
const compactEditing = ref(false);
provide("mobilePage", true);
let viewportFrame = 0;
let compactControlPointer: number | undefined;
const viewport = window.visualViewport;
const root = document.documentElement;
const mobileKeyboard = navigator.maxTouchPoints > 0 && window.matchMedia("(pointer: coarse)").matches && /Android|iPhone|iPad/.test(navigator.userAgent);
let viewportSize = "";
let expandedViewportHeight = 0;
let keyboardVisible = false;

function updateViewport() {
  viewportFrame = 0;
  const pinching = viewport && Math.abs(viewport.scale - 1) > 0.01;
  const height = pinching
    ? Number.parseFloat(root.style.getPropertyValue("--mobileViewportHeight")) || window.innerHeight
    : viewport?.height ?? window.innerHeight;
  if (!pinching) {
    const layoutHeight = document.documentElement.clientHeight || window.innerHeight;
    const size = `${window.innerWidth}:${window.screen.width}:${window.screen.height}`;
    // 旋转或窗口尺寸变化时重记基线；仅触控移动设备使用历史高度后备。
    expandedViewportHeight = size !== viewportSize || !mobileKeyboard ? Math.max(layoutHeight, height) : Math.max(expandedViewportHeight, layoutHeight, height);
    viewportSize = size;
    keyboardVisible = !!viewport && (mobileKeyboard ? expandedViewportHeight : layoutHeight) - height > 120;
  }
  const focused = document.activeElement;
  const visibleFocus = focused instanceof HTMLElement && focused.getClientRects().length > 0;
  const editorFocus = visibleFocus && focused.isContentEditable && !!focused.closest(".mobileAgent .senderEditor");
  // 编辑期间操作工具栏或其浮层时维持布局，避免焦点切换在 click 前移走按钮。
  const editingControl = compactEditing.value && visibleFocus && !!focused.closest(".mobileAgent, .agentModelPopover, .agentContextPopover, .agentHistoryPopover, .agentSubAgentPopover, .mentionOverlay, .skillOverlay");
  if (!conversationLayout.value) compactControlPointer = undefined;
  const pressedControl = compactControlPointer !== undefined;
  // 短屏本身不表示键盘；还需正常缩放下视口明显收缩且处于编辑操作。
  compactEditing.value = conversationLayout.value && (pressedControl || keyboardVisible && height < 600 && (editorFocus || editingControl));
  // 主动 pinch 时保留布局，让浏览器负责缩放和平移。
  if (pinching) return;
  root.style.setProperty("--mobileViewportHeight", `${height}px`);
  root.style.setProperty("--mobileViewportTop", `${viewport?.offsetTop ?? 0}px`);
  window.dispatchEvent(new Event("mobileViewportChange"));
}

function scheduleViewport() {
  if (!conversationLayout.value || document.visibilityState !== "visible") compactControlPointer = undefined;
  if (!viewportFrame) viewportFrame = requestAnimationFrame(updateViewport);
}

function startCompactControl(event: PointerEvent) {
  if (compactEditing.value && event.isPrimary && event.button === 0 && event.target instanceof Element && event.target.closest(".mobileAgent .contextNavigationButton")) compactControlPointer = event.pointerId;
}
function finishCompactControl(event: PointerEvent) {
  if (event.pointerId === compactControlPointer) clearCompactControl();
}
function clearCompactControl() {
  compactControlPointer = undefined;
  scheduleViewport();
}

watch(conversationLayout, scheduleViewport);

onMounted(() => {
  root.setAttribute("data-mobile-page", "");
  updateViewport();
  viewport?.addEventListener("resize", scheduleViewport);
  viewport?.addEventListener("scroll", scheduleViewport);
  window.addEventListener("resize", scheduleViewport);
  window.addEventListener("pageshow", scheduleViewport);
  document.addEventListener("visibilitychange", scheduleViewport);
  document.addEventListener("focusin", scheduleViewport);
  document.addEventListener("focusout", scheduleViewport);
  document.addEventListener("pointerdown", startCompactControl, true);
  document.addEventListener("pointerup", finishCompactControl, true);
  document.addEventListener("pointercancel", finishCompactControl, true);
  window.addEventListener("blur", clearCompactControl);
});

onBeforeUnmount(() => {
  cancelAnimationFrame(viewportFrame);
  viewport?.removeEventListener("resize", scheduleViewport);
  viewport?.removeEventListener("scroll", scheduleViewport);
  window.removeEventListener("resize", scheduleViewport);
  window.removeEventListener("pageshow", scheduleViewport);
  document.removeEventListener("visibilitychange", scheduleViewport);
  document.removeEventListener("focusin", scheduleViewport);
  document.removeEventListener("focusout", scheduleViewport);
  document.removeEventListener("pointerdown", startCompactControl, true);
  document.removeEventListener("pointerup", finishCompactControl, true);
  document.removeEventListener("pointercancel", finishCompactControl, true);
  window.removeEventListener("blur", clearCompactControl);
  root.removeAttribute("data-mobile-page");
  root.style.removeProperty("--mobileViewportHeight");
  root.style.removeProperty("--mobileViewportTop");
});
</script>

<style lang="scss" scoped>
.mobileLayout {
  min-height: 100vh;
  min-height: 100dvh;
  display: flex;
  flex-direction: column;
  background: var(--el-bg-color-page);
  padding-bottom: env(safe-area-inset-bottom);
  padding-left: env(safe-area-inset-left);
  padding-right: env(safe-area-inset-right);
  box-sizing: border-box;
  min-width: 0;

  &.conversationLayout {
    position: fixed;
    top: var(--mobileViewportTop, 0px);
    right: 0;
    left: 0;
    height: var(--mobileViewportHeight, 100vh);
    height: var(--mobileViewportHeight, 100dvh);
    min-height: 0;
    overflow: auto;
  }

  :deep(.offlineBanner) { flex-shrink: 0; }
  :deep(.el-main) { flex: none; overflow: visible; }
  :deep(.nodeScroll) { flex: none; min-width: 0; }
}
</style>

<style lang="scss">
html[data-mobile-page] {
  --mobileSafeTop: env(safe-area-inset-top, 0px);
  --mobileSafeBottom: env(safe-area-inset-bottom, 0px);
  --mobileSafeLeft: env(safe-area-inset-left, 0px);
  --mobileSafeRight: env(safe-area-inset-right, 0px);
  --mobileInputFontSize: max(16px, 1rem);
  --senderFontSize: var(--mobileInputFontSize);

  input:not([type="checkbox"]):not([type="radio"]):not([type="range"]):not([type="file"]):not([type="button"]):not([type="submit"]),
  textarea,
  [contenteditable="true"] {
    font-size: var(--mobileInputFontSize);
  }

  .mobileTopBar,
  .mobileLayout .agentMenu { flex-shrink: 0; }

  .mobileTopBar .el-button,
  .mobileLayout .agentMenu .el-button,
  .mobileLayout .senderActions .el-button,
  .el-dialog__headerbtn,
  .el-drawer__close-btn,
  .el-message-box__headerbtn,
  .el-dialog__footer .el-button,
  .el-message-box__btns .el-button,
  .mobileSheet .el-button {
    min-width: 44px;
    min-height: 44px;
  }

  .mobileLayout .senderActions {
    .sendButton { transform: none; }
    .modelPopover { flex-basis: 120px; }
  }

  .el-popper {
    box-sizing: border-box;
    max-width: calc(100vw - env(safe-area-inset-left) - env(safe-area-inset-right) - 24px);
  }

  .agentModelPopover,
  .agentContextPopover,
  .agentHistoryPopover,
  .agentSubAgentPopover {
    max-height: calc(var(--mobileViewportHeight, 100dvh) - env(safe-area-inset-top) - env(safe-area-inset-bottom) - 24px);
    overflow-y: auto;
    overscroll-behavior: contain;
  }

  .agentHistoryPopover .historyList,
  .agentSubAgentPopover .subAgentList {
    max-height: calc(var(--mobileViewportHeight, 100dvh) - env(safe-area-inset-top) - env(safe-area-inset-bottom) - 64px);
  }

  .el-overlay-dialog {
    top: var(--mobileViewportTop, 0px);
    height: var(--mobileViewportHeight, 100dvh);
    bottom: auto;
    padding: env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left);
    box-sizing: border-box;
    overflow-y: auto;
  }

  .el-dialog,
  .el-message-box {
    max-width: calc(100vw - env(safe-area-inset-left) - env(safe-area-inset-right) - 24px);
    overflow-wrap: anywhere;
  }

  .el-message-box {
    max-height: calc(var(--mobileViewportHeight, 100dvh) - env(safe-area-inset-top) - env(safe-area-inset-bottom) - 24px);
    overflow-y: auto;
  }

  .el-overlay.is-message-box {
    top: var(--mobileViewportTop, 0px);
    bottom: auto;
    height: var(--mobileViewportHeight, 100dvh);
  }

  .mobileSheetOverlay {
    top: var(--mobileViewportTop, 0px);
    bottom: auto;
    height: var(--mobileViewportHeight, 100dvh);
  }

  .mobileSheet {
    max-width: 100%;
    max-height: calc(var(--mobileViewportHeight, 100dvh) - env(safe-area-inset-top));
    padding-left: env(safe-area-inset-left);
    padding-right: env(safe-area-inset-right);

    .el-drawer__header { flex-shrink: 0; }
    .el-drawer__body { min-height: 0; padding-bottom: calc(20px + env(safe-area-inset-bottom)); }
  }
}
</style>
