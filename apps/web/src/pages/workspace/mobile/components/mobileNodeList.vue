<template>
  <div class="mobileNodeList">
    <section v-for="section in sections" :key="section.key" class="groupSection">
      <h2 v-if="section.title" class="groupTitle">{{ section.title }}</h2>
      <ul class="nodeRows">
        <li v-for="row in section.rows" :key="row.node.id">
          <div class="nodeRow" :class="{ highlighted: row.node.id === highlightId }">
            <el-checkbox
              :modelValue="selectedIds.includes(row.node.id)"
              :aria-label="`选择 ${row.label}`"
              @update:modelValue="emit('toggleSelect', row.node.id)" />
            <button class="nodeMain" type="button" @click="emit('openNode', row.node.id)">
              <span class="label">{{ row.label }}</span>
              <span class="meta">{{ row.type }}</span>
              <span v-if="row.path" class="path">{{ row.path }}</span>
            </button>
          </div>
        </li>
      </ul>
      <mobileNodeList
        v-for="child in section.children"
        :key="child.key"
        :tree="child.tree"
        :selectedIds="selectedIds"
        :groupPath="section.path"
        :highlightId="highlightId"
        @toggleSelect="emit('toggleSelect', $event)"
        @openNode="emit('openNode', $event)"
        @openRef="emit('openRef', $event)" />
    </section>
  </div>
</template>

<script setup lang="ts">
import { computed } from "vue";
import { nodeLabel, type GroupTreeItem } from "../lib/mobileGraphModel";

const props = defineProps<{
  tree: GroupTreeItem;
  selectedIds: string[];
  highlightId?: string;
  groupPath?: string[];
}>();

const emit = defineEmits<{
  toggleSelect: [nodeId: string];
  openNode: [nodeId: string];
  openRef: [nodeId: string];
}>();

const sections = computed(() => {
  const items: { key: string; title: string; path: string[]; rows: { node: GroupTreeItem["nodes"][number]; label: string; type: string; path: string }[]; children: { key: string; tree: GroupTreeItem }[] }[] = [];
  for (const child of props.tree.group || props.tree.nodes.length ? [props.tree] : props.tree.children) {
    const title = child.group ? nodeLabel(child.group) : "未分组";
    const path = child.group ? [...(props.groupPath ?? []), title] : props.groupPath ?? [];
    items.push({
      key: child.group?.id ?? "root-loose",
      path,
      title,
      rows: child.nodes.map(node => ({
        node,
        label: nodeLabel(node),
        type: String(node.type ?? "unknown"),
        path: path.join(" / "),
      })),
      children: child.children.map((sub, index) => ({
        key: `${child.group?.id ?? "root"}-${index}`,
        tree: sub,
      })),
    });
  }
  return items;
});
</script>

<style lang="scss" scoped>
.groupSection {
  margin-bottom: 16px;
}

.groupTitle {
  margin: 0 0 8px 8px;
  font-size: 13px;
  font-weight: 600;
  color: var(--el-text-color-secondary);
}

.nodeRows {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.nodeRow {
  display: flex;
  align-items: stretch;
  gap: 4px;
  border-radius: var(--el-border-radius-base);
  background: var(--el-bg-color);
  border: 1px solid var(--el-border-color-lighter);
  :deep(.el-checkbox) {
    min-width: 44px;
    min-height: 48px;
    margin: 0;
    justify-content: center;
  }

  &.highlighted {
    border-color: var(--el-color-primary);
    box-shadow: 0 0 0 1px var(--el-color-primary-light-7);
  }
}

.nodeMain {
  flex: 1;
  min-height: 48px;
  padding: 10px 12px 10px 4px;
  border: 0;
  background: transparent;
  text-align: left;
  color: inherit;
  cursor: pointer;

  .label {
    display: block;
    font-weight: 600;
  }

  .meta {
    display: block;
    font-size: 12px;
    color: var(--el-text-color-secondary);
  }

  .path {
    display: block;
    font-size: 11px;
    color: var(--el-text-color-placeholder);
  }
}
</style>
