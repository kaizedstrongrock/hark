// Service worker: HARK keeps working with no network and no hub (away from home, hub switched off).
// The whole app - including the sound model - is stored on the device when it is first opened.
// App files: network first (always the newest version when the hub is reachable), the stored copy otherwise.
// The sound model and libraries: stored copy first (they are large and rarely change).
// The hub's /api is never cached.
const VERSION = "hark-2.0.0";
const APP = [
  "./",
  "index.html",
  "manifest.webmanifest",
  "icon.svg",
  "icon-192.png",
  "icon-512.png",
  "icon-maskable-512.png",
  "css/app.css",
  "js/app.js",
  "js/app/hark.js",
  "js/audio/capture-worklet.js",
  "js/audio/mic.js",
  "js/audio/synth.js",
  "js/core/alertcenter.js",
  "js/core/alerts.js",
  "js/core/cadence.js",
  "js/core/custom.js",
  "js/core/dsp.js",
  "js/core/names.js",
  "js/core/pipeline.js",
  "js/core/protocol.js",
  "js/ml/yamnet.js",
  "js/net/homelink.js",
  "js/platform.js",
  "js/speech/captions.js",
  "js/speech/voice.js",
  "js/store.js",
  "js/ui/alertview.js",
  "js/ui/board.js",
  "js/ui/dom.js",
  "js/ui/icons.js",
  "js/ui/modal.js",
  "js/ui/parts.js",
  "js/ui/qr.js",
  "js/views/alerts.js",
  "js/views/devices.js",
  "js/views/home.js",
  "js/views/join.js",
  "js/views/settings.js",
  "js/views/teach.js",
  "sounds/baby.wav",
  "sounds/dog.wav",
  "sounds/glass.wav",
  "sounds/horn.wav",
  "sounds/knock.wav",
];
const LARGE = ["models/yamnet.tflite", "vendor/mediapipe/audio_bundle.mjs", "vendor/mediapipe/wasm/audio_wasm_internal.js", "vendor/mediapipe/wasm/audio_wasm_internal.wasm", "vendor/qrcode/qrcode.mjs"];
const NETWORK_TIMEOUT_MS = 3000;

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(VERSION);
      await cache.addAll([...APP, ...LARGE].map((u) => new Request(u, { cache: "reload" })));
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      for (const key of await caches.keys()) if (key !== VERSION && key.startsWith("hark-")) await caches.delete(key);
      await self.clients.claim();
    })(),
  );
});

function isLarge(url) {
  return url.pathname.includes("/models/") || url.pathname.includes("/vendor/");
}

async function networkFirst(request) {
  const cache = await caches.open(VERSION);
  try {
    const response = await Promise.race([fetch(request), new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), NETWORK_TIMEOUT_MS))]);
    if (response.ok && response.type === "basic") cache.put(request, response.clone());
    return response;
  } catch (e) {
    const cached = (await cache.match(request, { ignoreSearch: true })) || (request.mode === "navigate" ? await cache.match("index.html") : null);
    if (cached) return cached;
    throw e;
  }
}

async function cacheFirst(request) {
  const cache = await caches.open(VERSION);
  const cached = await cache.match(request, { ignoreSearch: true });
  if (cached) return cached;
  const response = await fetch(request);
  if (response.ok && response.type === "basic") cache.put(request, response.clone());
  return response;
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return; // other hubs on the home network: straight to the network
  if (url.pathname.includes("/api/")) return; // live hub traffic is never cached
  if (request.headers.get("range")) return;
  event.respondWith(isLarge(url) ? cacheFirst(request) : networkFirst(request));
});

// Tapping a notification brings HARK to the front.
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(
    (async () => {
      const all = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      const client = all[0];
      if (client) {
        client.postMessage({ type: "hark-notification", key: event.notification.data?.key });
        return client.focus();
      }
      return self.clients.openWindow("./");
    })(),
  );
});
