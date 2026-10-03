// 提及和技能浮层共用手机壳层测出的可见区域；桌面继续使用布局视口。
export const mobilePopupOptions = { modifiers: [{ name: "preventOverflow", options: { altAxis: true, tether: false } }] };

export function agentPopupPosition(input: Element, limit = 420) {
  const bounds = input.getBoundingClientRect();
  const root = document.documentElement;
  const mobile = root.hasAttribute("data-mobile-page");
  const style = getComputedStyle(root);
  const value = (name: string, fallback = 0) => Number.parseFloat(style.getPropertyValue(name)) || fallback;
  const top = mobile ? value("--mobileViewportTop") + value("--mobileSafeTop") : 0;
  const bottom = mobile ? value("--mobileViewportTop") + value("--mobileViewportHeight", window.innerHeight) - value("--mobileSafeBottom") : window.innerHeight;
  const left = mobile ? value("--mobileSafeLeft") : 0;
  const right = window.innerWidth - (mobile ? value("--mobileSafeRight") : 0);
  const above = Math.max(0, bounds.top - top - 16);
  const below = Math.max(0, bottom - bounds.bottom - 16);
  const openBelow = above < 220 && below > above;
  const available = openBelow ? below : above;
  const fillViewport = mobile && available < 120;
  const height = Math.min(limit, fillViewport ? Math.max(0, bottom - top - 16) : available);
  const width = Math.min(bounds.width, Math.max(0, right - left - 16));
  return {
    height,
    style: {
      width: `${width}px`,
      left: `${Math.max(left + 8, Math.min(bounds.left, right - width - 8))}px`,
      top: fillViewport ? `${top + 8}px` : openBelow ? `${bounds.bottom + 8}px` : "auto",
      bottom: fillViewport || openBelow ? "auto" : `${window.innerHeight - Math.min(bounds.top - 8, bottom - 8)}px`,
    },
  };
}
