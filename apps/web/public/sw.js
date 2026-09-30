const staticCache = "toonflow-static-v2";
const staticAsset = /\.(?:js|css|woff2?|svg|png|ico|webmanifest)(?:\?|$)/i;

self.addEventListener("install", event => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", event => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) if (key.startsWith("toonflow-static-") && key !== staticCache) await caches.delete(key);
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", event => {
  const { request } = event;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/mcp") || url.pathname.startsWith("/a2a")) return;
  if (!staticAsset.test(url.pathname)) return;
  event.respondWith(
    caches.open(staticCache).then(async cache => {
      const cached = await cache.match(request);
      if (cached) return cached;
      const response = await fetch(request);
      if (response.ok) void cache.put(request, response.clone());
      return response;
    }),
  );
});
