import { h, inject } from "vue";
import { ElNotification } from "element-plus";
import nodeError from "./components/nodeError.vue";

export function useNodeError() {
  const getDirectory = inject<(() => string) | undefined>("workspaceDirectory", undefined);
  return (error: unknown, title: string) => {
    let directory: string | undefined;
    try { directory = getDirectory?.(); } catch { /* 原错误仍须显示；解释时提示选择项目。 */ }
    showNodeError(error, title, directory);
  };
}

export function showNodeError(error: unknown, title: string, directory?: string) {
  if (error instanceof Error && error.name === "AbortError") return;
  const detail = (error as { response?: { data?: { message?: unknown } } })?.response?.data?.message;
  const message = typeof detail === "string" && detail.trim() ? detail
    : error instanceof Error ? error.message : typeof error === "string" ? error : title;
  const controller = new AbortController();
  ElNotification({
    title,
    type: "error",
    duration: 0,
    customClass: "nodeErrorNotification",
    message: h(nodeError, { message: message || title, context: title, directory, signal: controller.signal }),
    onClose: () => controller.abort(),
  });
}
