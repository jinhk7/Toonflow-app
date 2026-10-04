<template>
  <div class="mobileNodeList">
    <section v-for="section in sections" :key="section.key" class="groupSection">
      <h2 v-if="groupByType" class="groupTitle">
        <button
          class="groupToggle"
          type="button"
          :aria-expanded="!collapsedTypes.has(section.key)"
          :aria-controls="`${listId}-${encodeURIComponent(section.key)}`"
          @click="toggleGroup(section.key)">
          <icon-chevron-right :size="18" class="chevron" :class="{ expanded: !collapsedTypes.has(section.key) }" aria-hidden="true" />
          <span class="typeName">{{ section.title }}</span>
          <span class="count">{{ section.nodes.length }}</span>
        </button>
      </h2>
      <ul :id="`${listId}-${encodeURIComponent(section.key)}`" v-show="!groupByType || !collapsedTypes.has(section.key)" class="nodeRows">
        <li v-for="node in section.nodes" :key="node.id">
          <div class="nodeRow" :class="{ highlighted: node.id === highlightId }">
            <el-checkbox
              :modelValue="selectedIds.includes(node.id)"
              :aria-label="`选择 ${nodeLabel(node)}`"
              @update:modelValue="emit('toggleSelect', node.id)" />
            <button class="nodeMain" type="button" @click="emit('openNode', node.id)">
              <span class="label">{{ nodeLabel(node) }}</span>
              <span class="meta">{{ typeLabels.get(String(node.type ?? 'unknown')) ?? node.type ?? 'unknown' }}</span>
            </button>
          </div>
        </li>
      </ul>
    </section>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, useId, watch } from "vue";
import { IconChevronRight } from "@tabler/icons-vue";
import { nodeLabel, type CanvasNode } from "../lib/mobileGraphModel";

const props = defineProps<{
  nodes: CanvasNode[];
  typeLabels: Map<string, string>;
  groupByType: boolean;
  selectedIds: string[];
  highlightId?: string;
}>();

const emit = defineEmits<{
  toggleSelect: [nodeId: string];
  openNode: [nodeId: string];
}>();

const listId = useId();
const collapsedTypes = ref(new Set<string>());
const sections = computed(() => {
  if (!props.groupByType) return [{ key: "all", title: "", nodes: props.nodes }];
  const groups = new Map<string, { key: string; title: string; nodes: CanvasNode[] }>();
  for (const node of props.nodes) {
    const type = String(node.type ?? "unknown");
    if (!groups.has(type)) groups.set(type, { key: type, title: props.typeLabels.get(type) ?? type, nodes: [] });
    groups.get(type)!.nodes.push(node);
  }
  return [...groups.values()].sort((left, right) => left.title.localeCompare(right.title, "zh-CN"));
});

function toggleGroup(type: string) {
  if (collapsedTypes.value.has(type)) collapsedTypes.value.delete(type);
  else collapsedTypes.value.add(type);
}

watch(() => props.highlightId, id => {
  const node = props.nodes.find(item => item.id === id);
  if (node) collapsedTypes.value.delete(String(node.type ?? "unknown"));
});
</script>

<style lang="scss" scoped>
.mobileNodeList {
  .groupSection {
    margin-bottom: 16px;

    .groupTitle {
      margin: 0 0 6px;
      font-size: 14px;

      .groupToggle {
        display: flex;
        align-items: center;
        gap: 8px;
        width: 100%;
        min-height: 44px;
        padding: 8px;
        border: 0;
        border-radius: var(--el-border-radius-base);
        background: transparent;
        color: var(--el-text-color-primary);
        font: inherit;
        font-weight: 600;
        text-align: left;
        cursor: pointer;

        .chevron {
          flex-shrink: 0;

          &.expanded {
            transform: rotate(90deg);
          }
        }

        .typeName {
          flex: 1;
          min-width: 0;
          overflow-wrap: anywhere;
        }

        .count {
          flex-shrink: 0;
          color: var(--el-text-color-secondary);
        }
      }
    }

    .nodeRows {
      list-style: none;
      margin: 0;
      padding: 0;
      display: flex;
      flex-direction: column;
      gap: 6px;

      .nodeRow {
        display: flex;
        align-items: stretch;
        gap: 4px;
        border-radius: var(--el-border-radius-base);
        background: var(--el-bg-color);
        border: 1px solid var(--el-border-color-lighter);

        :deep(.el-checkbox) {
          flex-shrink: 0;
          min-width: 44px;
          min-height: 48px;
          margin: 0;
          justify-content: center;
        }

        &.highlighted {
          border-color: var(--el-color-primary);
          box-shadow: 0 0 0 1px var(--el-color-primary-light-7);
        }

        .nodeMain {
          flex: 1;
          min-width: 0;
          min-height: 48px;
          padding: 10px 12px 10px 4px;
          border: 0;
          background: transparent;
          text-align: left;
          color: inherit;
          cursor: pointer;
          overflow-wrap: anywhere;

          .label {
            display: block;
            font-weight: 600;
          }

          .meta {
            display: block;
            font-size: 12px;
            color: var(--el-text-color-secondary);
          }
        }
      }
    }
  }
}
</style>
