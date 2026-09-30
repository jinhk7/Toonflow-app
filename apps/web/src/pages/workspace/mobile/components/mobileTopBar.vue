<template>
  <header class="mobileTopBar">
    <el-button v-if="showBack" class="backButton" text :icon="IconChevronLeft" aria-label="返回" @click="goBack" />
    <div class="titles">
      <h1 class="title">{{ title }}</h1>
      <p v-if="subtitle" class="subtitle">{{ subtitle }}</p>
    </div>
    <slot name="actions" />
  </header>
</template>

<script setup lang="ts">
import { IconChevronLeft } from "@tabler/icons-vue";
import { useRouter, type RouteLocationRaw } from "vue-router";

const props = withDefaults(defineProps<{
  title: string;
  subtitle?: string;
  showBack?: boolean;
  backTo?: RouteLocationRaw;
}>(), { showBack: true });

const router = useRouter();

function goBack() {
  if (props.backTo) void router.push(props.backTo);
  else router.back();
}
</script>

<style lang="scss" scoped>
.mobileTopBar {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 12px 12px 8px;
  padding-top: calc(12px + env(safe-area-inset-top));
  background: var(--el-bg-color);
  border-bottom: 1px solid var(--el-border-color-lighter);
  position: sticky;
  top: 0;
  z-index: 10;

  .backButton {
    min-width: 44px;
    min-height: 44px;
  }

  .titles {
    flex: 1;
    min-width: 0;
  }

  .title {
    margin: 0;
    font-size: 17px;
    font-weight: 600;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .subtitle {
    margin: 2px 0 0;
    font-size: 12px;
    color: var(--el-text-color-secondary);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
}
</style>
