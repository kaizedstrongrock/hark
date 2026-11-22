// Home: is this device listening, is it connected to the other devices, and what happened recently.
import { h, mount, timeLabel } from "../ui/dom.js";
import { icon } from "../ui/icons.js";
import { alertRow, deviceRow, kindWord, eventsKey, devicesKey } from "../ui/parts.js";
import { joinNames } from "../app/hark.js";
import * as platform from "../platform.js";

export function render(root, hark) {
  const listenCard = h("section.card.listen-card", { "aria-labelledby": "listen-title" });
  const netCard = h("section.card.net-card", { "aria-labelledby": "net-title" });
  const banners = h("div.banners");
  const recentList = h("ul.alert-list");
  const recentCard = h(
    "section.card",
    { "aria-labelledby": "recent-title" },
    h("div.card-head", h("h2#recent-title", "Recent alerts"), h("a.link-btn", { href: "#/alerts" }, "See all", icon("chevronRight", { size: 22 }))),
    recentList,
  );
  const captionCard = h("section.card.caption-card", { hidden: true, "aria-live": "polite" });
  const hear = hearPanel(hark);
  mount(
    root,
    h(
      "div.page.home",
      h("h1.sr-only", { tabindex: "-1" }, "Home"),
      banners,
      h("div.home-grid", h("div.col", listenCard, netCard), h("div.col", recentCard, captionCard, hear.el)),
    ),
  );

  let lastListenKey = "";
  function renderListen() {
    const st = hark.listen.state;
    const key = `${st}|${hark.listen.message}|${hark.device.kind}`;
    if (key === lastListenKey) return;
    lastListenKey = key;
    const kind = kindWord(hark.device.kind);
    const on = st === "on";
    let title;
    let text;
    let button = null;
    if (on) {
      title = "Listening";
      text = `HARK is listening for important sounds on this ${kind}. Sounds are recognised right here and never recorded.`;
      button = h("button.btn.secondary.wide", { type: "button", onclick: () => hark.stopListening() }, icon("stop", { size: 26 }), h("span", "Stop listening"));
    } else if (st === "loading") {
      title = "Starting…";
      text = hark.listen.message;
      button = h("button.btn.primary.huge.wide", { type: "button", disabled: true }, "Starting…");
    } else if (st === "unavailable") {
      title = "This browser cannot listen here";
      text = "It will still show alerts from your other devices. To listen with this device too, use the HARK app, or open HARK on the computer that runs the hub.";
    } else {
      title = st === "blocked" ? "Microphone blocked" : st === "test" ? "Playing a test sound" : "Not listening";
      text = hark.listen.message || `Press the button to start. HARK will ask to use the microphone. Sounds are recognised on this ${kind} and never recorded or sent anywhere.`;
      button = h("button.btn.primary.huge.wide", { type: "button", onclick: () => hark.startListening() }, icon("mic", { size: 30 }), h("span", st === "blocked" || st === "error" ? "Try again" : "Start listening"));
    }
    const bgText = platform.listensInBackground
      ? "HARK keeps listening when you switch to another app or the screen turns off."
      : hark.device.kind === "computer"
        ? "Keep HARK open on the screen, so this computer stays awake and keeps listening."
        : "Keep HARK open on the screen: the microphone pauses when HARK is in the background.";
    const bg = on ? h("p.note", icon("info", { size: 22 }), h("span", bgText)) : null;
    mount(
      listenCard,
      h("div.status-head", h(`span.status-icon.${on ? "on" : "off"}`, { "aria-hidden": "true" }, icon(on ? "mic" : "micOff", { size: 40 })), h("h2#listen-title", title)),
      h("p.lead", text),
      on ? h("div.meter-wrap", h("span.meter-label#level-label", "Sound level"), h("div.meter", { role: "meter", "aria-labelledby": "level-label", "aria-valuemin": 0, "aria-valuemax": 100, "aria-valuenow": 0 }, h("b"))) : null,
      bg,
      button,
    );
  }

  let lastNetKey = "";
  function renderNet() {
    const net = hark.networkState;
    const devices = hark.devices();
    const netKey = `${net}|${hark.link?.hubs.length || 0}|${devicesKey(devices)}`;
    if (netKey === lastNetKey) return;
    lastNetKey = netKey;
    const kind = kindWord(hark.device.kind);
    let title;
    let text;
    let link;
    if (net === "connected") {
      title = "Connected to your other devices";
      text = `Anything one device hears, every device shows. ${devices.length === 1 ? "1 other device is" : `${devices.length} other devices are`} connected:`;
      link = h("a.link-btn", { href: "#/devices" }, "Devices", icon("chevronRight", { size: 22 }));
    } else if (net === "hub") {
      title = "Ready for your other devices";
      text = "This computer connects the devices in your home, but none is connected right now.";
      link = h("a.btn.secondary", { href: "#/devices" }, icon("plus", { size: 24 }), h("span", "Add a device"));
    } else {
      title = "Not connected to other devices";
      const knows = hark.link?.hubs.length;
      text = knows
        ? `This ${kind} listens and alerts on its own. It connects to your other devices by itself when it is back on your home Wi-Fi.`
        : `This ${kind} listens and alerts on its own. To share alerts between your phone, tablet and computer, connect them on the Devices page.`;
      link = h("a.btn.secondary", { href: "#/devices" }, icon("devices", { size: 24 }), h("span", knows ? "Devices" : "Connect devices"));
    }
    mount(
      netCard,
      h("div.status-head", h(`span.status-icon.${net === "connected" ? "on" : "off"}`, { "aria-hidden": "true" }, icon(net === "alone" ? "wifiOff" : "wifi", { size: 40 })), h("h2#net-title", title)),
      h("p.lead", text),
      net === "connected" ? h("ul.device-list", devices.map(deviceRow)) : null,
      h("div.card-foot", link),
    );
  }

  let lastBannerKey = "";
  function renderBanners() {
    const bannerKey = [platform.vibrationNeedsTap(), hark.settings.vibrate, hark.isListening, hark.listen.state, hark.canListen, hark.listeningPeers().map((p) => p.name).join(), eventsKey(hark.alerts.missed())].join("|");
    if (bannerKey === lastBannerKey) return;
    lastBannerKey = bannerKey;
    const out = [];
    if (hark.settings.vibrate && platform.vibrationNeedsTap()) {
      // phone browsers only let a page vibrate after it has been tapped once
      out.push(
        h(
          "div.banner.info.vibrate-banner",
          icon("smartphone", { size: 30 }),
          h(
            "div",
            h("p.banner-title", "Turn on vibration"),
            h("p", "This phone's browser lets HARK vibrate only after you tap the screen once."),
            h("div.banner-actions", h("button.btn.primary.small", { type: "button", onclick: () => hark.testVibration() }, "Turn on vibration")),
          ),
        ),
      );
    }
    const peers = hark.listeningPeers();
    if (!hark.isListening && hark.listen.state !== "loading") {
      if (!peers.length) {
        out.push(
          h(
            "div.banner.warn",
            { role: "status" },
            icon("warn", { size: 30 }),
            h("div", h("p.banner-title", "Nothing is listening right now"), h("p", hark.canListen ? "Press Start listening, or start HARK on another device, so you do not miss an alarm or the door." : "Start HARK on another device so that you do not miss an alarm or the door.")),
          ),
        );
      } else {
        out.push(h("div.banner.info", icon("info", { size: 30 }), h("div", h("p", `This device is not listening, but ${joinNames(peers.map((p) => p.name))} ${peers.length > 1 ? "are" : "is"}. You will still be alerted here.`))));
      }
    }
    const missed = hark.alerts.missed();
    if (missed.length) {
      out.push(
        h(
          "div.banner.missed",
          icon("list", { size: 30 }),
          h(
            "div",
            h("p.banner-title", `While this device was away: ${missed.length} alert${missed.length > 1 ? "s" : ""}`),
            h("p", missed.slice(-4).map((e) => `${e.label} at ${timeLabel(e.at)}`).join(" · ")),
            h("div.banner-actions", h("a.btn.secondary.small", { href: "#/alerts" }, "See alerts"), h("button.btn.secondary.small", { type: "button", onclick: () => hark.dismissMissed() }, "OK")),
          ),
        ),
      );
    }
    mount(banners, out);
  }

  let lastRecentKey = "";
  function renderRecent() {
    const list = hark.alerts.list().slice(0, 5);
    const recentKey = eventsKey(list);
    if (recentKey === lastRecentKey) return;
    lastRecentKey = recentKey;
    mount(recentList, list.length ? list.map((e) => alertRow(e, hark)) : h("li.empty", "No alerts yet. When HARK hears an important sound, it shows up here. You can try a test sound in Settings."));
  }

  function update() {
    renderListen();
    renderNet();
    renderBanners();
    renderRecent();
  }

  function onSound(s) {
    const meter = listenCard.querySelector(".meter");
    if (meter) {
      meter.firstChild.style.width = `${Math.round(s.level * 100)}%`;
      meter.setAttribute("aria-valuenow", String(Math.round(s.level * 100)));
    }
    hear.sound(s);
  }

  let captionTimer;
  function onCaption(c) {
    if (!c) return;
    captionCard.hidden = false;
    mount(captionCard, h("h2", "Speech nearby"), h("p.caption-text", `“${c.text}”`), h("p.row-meta", c.from === "this device" ? "Heard by this device" : `Heard by ${c.from}`));
    clearTimeout(captionTimer);
    captionTimer = setTimeout(() => (captionCard.hidden = true), c.final ? 10000 : 5000);
  }

  const offs = [hark.on("change", update), hark.on("sound", onSound), hark.on("frame", (f) => hear.frame(f)), hark.on("caption", onCaption)];
  // any first tap also unlocks vibration: take the reminder away then
  const firstTap = () => setTimeout(renderBanners, 0);
  document.addEventListener("pointerdown", firstTap, { once: true, capture: true });
  offs.push(() => document.removeEventListener("pointerdown", firstTap, { capture: true }));
  update();
  return () => {
    offs.forEach((f) => f());
    clearTimeout(captionTimer);
    hear.destroy();
  };
}

/** "What HARK hears": the live spectrogram and the sound model's top guesses (for the curious). */
function hearPanel(hark) {
  const BINS = 75;
  const canvas = h("canvas.spectro", { width: 640, height: 150, "aria-hidden": "true" });
  const top = h("ul.top-sounds");
  const rhythm = h("p.small");
  const speed = h("p.small");
  const el = h(
    "details.card.hear",
    h("summary", h("span", "Show what HARK hears"), icon("chevronRight", { size: 24, className: "chev" })),
    h("p.small", "A picture of the sound right now (low notes at the bottom, high at the top) and the sound recognition's best guesses. Everything happens on this device."),
    canvas,
    h("h3", "Best guesses right now"),
    top,
    rhythm,
    speed,
  );
  const ctx2d = canvas.getContext("2d");
  ctx2d.fillStyle = "#0e1726";
  ctx2d.fillRect(0, 0, canvas.width, canvas.height);
  const column = ctx2d.createImageData(1, canvas.height);
  const binMap = Array.from({ length: BINS }, (_, i) => {
    const f0 = 80 * Math.pow(8000 / 80, i / BINS);
    const f1 = 80 * Math.pow(8000 / 80, (i + 1) / BINS);
    return [Math.max(1, Math.floor(f0 / 31.25)), Math.max(1, Math.ceil(f1 / 31.25))];
  });
  let pending = [];
  let raf = false;
  let lastRhythm = "";
  function palette(v) {
    // dark blue -> blue -> teal -> pale yellow
    const stops = [
      [14, 23, 38],
      [30, 90, 190],
      [40, 180, 170],
      [250, 240, 180],
    ];
    const x = Math.max(0, Math.min(0.999, v)) * (stops.length - 1);
    const i = Math.floor(x);
    const f = x - i;
    return stops[i].map((c, k) => Math.round(c + (stops[i + 1][k] - c) * f));
  }
  function flush() {
    raf = false;
    if (!pending.length) return;
    const n = pending.length;
    const H = canvas.height;
    ctx2d.drawImage(canvas, -n, 0);
    pending.forEach((vals, ci) => {
      for (let y = 0; y < H; y++) {
        const [r, g, b] = palette(vals[Math.floor(((H - 1 - y) / H) * BINS)]);
        column.data.set([r, g, b, 255], y * 4);
      }
      ctx2d.putImageData(column, canvas.width - n + ci, 0);
    });
    pending = [];
  }
  return {
    el,
    frame(f) {
      if (!el.open) return;
      const vals = new Float32Array(BINS);
      for (let b = 0; b < BINS; b++) {
        const [lo, hi] = binMap[b];
        let m = 0;
        for (let k = lo; k <= hi && k < f.mag.length; k++) m = Math.max(m, f.mag[k]);
        vals[b] = (20 * Math.log10(m + 1e-9) + 10) / 55;
      }
      pending.push(vals);
      if (pending.length > 200) pending.splice(0, pending.length - 200);
      if (!raf) {
        raf = true;
        requestAnimationFrame(flush);
      }
    },
    sound(s) {
      if (!el.open) return;
      mount(
        top,
        s.top.map((t) => h("li", h("span.top-name", t.name), h("span.top-bar", { "aria-hidden": "true" }, h("b", { style: { width: `${Math.round(t.score * 100)}%` } })), h("span.top-pct", `${Math.round(t.score * 100)}%`))),
      );
      const c = s.cadence;
      const text =
        c.T3.cycles || c.T4.cycles
          ? `Alarm rhythm: ${c.T3.cycles ? `smoke alarm pattern (T3) × ${c.T3.cycles}` : ""}${c.T4.cycles ? ` carbon monoxide pattern (T4) × ${c.T4.cycles}` : ""} at ${Math.round((c.T3.freq || c.T4.freq || 0) / 10) * 10} Hz`
          : "Alarm rhythm: no smoke or carbon monoxide alarm pattern";
      if (text !== lastRhythm) rhythm.textContent = lastRhythm = text;
      if (hark.yam) speed.textContent = `Sound recognition: Google YAMNet, ${hark.yam.ms().toFixed(1)} ms per second of sound on this device.`;
    },
    destroy() {},
  };
}
