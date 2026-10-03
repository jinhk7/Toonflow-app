<template>
  <div class="mobileLayout" :class="{ conversationLayout: route.path === '/mobile/agent' }">
    <mobileOfflineBanner />
    <router-view />
  </div>
</template>

<script setup lang="ts">
import { onBeforeUnmount, onMounted, provide } from "vue";
import { useRoute } from "vue-router";
import mobileOfflineBanner from "./components/mobileOfflineBanner.vue";

const route = useRoute();
provide("mobilePage", true);
let viewportFrame = 0;
const viewport = window.visualViewport;
const root = document.documentElement;

function updateViewport() {
  viewportFrame = 0;
  // 主动 pinch 时保留布局，让浏览器负责缩放和平移。
  if (viewport && Math.abs(viewport.scale - 1) > 0.01) return;
  root.style.setProperty("--mobileViewportHeight", `${viewport?.height ?? window.innerHeight}px`);
  root.style.setProperty("--mobileViewportTop", `${viewport?.offsetTop ?? 0}px`);
  window.dispatchEvent(new Event("mobileViewportChange"));
}

function scheduleViewport() {
  if (!viewportFrame) viewportFrame = requestAnimationFrame(updateViewport);
}

onMounted(() => {
  root.setAttribute("data-mobile-page", "");
  updateViewport();
  viewport?.addEventListener("resize", scheduleViewport);
  viewport?.addEventListener("scroll", scheduleViewport);
  window.addEventListener("resize", scheduleViewport);
  window.addEventListener("pageshow", scheduleViewport);
  document.addEventListener("visibilitychange", scheduleViewport);
});

onBeforeUnmount(() => {
  cancelAnimationFrame(viewportFrame);
  viewport?.removeEventListener("resize", scheduleViewport);
  viewport?.removeEventListener("scroll", scheduleViewport);
  window.removeEventListener("resize", scheduleViewport);
  window.removeEventListener("pageshow", scheduleViewport);
  document.removeEventListener("visibilitychange", scheduleViewport);
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
