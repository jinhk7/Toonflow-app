<template>
  <section class="mobileTasks">
    <mobileTopBar title="后台任务" :subtitle="projectName" :backTo="backTo">
      <template #actions><el-button text @click="openAgent">Agent</el-button></template>
    </mobileTopBar>
    <el-main>
      <mobileAgentPanel :directory="directory" />
      <mobileExecutePanel :directory="directory" />
    </el-main>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted } from "vue";
import { useRoute, useRouter } from "vue-router";
import mobileTopBar from "./components/mobileTopBar.vue";
import mobileExecutePanel from "./components/mobileExecutePanel.vue";
import mobileAgentPanel from "./components/mobileAgentPanel.vue";

const route = useRoute();
const directory = computed(() => String(route.query.directory ?? ""));
const projectName = computed(() => String(route.query.name ?? "项目"));
const backTo = computed(() => ({ path: "/mobile/workspace", query: route.query }));
const router = useRouter();
function openAgent() { void router.push({ path: "/mobile/agent", query: route.query }); }
onMounted(() => { if (!directory.value) void router.replace("/mobile"); });
</script>

<style scoped lang="scss">
.mobileTasks {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-width: 0;
  .el-main { padding: 12px; }
}
</style>
