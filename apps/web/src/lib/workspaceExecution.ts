import { toValue, type MaybeRefOrGetter } from "vue";
import { createExecutionClient } from "@toonflow/nodes-scaffold/runtime";
import { useWorkspaceStore } from "@/stores/workspace";

export default function useWorkspaceExecution(directory?: MaybeRefOrGetter<string | undefined>) {
  const workspace = directory === undefined ? useWorkspaceStore() : undefined;
  return () => {
    const target = directory === undefined ? workspace?.project?.directory : toValue(directory);
    if (!target) throw new Error("请先选择工作目录");
    return createExecutionClient(target);
  };
}
