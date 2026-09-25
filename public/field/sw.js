// Keeps the field app usable offline: the app itself is served from cache when there's no signal.
// API calls always go to the network; the app queues registrations itself.
const CACHE = "field-app-v1";
const SHELL = ["/field/", "/field/app.js", "/field/app.css", "/field/manifest.webmanifest", "/field/icon.svg"];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== "GET" || url.origin !== location.origin) return;
  if (!url.pathname.startsWith("/field/") || url.pathname.startsWith("/field/api/")) return;
  // Network first so agents get updates; fall back to the cached copy offline.
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        if (response.ok) {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put(event.request, copy));
        }
        return response;
      })
      .catch(() => caches.match(event.request, { ignoreSearch: true }).then((hit) => hit || caches.match("/field/"))),
  );
});
