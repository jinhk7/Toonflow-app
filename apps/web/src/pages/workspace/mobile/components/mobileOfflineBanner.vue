<template>
  <el-alert v-if="!online" class="offlineBanner" type="warning" :closable="false" showIcon title="当前离线" description="仅可查看已缓存的静态资源；项目数据与 API 不可用，不会后台排队付费操作。" />
</template>

<script setup lang="ts">
import { onBeforeUnmount, ref } from "vue";

const online = ref(navigator.onLine);
function sync() { online.value = navigator.onLine; }
window.addEventListener("online", sync);
window.addEventListener("offline", sync);
onBeforeUnmount(() => {
  window.removeEventListener("online", sync);
  window.removeEventListener("offline", sync);
});
</script>

<style lang="scss" scoped>
.offlineBanner {
  border-radius: 0;
  margin: 0;
}
</style>
