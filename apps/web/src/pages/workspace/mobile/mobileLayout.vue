<template>
  <div class="mobileLayout">
    <mobileOfflineBanner />
    <router-view />
  </div>
</template>

<script setup lang="ts">
import mobileOfflineBanner from "./components/mobileOfflineBanner.vue";
</script>

<style lang="scss" scoped>
.mobileLayout {
  min-height: 100dvh;
  display: flex;
  flex-direction: column;
  background: var(--el-bg-color-page);
  padding-bottom: env(safe-area-inset-bottom);
}
</style>
