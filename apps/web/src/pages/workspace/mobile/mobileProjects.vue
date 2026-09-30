<template>
  <section class="mobileProjects">
    <mobileTopBar title="手机项目" :showBack="false">
      <template #actions>
        <el-button text :icon="IconRefresh" :loading="loading" aria-label="刷新" @click="refresh" />
      </template>
    </mobileTopBar>
    <el-main class="content">
      <el-alert v-if="error" type="error" :title="error" showIcon :closable="false" />
      <el-empty v-else-if="!loading && !projects.length" description="暂无登记项目，请先在桌面端导入或创建" />
      <ul v-else class="projectList">
        <li v-for="project in projects" :key="project.directory">
          <button class="projectCard" type="button" :disabled="project.status === 'missing' || opening" @click="openProject(project)">
            <icon-folder :size="28" aria-hidden="true" />
            <span class="info">
              <span class="name">{{ project.name }}</span>
              <span class="path">{{ project.directory }}</span>
              <el-tag v-if="project.status === 'missing'" size="small" type="danger">目录不可用</el-tag>
            </span>
            <icon-chevron-right :size="20" aria-hidden="true" />
          </button>
        </li>
      </ul>
      <p class="hint">桌面画布请访问 <router-link to="/home">首页</router-link>；此处为列表式节点编辑入口。</p>
    </el-main>
  </section>
</template>

<script setup lang="ts">
import { onMounted, ref } from "vue";
import { useRouter } from "vue-router";
import { IconChevronRight, IconFolder, IconRefresh } from "@tabler/icons-vue";
import { ElMessage } from "element-plus";
import type { Project } from "@/stores/workspace";
import mobileTopBar from "./components/mobileTopBar.vue";
import { useMobileProjects } from "./lib/useMobileProjects";

const router = useRouter();
const { projects, loading, error, refresh, touchOpen } = useMobileProjects();
const opening = ref(false);

onMounted(() => void refresh());

async function openProject(project: Project) {
  if (project.status === "missing") return;
  opening.value = true;
  try {
    await touchOpen(project.directory, project.name);
    await router.push({
      path: "/mobile/workspace",
      query: { directory: project.directory, name: project.name },
    });
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : "打开项目失败");
  } finally {
    opening.value = false;
  }
}
</script>

<style lang="scss" scoped>
.mobileProjects {
  flex: 1;
  display: flex;
  flex-direction: column;
}

.content {
  padding: 12px 16px 24px;
}

.projectList {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.projectCard {
  width: 100%;
  min-height: 56px;
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 14px;
  border: 1px solid var(--el-border-color-lighter);
  border-radius: var(--el-border-radius-base);
  background: var(--el-bg-color);
  color: inherit;
  text-align: left;
  cursor: pointer;

  &:disabled {
    opacity: 0.55;
    cursor: not-allowed;
  }

  .info {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .name {
    font-weight: 600;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .path {
    font-size: 12px;
    color: var(--el-text-color-secondary);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
}

.hint {
  margin-top: 20px;
  font-size: 13px;
  color: var(--el-text-color-secondary);
}
</style>
