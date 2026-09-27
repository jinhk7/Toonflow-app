export function registerPwaServiceWorker() {
  if (!import.meta.env.PROD || !("serviceWorker" in navigator)) return;
  const isDesktop = new URLSearchParams(window.location.search).get("desktop") === "1";
  if (isDesktop) return;
  void navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch(error => {
    console.warn("PWA 服务工作者注册失败", error);
  });
}
