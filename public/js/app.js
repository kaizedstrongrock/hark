// HARK app: one listening + alerting device per install, the same on computers, tablets and phones.
// Screens: #/ (home), #/alerts, #/devices, #/settings, #/teach, #/join?h=CODE (from a QR code).
import { Hark } from "./app/hark.js";
import { h, mount, toast } from "./ui/dom.js";
import { icon } from "./ui/icons.js";
import { mountAlertView } from "./ui/alertview.js";
import { mountBoard } from "./ui/board.js";
import * as platform from "./platform.js";

const ROUTES = {
  "": { view: "home", title: "Home", tab: "" },
  alerts: { view: "alerts", title: "Alerts", tab: "alerts" },
  devices: { view: "devices", title: "Devices", tab: "devices" },
  settings: { view: "settings", title: "Settings", tab: "settings" },
  teach: { view: "teach", title: "Teach HARK a sound", tab: "settings" },
  join: { view: "join", title: "Join a home", tab: "devices" },
};
// Links from HARK 1 (QR codes printed or saved before the redesign) still work.
const LEGACY = { listen: "", pager: "join", demo: "" };
const TABS = [
  { href: "#/", tab: "", label: "Home", icon: "home" },
  { href: "#/alerts", tab: "alerts", label: "Alerts", icon: "list" },
  { href: "#/devices", tab: "devices", label: "Devices", icon: "devices" },
  { href: "#/settings", tab: "settings", label: "Settings", icon: "gear" },
];

const hark = new Hark();
window.hark = hark; // for the automated tests and the curious

// ------------------------------------------------------------------ shell
const statusPill = h("a.status-pill", { href: "#/" });
const statusNews = h("p.sr-only", { role: "status" }); // spoken only when listening or the connection changes
const tabs = TABS.map((t) => h("a.tab", { href: t.href, dataset: { tab: t.tab } }, icon(t.icon, { size: 28 }), h("span", t.label)));
const main = h("main#main", { tabindex: "-1" });
mount(
  document.body,
  h("a.skip-link", { href: "#main", onclick: (e) => (e.preventDefault(), main.querySelector("h1")?.focus()) }, "Skip to main content"),
  h("header.topbar", h("a.brand", { href: "#/", "aria-label": "HARK home" }, h("span.brand-mark", { "aria-hidden": "true" }, icon("logo", { size: 26 })), h("span.brand-name", "HARK")), statusPill),
  h("nav.tabbar", { "aria-label": "Main" }, tabs),
  main,
  statusNews,
);
mountAlertView(document.body, hark);
mountBoard(document.body, hark);
hark.on("toast", ({ text, kind }) => toast(text, { kind }));

let lastPill = "";
let lastNews = null;
function updateShell() {
  document.documentElement.dataset.textSize = hark.settings.textSize || "normal";
  const listening = hark.isListening;
  const net = hark.networkState;
  const others = hark.devices().length;
  const netText = net === "connected" ? `${others} other device${others === 1 ? "" : "s"}` : "Not connected";
  const key = `${listening}|${netText}`;
  if (key === lastPill) return;
  lastPill = key;
  mount(
    statusPill,
    h("span.sr-only", "Status: "),
    h(`span.pill-part.${listening ? "on" : "off"}`, icon(listening ? "mic" : "micOff", { size: 20 }), h("span", listening ? "Listening" : "Not listening")),
    h("span.sr-only", ", "),
    h(`span.pill-part.${net === "connected" ? "on" : "off"}`, icon(net === "connected" ? "wifi" : "wifiOff", { size: 20 }), h("span", netText)),
  );
  const news = { listening, connected: net === "connected" };
  if (lastNews && lastNews.listening !== news.listening) statusNews.textContent = listening ? "HARK is listening on this device." : "HARK has stopped listening on this device.";
  else if (lastNews && lastNews.connected !== news.connected) statusNews.textContent = news.connected ? "Connected to your other devices." : "Not connected to your other devices.";
  lastNews = news;
}
hark.on("change", updateShell);

// ------------------------------------------------------------------ router
let cleanup = null;
let seq = 0;
let chain = Promise.resolve();
let renderedOnce = false;

function parseHash() {
  const raw = location.hash.replace(/^#\/?/, "");
  const [rawPath, query] = raw.split("?");
  const params = new URLSearchParams(query || "");
  let path = rawPath in LEGACY ? LEGACY[rawPath] : rawPath;
  if (rawPath === "pager" && !params.get("h")) path = "";
  if (!(path in ROUTES)) path = "";
  return { path, params };
}

// Screens render one at a time (a screen's async setup finishes, and is cleaned up, before the next).
function render() {
  const my = ++seq;
  chain = chain
    .then(() => (my === seq ? renderNow(my) : null))
    .catch((e) => {
      console.error(e);
      mount(main, h("div.page", h("h1", { tabindex: "-1" }, "Something went wrong"), h("p", `HARK could not show this page: ${e.message}`), h("a.btn.primary", { href: "#/" }, "Go to Home")));
    });
  return chain;
}

async function renderNow(my) {
  const { path, params } = parseHash();
  const route = ROUTES[path];
  try {
    await cleanup?.();
  } catch (e) {
    console.warn(e);
  }
  cleanup = null;
  const mod = await import(`./views/${route.view}.js`);
  if (my !== seq) return;
  for (const t of tabs) {
    if (t.dataset.tab === route.tab) t.setAttribute("aria-current", "page");
    else t.removeAttribute("aria-current");
  }
  document.title = `${route.title} · HARK`;
  hark.screenTitle = document.title;
  cleanup = (await mod.render(main, hark, params)) || null;
  // move focus to the new page's heading, so screen readers announce where you are
  if (renderedOnce) main.querySelector("h1")?.focus({ preventScroll: false });
  renderedOnce = true;
  window.scrollTo(0, 0);
}

window.addEventListener("hashchange", render);
platform.onDeepLink((url) => {
  // hark://join?h=K7Q4MX&hub=http://192.168.1.20:3000/ from the companion app's link handler
  try {
    const u = new URL(url);
    const q = u.search || (u.hash.includes("?") ? `?${u.hash.split("?")[1]}` : "");
    location.hash = `#/join${q}`;
  } catch {
    /* not a HARK link */
  }
});
platform.onNotificationTap(() => {
  if (location.hash.startsWith("#/teach")) return;
  window.focus?.();
});

if ("serviceWorker" in navigator && window.isSecureContext && !platform.isNative) {
  // works offline: the app, the sound model and the test sounds are cached on this device
  navigator.serviceWorker.register("sw.js").catch(() => {});
}

updateShell();
render();
hark.start().then(updateShell);
