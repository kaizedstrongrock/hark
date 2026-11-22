// The HARK device. Every device - computer, tablet or phone - is the same: it listens with its own
// microphone, alerts the person holding it, and works entirely on its own. When it can reach its home's
// hub it also joins the home listening network: what any device hears alerts every device.
// One instance per app; it keeps listening while the person moves between screens.
import { ALERTS, AlertEngine } from "../core/alerts.js";
import { Listener, windowsForTraining } from "../core/pipeline.js";
import { embed, trainCustom, serializeModel, deserializeModel } from "../core/custom.js";
import { AlertCenter } from "../core/alertcenter.js";
import { decodeWav, resample } from "../core/dsp.js";
import { TEST_SOUNDS, tone, sampleChime } from "../audio/synth.js";
import { startMic, playSamples } from "../audio/mic.js";
import { loadYamnet } from "../ml/yamnet.js";
import { Captions } from "../speech/captions.js";
import { speak, setServerVoice } from "../speech/voice.js";
import { HomeLink } from "../net/homelink.js";
import { CODE_RE, normalizeHubAddress } from "../core/protocol.js";
import { store, deviceId, claimDeviceId, migrateV1, newCode } from "../store.js";
import * as platform from "../platform.js";

/** Sounds HARK itself can make (alert tone, spoken replies and their chime) - see the echo guard. */
const ECHO_KINDS = new Set(["alarm", "doorbell", "phone", "speech", "name"]);
const DOOR_KINDS = new Set(["doorbell", "knock"]);
const STATUS_EVERY_MS = 10000;
export const PEER_FRESH_MS = 30000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class Hark extends EventTarget {
  constructor() {
    super();
    migrateV1();
    const d = store.device();
    this.device = { id: deviceId(), name: d.name, kind: d.kind };
    this.deviceNamed = d.named;
    this.home = store.home();
    this.settings = store.settings();
    this.canListen = !!(globalThis.isSecureContext && navigator.mediaDevices?.getUserMedia);
    // a browser on a plain-http page (a phone opening a hub's home-network address) may not use the microphone
    this.listen = this.canListen ? { state: "off", message: "" } : { state: "unavailable", message: "" };
    this.engine = new AlertEngine({ enabled: this.settings.enabled, sensitivity: this.settings.sensitivity });
    this.alerts = new AlertCenter({ selfId: this.device.id, events: store.events() });
    this.customs = store
      .customSounds()
      .map((c) => ({ ...c, model: deserializeModel(c.model) }))
      .filter((c) => c.model);
    this.peers = new Map(); // device id -> {listening, canListen, statusAt}
    this.localHub = null;
    this.serverVoice = false;
    this.yam = null;
    this.listener = null;
    this.mic = null;
    this.feedTimer = null;
    this.inject = [];
    this.testUntil = -1;
    this.quietUntil = 0;
    this.teaching = false;
    this.teachingUntil = 0;
    this.lastAudioAt = 0;
    this.captions = null;
    this.captionSentAt = 0;
    this.lastCaption = null;
    this.urgentTimer = null;
    this.audioCtx = null;
    this.board = null;
    this.soundCache = new Map();
    this.destroyed = false;
    this.started = false;
  }

  // ------------------------------------------------------------------ events for the UI

  emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  on(type, fn) {
    const h = (e) => fn(e.detail);
    this.addEventListener(type, h);
    return () => this.removeEventListener(type, h);
  }

  changed() {
    this.emit("change");
  }

  toast(text, kind = "info") {
    this.emit("toast", { text, kind });
  }

  // ------------------------------------------------------------------ start

  async start() {
    if (this.started) return;
    this.started = true;
    platform.initPlatform();
    // the link exists right away (before anything is awaited), so every screen can use it
    this.link = new HomeLink({
      code: this.home.code,
      device: this.device,
      hubs: store.hubs(),
      cursors: store.cursors(),
      onMessage: (type, msg, info) => this._onMessage(type, msg, info),
      onChange: () => this._linkChanged(),
      onHubs: (hubs) => store.saveHubs(hubs),
      onCursor: (key, ts) => store.saveCursor(key, ts),
      onConnect: () => this._sendStatus(),
      onReplayDone: () => this._replayDone(),
      forgotten: store.forgottenHubs(),
      onForgotten: (ids) => store.saveForgottenHubs(ids),
    });
    this.replayQueue = [];
    platform.onResume(() => {
      this.link.probeNow();
      this._checkMic();
    });
    platform.onNetworkChange(() => this.link.probeNow());
    // keep the alert history even when the app is closed right after an alert
    addEventListener("pagehide", () => store.saveEvents(this.alerts.toJSON()));
    this.statusTimer = setInterval(() => {
      this._sendStatus();
      this._checkMic();
      this._prunePeers();
    }, STATUS_EVERY_MS);
    // a duplicated browser tab starts with the same device id as the original: give it its own
    const id = await claimDeviceId(this.device.id);
    if (id !== this.device.id) {
      this.device.id = id;
      this.link.device.id = id;
      this.alerts.selfId = id;
    }
    // Was this page served by a HARK hub (a computer running `npm start`)? Then that hub is this device's own.
    try {
      const r = await fetch("api/status", { cache: "no-store" });
      const s = r.ok ? await r.json() : null;
      if (s && s.app === "hark" && typeof s.hubId === "string") {
        this.localHub = { id: s.hubId, urls: [new URL("./", location.href).href, ...(s.lan || [])], name: s.name };
        this.serverVoice = s.voice === "elevenlabs";
      }
    } catch {
      /* static hosting or the companion app: no hub of its own */
    }
    setServerVoice(this.serverVoice);
    if (this.localHub) this.link.addHub(this.localHub, { local: true });
    this.link.start();
    if (this.settings.autoListen && this.canListen && (await this._micAllowed())) this.startListening({ auto: true });
    else if (this.canListen) {
      // load the sound model in a quiet moment, so listening starts at once (and also works offline later)
      const later = (fn) => (globalThis.requestIdleCallback ? requestIdleCallback(fn, { timeout: 4000 }) : setTimeout(fn, 1500));
      later(() => this._ensureListener().catch(() => {}));
    }
    this._updateUrgent();
    this.changed();
  }

  async _micAllowed() {
    if (this.settings.micOk) return true;
    try {
      const p = await navigator.permissions?.query({ name: "microphone" });
      return p?.state === "granted";
    } catch {
      return false;
    }
  }

  // ------------------------------------------------------------------ the home network

  _linkChanged() {
    const members = this.link.members();
    const ids = new Set(members.map((m) => m.id));
    for (const id of [...this.peers.keys()]) if (!ids.has(id)) this.peers.delete(id);
    this.changed();
  }

  _prunePeers() {
    const before = this.listeningPeers().length;
    if (before !== this._lastListeningPeers) {
      this._lastListeningPeers = before;
      this.changed();
    }
  }

  /** The other devices of the home connected right now, with what they are doing. */
  devices() {
    const now = Date.now();
    return this.link
      ? this.link.members().map((m) => {
          const s = this.peers.get(m.id);
          const fresh = s && now - s.statusAt < PEER_FRESH_MS;
          return { ...m, listening: !!(fresh && s.listening), canListen: s ? s.canListen : true, responding: !!fresh };
        })
      : [];
  }

  listeningPeers() {
    return this.devices().filter((d) => d.listening);
  }

  get isListening() {
    return this.listen.state === "on";
  }

  /** connected: with other devices; hub: connected to a hub, but no other device is there; alone. */
  get networkState() {
    if (!this.link || !this.link.connected) return "alone";
    return this.link.members().length ? "connected" : "hub";
  }

  _sendStatus() {
    if (!this.link?.connected) return;
    this.link.send("status", { listening: this.isListening, canListen: this.canListen, tone: !!this.settings.tone }).catch(() => {});
  }

  _onMessage(type, msg, info) {
    if (type === "status") {
      this.peers.set(msg.from.id, { listening: !!msg.payload.listening, canListen: msg.payload.canListen !== false, tone: !!msg.payload.tone, statusAt: Date.now() });
      this.changed();
    } else if (type === "alert") {
      this._receive(msg, info);
    } else if (type === "ack") {
      const changed = this.alerts.remoteAck(msg.payload, msg.from, { age: info.age });
      this.engine.ack(msg.payload.kind);
      if (changed.length) {
        for (const e of changed) platform.clearNotification(e.key);
        if (!info.replay) this.toast(`${msg.from.name} has seen it`, "ok");
        if (this.board?.kind === "sign" && changed.some((e) => DOOR_KINDS.has(e.kind)) && !info.replay) {
          this._showBoard("sign", this.settings.doorMessage, "They have seen it. Please wait a moment.", 25000);
        }
        this._saveEvents();
        this._updateUrgent();
        this.changed();
      }
    } else if (type === "reply") {
      const p = msg.payload;
      const reply = { id: msg.id, text: p.text, by: msg.from, at: Date.now() - info.age * 1000 };
      this.alerts.addReply(p.replyTo, reply);
      this._saveEvents();
      const live = !info.replay || info.age < 30;
      if (live) this.quietUntil = Math.max(this.quietUntil, Date.now() + 10000); // someone is about to speak: not a doorbell
      const forMe = !p.to || p.to.includes(this.device.id);
      if (forMe && live) {
        this._showBoard("reply", p.text, `Message from ${msg.from.name}`, 14000);
        if (p.speak !== false && this.settings.speakReplies) this._speak(p.text);
      }
      this.changed();
    } else if (type === "caption") {
      this.lastCaption = { text: msg.payload.text, from: msg.from.name, at: Date.now(), final: msg.payload.final };
      this.emit("caption", this.lastCaption);
    }
  }

  // ------------------------------------------------------------------ alerts in

  /** A page from this device's own detector. */
  async _localAlert(p) {
    const test = this.listener && this.listener.t <= this.testUntil;
    // while a sound is being taught, HARK hears it on purpose: no alerts about it (urgent ones still go out)
    if (p.priority !== "urgent" && (this.teaching || Date.now() < this.teachingUntil)) return;
    if (!test && this._echoGuarded(p)) return;
    const payload = {
      kind: p.kind,
      label: p.label,
      priority: p.priority,
      confidence: p.confidence,
      detail: p.detail,
      advice: p.advice,
      vibrate: p.vibrate,
      test: test || undefined,
      custom: p.custom,
      repeat: p.repeat,
    };
    const mid = this.link ? this.link.newId() : `${this.device.id}.${Date.now().toString(36)}.local`;
    const msg = { id: mid, from: { id: this.device.id, name: this.device.name, kind: this.device.kind }, payload };
    const { action, event } = this.alerts.add(msg);
    this._afterAdd(action, event, { local: true });
    // Sent to every connected hub, and kept for 30 s for any hub that (re)connects meanwhile, so a Wi-Fi blip or a
    // hub restart does not lose it. (Heard while away from home for longer: it stays on this device.)
    await this.link?.send("alert", payload, { mid, keepFor: 30000 });
  }

  /** Does this device, or any device of the home, play a beep with its alerts? */
  _someoneBeeps() {
    if (this.settings.tone) return true;
    const now = Date.now();
    for (const p of this.peers.values()) if (p.tone && now - p.statusAt < PEER_FRESH_MS) return true;
    return false;
  }

  _echoGuarded(p) {
    if (p.priority === "urgent" || !ECHO_KINDS.has(p.kind)) return false;
    if (Date.now() < this.quietUntil) return true;
    // an urgent alarm is ringing somewhere: alert tones are not a new "alarm or timer"
    return p.kind === "alarm" && this.alerts.pendingUrgent().length > 0;
  }

  _receive(msg, info) {
    // replayed alerts from before this device joined this home are history, not something it missed
    const before = info.replay && this.home.joinedAt && Date.now() - info.age * 1000 < this.home.joinedAt;
    const { action, event } = this.alerts.add(msg, { age: info.age, firstSync: info.firstSync || before });
    if (info.replay) {
      // wait until the whole replay is in: an acknowledgement later in it may already cover this alert
      if (action === "new") this.replayQueue.push(event);
      if (event && action !== "duplicate") this._saveEvents();
      return;
    }
    this._afterAdd(action, event, { local: false });
  }

  /** A hub has replayed what this device missed: alert for what is still open. */
  _replayDone() {
    const queued = this.replayQueue.splice(0);
    for (const e of new Set(queued)) if (!e.acked && !e.missed && !e.history) this._afterAdd("new", e, { local: false });
    this._updateUrgent();
    this.changed();
  }

  _afterAdd(action, event, { local }) {
    if (!event) return;
    if (action === "duplicate" || action === "invalid") return;
    this._saveEvents();
    if (action === "new") {
      // a device that beeps with each alert makes a sound the microphones around it will hear: not a new sound
      if (this._someoneBeeps()) this.quietUntil = Math.max(this.quietUntil, Date.now() + 8000);
      this._present(event, { local });
    }
    if (action === "missed") this.changed();
    this._updateUrgent();
    this.changed();
  }

  /** Alert the person on this device. */
  _present(e, { local }) {
    if (!this.settings.showAlerts) return;
    if (e.priority === "info") {
      // quiet information: a short buzz and a note, nothing to acknowledge
      this.alerts.acknowledge(e.key, { id: "auto", name: "auto" });
      this.toast(`${e.label} · ${this.whereLabel(e)}`);
      if (this.settings.vibrate) platform.vibrate([150]);
      this.emit("alert", { event: e });
      return;
    }
    if (local && DOOR_KINDS.has(e.kind) && this.settings.doorSign) {
      // this device is by the door: show the visitor a sign (the person is alerted on their other devices)
      this._showBoard("sign", this.settings.doorMessage, "They are being alerted now. Please wait.", 25000);
    }
    this.emit("alert", { event: e });
    if (e.priority !== "urgent") {
      if (this.settings.vibrate) platform.vibrate(e.vibrate || [200, 100, 200]);
      this._tone(2);
    }
    if (document.visibilityState !== "visible" || platform.isNative) {
      platform.notify({
        key: e.key,
        title: e.label,
        body: `${this.whereLabel(e)}${e.test ? " (test)" : ""}`,
        urgent: e.priority === "urgent",
        vibrate: this.settings.vibrate ? e.vibrate || [200, 100, 200] : undefined,
      });
    }
  }

  /** Urgent alerts buzz (and beep, if wanted) every few seconds until someone acknowledges them. */
  _updateUrgent() {
    const pending = this.settings.showAlerts ? this.alerts.pendingUrgent() : [];
    if (pending.length && !this.urgentTimer) {
      const pattern = pending[0].vibrate || [500, 250, 500, 250, 500, 900];
      const ring = () => {
        if (this.settings.vibrate) platform.vibrate(pattern);
        this._tone(3);
      };
      ring();
      this.urgentTimer = setInterval(ring, 3500);
    } else if (!pending.length && this.urgentTimer) {
      clearInterval(this.urgentTimer);
      this.urgentTimer = null;
      platform.stopVibration();
    }
  }

  whereLabel(e) {
    const names = e.heardBy.map((d) => (d.id === this.device.id ? "this device" : d.name));
    return names.length ? `Heard by ${joinNames(names)}` : "";
  }

  _saveEvents() {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => store.saveEvents(this.alerts.toJSON()), 300);
  }

  // ------------------------------------------------------------------ acknowledging and replying

  /** "I've seen it" for one event (and its kind), told to every device. */
  async acknowledge(key) {
    const r = this.alerts.acknowledge(key, { id: this.device.id, name: this.device.name });
    if (!r) return;
    this.engine.ack(r.kind);
    platform.clearNotification(key);
    this._saveEvents();
    this._updateUrgent();
    this.changed();
    // kept for 10 minutes for hubs that reconnect, so the other devices stop buzzing even after a Wi-Fi blip
    await this.link.send("ack", { alertId: r.alertId, kind: r.kind }, { keepFor: 600000 });
  }

  /** "I've seen it" for everything on screen. */
  async acknowledgeAll() {
    const keys = this.alerts.open().map((e) => e.key);
    await Promise.all(keys.map((k) => this.acknowledge(k)));
  }

  /** Reply to an alert: shown (and spoken) on the devices that heard it. */
  async reply(key, text, speakIt = true) {
    const e = this.alerts.byKey(key);
    if (!e) return { ok: false, error: "That alert is gone" };
    const to = e.heardBy.filter((d) => d.id !== this.device.id).map((d) => d.id);
    if (!to.length) return { ok: false, error: "No other device heard this" };
    const r = await this.link.send("reply", { text, speak: speakIt, replyTo: e.ids[e.ids.length - 1], to });
    if (r.ok) {
      this.alerts.addReply(e.ids[e.ids.length - 1], { id: r.mid, text, by: { id: this.device.id, name: "You" }, at: Date.now(), mine: true });
      this._saveEvents();
      this.changed();
    }
    return r;
  }

  dismissMissed() {
    this.alerts.dismissMissed();
    this._saveEvents();
    this.changed();
  }

  clearHistory() {
    this.alerts.clear();
    this._saveEvents();
    this.changed();
  }

  // ------------------------------------------------------------------ sound out (with the echo guard)

  _tone(times) {
    if (!this.settings.tone) return;
    try {
      this.audioCtx ||= new AudioContext();
      const t0 = this.audioCtx.currentTime;
      for (let i = 0; i < times; i++) {
        const o = this.audioCtx.createOscillator();
        const g = this.audioCtx.createGain();
        o.type = "square";
        o.frequency.value = 520; // low tones are easier to hear with high-frequency hearing loss
        g.gain.setValueAtTime(0.0001, t0 + i * 0.35);
        g.gain.exponentialRampToValueAtTime(0.3, t0 + i * 0.35 + 0.01);
        g.gain.exponentialRampToValueAtTime(0.0001, t0 + i * 0.35 + 0.25);
        o.connect(g).connect(this.audioCtx.destination);
        o.start(t0 + i * 0.35);
        o.stop(t0 + i * 0.35 + 0.26);
      }
      this.quietUntil = Math.max(this.quietUntil, Date.now() + times * 350 + 2500);
    } catch {
      /* no audio output */
    }
  }

  async _speak(text) {
    this.quietUntil = Math.max(this.quietUntil, Date.now() + 20000);
    try {
      await speak(text, { code: this.home.code });
    } catch {
      /* no voice */
    }
    this.quietUntil = Date.now() + 2000;
  }

  _showBoard(kind, text, sub, ms) {
    this.board = { kind, text, sub, until: Date.now() + ms };
    this.emit("board", this.board);
    clearTimeout(this.boardTimer);
    this.boardTimer = setTimeout(() => this.hideBoard(), ms);
  }

  hideBoard() {
    clearTimeout(this.boardTimer);
    this.board = null;
    this.emit("board", null);
  }

  // ------------------------------------------------------------------ listening

  _ensureListener() {
    // one shared promise: two quick taps while the model loads must not create two listeners
    this.listenerReady ||= (async () => {
      this.yam = await loadYamnet();
      this.listener = new Listener({
        classify: this.yam.classify,
        labels: this.yam.labels,
        engine: this.engine,
        onPage: (p) => this._localAlert(p),
        onStatus: (s) => this.emit("sound", s),
        onFrame: (f) => this.emit("frame", f),
      });
      this.listener.setCustomSounds(this.customs);
      return this.listener;
    })();
    this.listenerReady.catch(() => (this.listenerReady = null));
    return this.listenerReady;
  }

  _setListen(state, message = "") {
    this.listen = { state, message, mic: this.mic?.label };
    this._sendStatus();
    this.changed();
  }

  async startListening({ auto = false } = {}) {
    if (this.mic || this.listen.state === "loading") return;
    if (!this.canListen) {
      this._setListen("unavailable", "This browser cannot use the microphone here.");
      return;
    }
    const wasTest = !!this.feedTimer;
    this._setListen("loading", "Getting ready. The sound recognition loads on this device.");
    try {
      await this._ensureListener();
      if (this.destroyed) return;
      const m = await startMic({ onAudio: (x) => this._feedMic(x), onEnded: () => this._micLost() });
      if (this.destroyed) {
        await m.stop();
        return;
      }
      this.mic = m;
      this.lastAudioAt = Date.now();
      this._stopFeedTimer();
      if (!this.settings.micOk) this.settings = store.saveSettings({ micOk: true });
      platform.keepScreenOn(!platform.listensInBackground);
      platform.backgroundListening(true);
      this._setListen("on");
      if (this.settings.captions) this._startCaptions();
    } catch (e) {
      this.mic = null;
      if (e?.name === "NeedsGesture") this._setListen("off", auto ? "" : e.message);
      else if (e?.name === "NotAllowedError" || e?.name === "SecurityError") {
        this.settings = store.saveSettings({ micOk: false });
        this._setListen("blocked", "The microphone is blocked. Allow it for HARK in your browser or phone settings, then try again.");
      } else if (e?.name === "NotFoundError" || e?.name === "OverconstrainedError") this._setListen("error", "No microphone was found on this device.");
      else this._setListen("error", `Could not start listening: ${e?.message || e}`);
      if (wasTest) this._startFeedTimer();
    }
  }

  async stopListening() {
    const m = this.mic;
    this.mic = null;
    await m?.stop();
    this.captions?.stop();
    this.captions = null;
    platform.keepScreenOn(false);
    platform.backgroundListening(false);
    this._setListen("off");
  }

  _micLost() {
    if (!this.mic) return;
    this.mic = null;
    this._setListen("error", "The microphone stopped. HARK is not listening.");
    setTimeout(() => this.listen.state === "error" && this.startListening({ auto: true }), 3000);
  }

  /** A microphone that delivers no audio (device asleep, taken by another app) is not listening. */
  _checkMic() {
    if (!this.mic || document.visibilityState === "hidden") return;
    if (Date.now() - this.lastAudioAt > 6000) {
      const m = this.mic;
      this.mic = null;
      m.stop().catch(() => {});
      this._setListen("off", "Listening paused while the device was asleep. Starting again…");
      this.startListening({ auto: true });
    }
  }

  _feedMic(x) {
    if (this.destroyed) return;
    this.lastAudioAt = Date.now();
    if (this.inject.length) {
      const extra = this._takeInjected(x.length);
      for (let i = 0; i < x.length; i++) x[i] += extra[i];
    }
    this.listener.push(x);
  }

  _takeInjected(n) {
    const out = new Float32Array(n);
    let o = 0;
    while (o < n && this.inject.length) {
      const c = this.inject[0];
      const take = Math.min(n - o, c.length);
      out.set(c.subarray(0, take), o);
      o += take;
      if (take === c.length) this.inject.shift();
      else this.inject[0] = c.subarray(take);
    }
    return out;
  }

  // Without a microphone, test audio is pushed in real time (100 ms per tick) followed by silence.
  _startFeedTimer() {
    if (this.feedTimer || this.mic) return;
    this.feedTimer = setInterval(() => {
      if (!this.listener) return;
      this.listener.push(this._takeInjected(1600));
      if (!this.inject.length && this.listener.t > this.testUntil + 15) this._stopFeedTimer();
    }, 100);
    if (this.listen.state !== "loading") this._setListen("test", "Playing a test sound into the detector.");
  }

  _stopFeedTimer() {
    clearInterval(this.feedTimer);
    this.feedTimer = null;
    if (!this.mic && !this.destroyed && this.listen.state === "test") this._setListen("off");
  }

  async _injectSamples(x) {
    if (this.destroyed) return;
    await this._ensureListener();
    if (this.destroyed) return;
    for (let i = 0; i < x.length; i += 1600) this.inject.push(x.subarray(i, i + 1600));
    this.testUntil = Math.max(this.testUntil, this.listener.t) + x.length / 16000 + 6;
    if (!this.mic) this._startFeedTimer();
  }

  async _loadTestSound(id) {
    const s = TEST_SOUNDS[id];
    if (s.make) return s.make();
    if (!this.soundCache.has(id)) {
      const r = await fetch(new URL(`../../${s.url}`, import.meta.url));
      if (!r.ok) throw new Error(`Could not load ${s.label}`);
      const { samples, sr } = decodeWav(new Uint8Array(await r.arrayBuffer()));
      this.soundCache.set(id, sr === 16000 ? samples : resample(samples, sr, 16000));
    }
    return this.soundCache.get(id).slice();
  }

  /** Try a sound: fed straight to the detector, or played out loud so microphones (this one and others) hear it. */
  async testSound(id) {
    if (!TEST_SOUNDS[id]) return;
    const x = await this._loadTestSound(id);
    if (this.settings.testMode === "air") {
      await this._ensureListener();
      if (this.mic) this.testUntil = this.listener.t + x.length / 16000 + 6;
      playSamples(x).catch(() => this.toast("Could not play the sound", "error"));
    } else {
      await this._injectSamples(x);
    }
    this.toast(`Test: ${TEST_SOUNDS[id].label}`);
  }

  // ------------------------------------------------------------------ captions and names

  _startCaptions() {
    if (!Captions.supported() || this.captions) return;
    this.captions = new Captions({
      onText: (text, final) => {
        const now = Date.now();
        if (!final && now - this.captionSentAt < 700) return;
        this.captionSentAt = now;
        this.lastCaption = { text, from: "this device", at: now, final };
        this.emit("caption", this.lastCaption);
        if (this.link.connected) this.link.send("caption", { text: text.slice(-300), final }).catch(() => {});
      },
      onName: (name) => this.listener?.heardName(name),
      onState: (s, detail) => {
        if (s === "error" || s === "blocked") this.toast(`Captions: ${detail}`, "error");
      },
    });
    this.captions.setNames(this.settings.names);
    this.captions.start();
  }

  // ------------------------------------------------------------------ settings and the home

  saveSettings(patch) {
    this.settings = store.saveSettings(patch);
    if (patch.enabled || patch.sensitivity) this.engine.setOptions({ enabled: patch.enabled, sensitivity: patch.sensitivity });
    if ("names" in patch) this.captions?.setNames(this.settings.names);
    if ("captions" in patch) {
      if (this.settings.captions && this.mic) this._startCaptions();
      if (!this.settings.captions && this.captions) {
        this.captions.stop();
        this.captions = null;
      }
    }
    if ("showAlerts" in patch || "vibrate" in patch) this._updateUrgent();
    if ("tone" in patch) this._sendStatus();
    this.changed();
    return this.settings;
  }

  setAlertEnabled(id, on) {
    this.saveSettings({ enabled: { ...this.settings.enabled, [id]: on } });
  }

  alertEnabled(id) {
    return this.engine.enabled[id] !== false;
  }

  renameDevice(name) {
    const n = String(name || "").trim().slice(0, 32);
    if (!n) return;
    this.device.name = n;
    this.deviceNamed = true;
    store.saveDevice({ name: n });
    this.link.setDevice({ name: n });
    this.changed();
  }

  /** Join another home (from its QR code, a link, or a typed code and address). */
  joinHome(code, hubAddress) {
    if (!CODE_RE.test(code || "")) throw new Error("A home code has 6 letters and numbers, like K7Q-4MX.");
    const url = hubAddress ? normalizeHubAddress(hubAddress) : null;
    if (hubAddress && !url) throw new Error("That address does not look right. It looks like 192.168.1.20:3000.");
    if (code !== this.home.code) {
      this.home = { code, joinedAt: Date.now() };
      store.saveHome(this.home);
      this.link.setCode(code);
    }
    if (url) this.link.addHub({ urls: [url] }, { explicit: true });
    this.link.probeNow();
    this.changed();
  }

  /** A fresh home code: this device leaves its home network. */
  newHome() {
    this.home = { code: newCode(), joinedAt: Date.now() };
    store.saveHome(this.home);
    this.link.setCode(this.home.code);
    this.changed();
  }

  addHubAddress(text) {
    const url = normalizeHubAddress(text);
    if (!url) throw new Error("That address does not look right. It looks like 192.168.1.20:3000.");
    this.link.addHub({ urls: [url] }, { explicit: true });
    this.link.probeNow();
    this.changed();
  }

  removeHub(key) {
    this.link.removeHub(key);
    this.changed();
  }

  /** The address other devices should use to reach a hub of this home (for the QR code). */
  shareUrl(base) {
    const hub = base || this.link?.shareableHubs()[0]?.urls[0] || null;
    return hub ? `${hub}#/join?h=${this.home.code}` : null;
  }

  // ------------------------------------------------------------------ teach a sound

  /** Record a few seconds of the sound to learn. @returns {Promise<Float32Array[]>} usable windows */
  async recordSample(seconds = 4, onTick = () => {}) {
    await this._ensureListener();
    if (!this.mic && !this.feedTimer) {
      await this.startListening();
      if (!this.mic) throw new Error(this.listen.message || "The microphone is needed to record a sound.");
    }
    this.teaching = true;
    try {
      this.listener.startRecording();
      for (let s = seconds; s > 0; s--) {
        onTick(s);
        await sleep(1000);
      }
      const x = this.listener.stopRecording();
      return windowsForTraining(x, { floorDb: this.listener.lastFrame?.floorDb ?? -70 });
    } finally {
      this.teaching = false;
      this.teachingUntil = Date.now() + 6000; // a detector may still be holding the sound for a few seconds
    }
  }

  /** Learn a sound from 3 recordings (lists of windows). */
  async trainSound({ label, priority = "normal", recs, sample = false }, onTick = () => {}) {
    await this._ensureListener();
    const groups = recs.map((ws) => ws.map((w) => embed(w, this.yam.classify(w))));
    const negatives = this.listener.background.slice();
    if (negatives.length < 6) {
      // learn what the room normally sounds like
      if (!this.mic) {
        this.testUntil = Math.max(this.testUntil, this.listener.t + 8);
        this._startFeedTimer();
      }
      this.listener.startRecording();
      for (let s = 5; s > 0; s--) {
        onTick(s);
        await sleep(1000);
      }
      const quiet = this.listener.stopRecording();
      for (let i = 0; i + 15600 <= quiet.length; i += 4000) {
        const w = quiet.slice(i, i + 15600);
        negatives.push(embed(w, this.yam.classify(w)));
      }
    }
    const model = trainCustom(groups, negatives);
    const item = { id: `c${Math.random().toString(36).slice(2, 8)}`, label, priority, model, sample: sample || undefined };
    this.customs.push(item);
    this._saveCustoms();
    return item;
  }

  deleteSound(id) {
    this.customs = this.customs.filter((c) => c.id !== id);
    this._saveCustoms();
  }

  _saveCustoms() {
    store.saveCustomSounds(this.customs.map((c) => ({ id: c.id, label: c.label, priority: c.priority, sample: c.sample, model: serializeModel(c.model) })));
    this.listener?.setCustomSounds(this.customs);
    this.changed();
  }

  async teachSampleChime() {
    if (this.customs.some((c) => c.sample)) return;
    const recs = [0, 1, 2].map((v) => windowsForTraining(sampleChime(v)));
    return this.trainSound({ label: "Front door", priority: "normal", recs, sample: true });
  }

  async ringSampleChime() {
    if (!this.customs.some((c) => c.sample)) await this.teachSampleChime(); // first time: learn it, then ring
    await this._injectSamples(sampleChime(3)); // a 4th ring the model has never heard
    this.toast("Ding-dong (sample doorbell)");
  }

  /** A short buzz, to check that this device vibrates (the tap that starts it also unlocks vibration in browsers). */
  testVibration() {
    const ok = platform.vibrate([200, 100, 200, 100, 400]);
    this.changed();
    return ok;
  }

  // ------------------------------------------------------------------ hooks for the automated tests

  async injectTest(id) {
    await this._injectSamples(await this._loadTestSound(id));
  }

  injectTone(freq, seconds = 2) {
    return this._injectSamples(tone(freq, seconds));
  }

  trainFromTones(label, freq) {
    const recs = [0, 1, 2].map(() => windowsForTraining(tone(freq, 2.5, 16000, { onOff: [0.3, 0.2] })));
    return this.trainSound({ label, priority: "normal", recs });
  }

  // ------------------------------------------------------------------ shutdown

  async destroy() {
    this.destroyed = true;
    clearInterval(this.statusTimer);
    clearInterval(this.feedTimer);
    clearInterval(this.urgentTimer);
    clearTimeout(this.boardTimer);
    this.captions?.stop();
    await this.mic?.stop();
    this.link?.stop();
  }
}

export function joinNames(names) {
  if (names.length <= 1) return names[0] || "";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

export { ALERTS, TEST_SOUNDS };
