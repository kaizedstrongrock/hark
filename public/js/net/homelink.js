// The home network link.
// Every device listens and alerts on its own. When it can reach one of its home's hubs (a computer on the
// home Wi-Fi running the HARK hub), it joins the home listening network automatically: whatever any
// device hears then reaches every device.
//
// - The device knows a list of hubs ({id, urls}), learned when pairing, from the hub that served the app,
//   and from the other devices (hubs gossip their addresses). It connects to *every* reachable hub of its
//   home, so devices that happen to use different hubs (two computers at home) still hear each other.
// - Messages carry ids made by the sender, so a message that arrives through two hubs is shown once.
// - Hubs are probed in the background, faster when the device is not connected and right after a network
//   change, so coming home needs no action. A link that has been silent for WATCHDOG_MS counts as gone.
// Browser-agnostic: fetch, EventSource and timers are injectable (unit tests use fakes).
import { HUB_ID_RE, PROTOCOL, isLoopbackUrl } from "../core/protocol.js";

export const WATCHDOG_MS = 25000;
export const PROBE_TIMEOUT_MS = 3000;
const STREAM_TYPES = ["welcome", "presence", "alert", "ack", "reply", "caption", "status", "hubs", "ping", "refused"];
const RELAYED = new Set(["alert", "ack", "reply", "caption", "status", "hubs"]);
const STORED = new Set(["alert", "ack", "reply"]);
const MAX_HUBS = 8;
const MAX_URLS = 6;

let seq = 0;

export class HomeLink {
  /**
   * @param {{code: string, device: {id: string, name: string, kind: string}, hubs?: object[], cursors?: Record<string, number>,
   *          onMessage?: (type: string, msg: object, info: {replay: boolean, age: number, firstSync: boolean, hubId: string}) => void,
   *          onChange?: () => void, onHubs?: (hubs: object[]) => void, onCursor?: (key: string, ts: number) => void,
   *          onConnect?: (hubId: string) => void, onReplayDone?: (hubId: string) => void,
   *          forgotten?: string[], onForgotten?: (ids: string[]) => void,
   *          fetch?: typeof fetch, EventSource?: any, setTimeout?: typeof setTimeout, clearTimeout?: typeof clearTimeout, now?: () => number}} opts
   *   onReplayDone: called after the messages a hub replays on (re)connection have all been delivered.
   *   forgotten: ids of hubs the person removed; they are not re-learned from other devices.
   */
  constructor(opts) {
    this.code = opts.code;
    this.device = { ...opts.device };
    this.onMessage = opts.onMessage || (() => {});
    this.onChange = opts.onChange || (() => {});
    this.onHubs = opts.onHubs || (() => {});
    this.onCursor = opts.onCursor || (() => {});
    this.onConnect = opts.onConnect || (() => {});
    this.onReplayDone = opts.onReplayDone || (() => {});
    this.onForgotten = opts.onForgotten || (() => {});
    this.forgotten = new Set((opts.forgotten || []).filter((id) => HUB_ID_RE.test(id)));
    /** Messages kept for a while, so that a Wi-Fi blip or a hub restart does not lose them: [{type, payload, mid, until, sentTo}] */
    this.outbox = [];
    this.fetch = opts.fetch || globalThis.fetch?.bind(globalThis);
    this.ES = opts.EventSource || globalThis.EventSource;
    this.setTimeout = opts.setTimeout || globalThis.setTimeout.bind(globalThis);
    this.clearTimeout = opts.clearTimeout || globalThis.clearTimeout.bind(globalThis);
    this.now = opts.now || (() => Date.now());
    this.cursors = { ...(opts.cursors || {}) };
    /** @type {{key: string, id: string|null, urls: string[], name?: string, local?: boolean, blockedUntil?: number}[]} */
    this.hubs = [];
    /** @type {Map<string, {hub: object, url: string, es: any, open: boolean, members: object[], lastEventAt: number, registry: object[]}>} */
    this.conns = new Map();
    this.seenIds = new Set();
    this.seenOrder = [];
    this.timer = null;
    this.running = false;
    this.forceProbe = true;
    this.lastProbeAt = -Infinity;
    this.disconnectedSince = this.now();
    this.probing = new Set();
    for (const h of opts.hubs || []) this.addHub(h, { silent: true, local: !!h.local });
  }

  // ------------------------------------------------------------------ known hubs

  /**
   * Learn a hub. `hub.id` may be null for an address someone typed in (the id is filled in by the first probe).
   * @returns {object} the hub entry
   */
  addHub(hub, { local = false, silent = false, fresh = false, explicit = false } = {}) {
    const urls = (hub.urls || []).filter((u) => typeof u === "string" && /^https?:\/\//.test(u));
    if (!urls.length) return null;
    const id = hub.id && HUB_ID_RE.test(hub.id) ? hub.id : null;
    if (id && this.forgotten.has(id)) {
      if (!explicit && !local) return null; // the person removed it: other devices mentioning it do not bring it back
      this.forgotten.delete(id);
      this.onForgotten([...this.forgotten]);
    }
    let entry = id ? this.hubs.find((h) => h.id === id) : null;
    entry ||= this.hubs.find((h) => !h.id && h.urls.some((u) => urls.includes(u)));
    if (!entry && !id) entry = this.hubs.find((h) => h.urls.some((u) => urls.includes(u))) || null;
    if (entry) {
      const before = entry.urls.join() + entry.id + entry.name + !!entry.local;
      entry.id ||= id;
      entry.key = entry.id || entry.key;
      // Addresses straight from the hub itself go first, gossip goes last. The address a page was loaded from
      // (its own hub) always stays first: it is the one that is sure to work from here.
      let merged;
      if (local) merged = [...urls, ...entry.urls];
      else if (fresh) merged = entry.local ? [entry.urls[0], ...urls, ...entry.urls.slice(1)] : [...urls, ...entry.urls];
      else merged = [...entry.urls, ...urls];
      entry.urls = [...new Set(merged)].slice(0, MAX_URLS);
      entry.name = hub.name || entry.name;
      entry.local ||= local;
      if (!silent && before !== entry.urls.join() + entry.id + entry.name + !!entry.local) this._hubsChanged();
      return entry;
    }
    if (this.hubs.length >= MAX_HUBS) {
      const drop = this.hubs.findIndex((h) => !h.local && !this.conns.has(h.id));
      if (drop === -1) return null;
      this.hubs.splice(drop, 1);
    }
    entry = { key: id || `addr:${urls[0]}`, id, urls: urls.slice(0, MAX_URLS), name: hub.name, local, explicit };
    if (local) this.hubs.unshift(entry);
    else this.hubs.push(entry);
    if (!silent) {
      this._hubsChanged();
      if (this.running) this.probeNow();
    }
    return entry;
  }

  removeHub(key) {
    const entry = this.hubs.find((h) => h.key === key || h.id === key);
    if (!entry || entry.local) return false;
    this.hubs = this.hubs.filter((h) => h !== entry);
    if (entry.id) {
      this._drop(entry.id, false);
      this.forgotten.add(entry.id);
      this.onForgotten([...this.forgotten]);
    }
    this._hubsChanged();
    return true;
  }

  _hubsChanged() {
    this.onHubs(this.knownHubs());
    this.onChange();
  }

  /** Hubs to remember (local storage). */
  knownHubs() {
    return this.hubs.map((h) => ({ id: h.id, urls: h.urls.slice(), name: h.name, local: h.local || undefined }));
  }

  /** Hub addresses other devices can use (never loopback: "localhost" is a different machine for them). */
  shareableHubs() {
    return this.hubs
      .filter((h) => h.id)
      .map((h) => ({ id: h.id, name: h.name, urls: h.urls.filter((u) => !isLoopbackUrl(u)).slice(0, 4) }))
      .filter((h) => h.urls.length)
      .slice(0, MAX_HUBS);
  }

  // ------------------------------------------------------------------ lifecycle

  start() {
    if (this.running) return;
    this.running = true;
    this.forceProbe = true;
    this._schedule(0);
  }

  stop() {
    this.running = false;
    this.clearTimeout(this.timer);
    this.timer = null;
    for (const id of [...this.conns.keys()]) this._drop(id, false);
    this.onChange();
  }

  /** Probe right away (the network changed, the app came back to the foreground, ...). */
  probeNow() {
    if (!this.running) return;
    this.forceProbe = true;
    this._schedule(0);
  }

  /** New name for this device: reconnect so every hub shows it. */
  setDevice(patch) {
    Object.assign(this.device, patch);
    this._reconnectAll();
  }

  /** Switch to another home. */
  setCode(code) {
    if (code === this.code) return;
    this.code = code;
    this.seenIds.clear();
    this.seenOrder = [];
    this._reconnectAll();
  }

  _reconnectAll() {
    for (const id of [...this.conns.keys()]) this._drop(id, false);
    this.onChange();
    this.probeNow();
  }

  _schedule(ms) {
    this.clearTimeout(this.timer);
    this.timer = this.setTimeout(() => this._tick(), ms);
  }

  /** How often to look for hubs that are not connected. */
  _probeEvery(now) {
    if (this.conns.size) return 30000;
    // not connected: look often at first (coming home should feel instant), then settle down to save battery
    return now - (this.disconnectedSince ?? now) < 5 * 60000 ? 8000 : 20000;
  }

  async _tick() {
    this.timer = null;
    if (!this.running) return;
    const now = this.now();
    for (const [id, c] of this.conns) {
      if (now - c.lastEventAt > WATCHDOG_MS) this._drop(id, false); // silently dead (left the Wi-Fi, hub asleep)
    }
    if (this.forceProbe || now - this.lastProbeAt >= this._probeEvery(now)) {
      this.forceProbe = false;
      this.lastProbeAt = now;
      const todo = this.hubs.filter((h) => !(h.id && this.conns.has(h.id)) && !this.probing.has(h.key) && !(h.blockedUntil > now));
      await Promise.all(todo.map((h) => this._probe(h)));
      if (!this.running) return;
    }
    // wake up every 5 s for the watchdog, or sooner when the next probe is due
    const t = this.now();
    const nextProbe = Math.max(0, this.lastProbeAt + this._probeEvery(t) - t);
    if (!this.timer) this._schedule(Math.min(5000, nextProbe || 5000));
  }

  async _probe(entry) {
    const key = entry.key;
    this.probing.add(key);
    try {
      for (const url of entry.urls.slice()) {
        const status = await this._status(url);
        if (!this.hubs.includes(entry)) return false; // forgotten while we were asking
        if (!status) continue;
        if (entry.id && status.hubId !== entry.id) continue; // another hub now answers at this address
        if (!entry.id && this.forgotten.has(status.hubId) && !entry.explicit) return false;
        if (!entry.id) {
          // an address someone typed in: adopt the hub's id (merging with an entry we already had for it)
          if (this.forgotten.has(status.hubId)) {
            this.forgotten.delete(status.hubId); // typed in again by hand: remember it again
            this.onForgotten([...this.forgotten]);
          }
          const twin = this.hubs.find((h) => h !== entry && h.id === status.hubId);
          if (twin) {
            twin.urls = [...new Set([...twin.urls, ...entry.urls])].slice(0, MAX_URLS);
            this.hubs = this.hubs.filter((h) => h !== entry);
            entry = twin;
          } else {
            entry.id = status.hubId;
            entry.key = status.hubId;
          }
          entry.name ||= status.name;
          this._hubsChanged();
        }
        if (status.name && status.name !== entry.name) {
          entry.name = status.name;
          this._hubsChanged();
        }
        // remember the hub's home-network addresses so other devices can be told about them
        if (Array.isArray(status.lan)) this.addHub({ id: entry.id, urls: status.lan.filter((u) => typeof u === "string") }, { fresh: true });
        if (!this.conns.has(entry.id) && this.running) this._connect(entry, url);
        return true;
      }
      return false;
    } finally {
      this.probing.delete(key);
    }
  }

  async _status(url) {
    if (!this.fetch) return null;
    const ctrl = typeof AbortController !== "undefined" ? new AbortController() : null;
    const t = this.setTimeout(() => ctrl?.abort(), PROBE_TIMEOUT_MS);
    try {
      const r = await this.fetch(`${url}api/status`, { cache: "no-store", signal: ctrl?.signal });
      if (!r.ok) return null;
      const s = await r.json();
      if (!s || s.app !== "hark" || s.protocol !== PROTOCOL || typeof s.hubId !== "string" || !HUB_ID_RE.test(s.hubId)) return null;
      return s;
    } catch {
      return null;
    } finally {
      this.clearTimeout(t);
    }
  }

  _cursorKey(hubId) {
    return `${hubId}|${this.code}`;
  }

  _connect(entry, url) {
    if (!this.ES) return;
    const q = new URLSearchParams({ h: this.code, id: this.device.id, name: this.device.name, kind: this.device.kind });
    const es = new this.ES(`${url}api/stream?${q}`);
    const conn = { hub: entry, url, es, open: false, members: [], lastEventAt: this.now(), registry: [] };
    this.conns.set(entry.id, conn);
    const mine = () => this.conns.get(entry.id) === conn;
    es.onerror = () => {
      if (!mine()) return;
      // take over from EventSource's own retry loop: re-probe on our schedule instead
      this._drop(entry.id, true);
    };
    for (const type of STREAM_TYPES) {
      es.addEventListener(type, (e) => {
        if (!mine()) return;
        let data;
        try {
          data = JSON.parse(e.data);
        } catch {
          return;
        }
        conn.lastEventAt = this.now();
        this._event(conn, type, data);
      });
    }
  }

  _drop(hubId, retry) {
    const c = this.conns.get(hubId);
    if (!c) return;
    this.conns.delete(hubId);
    try {
      c.es.close();
    } catch {
      /* already closed */
    }
    if (!this.conns.size) this.disconnectedSince = this.now();
    if (c.open) this.onChange();
    if (retry && this.running) {
      this.forceProbe = true;
      this._schedule(2000);
    }
  }

  _remember(id) {
    if (this.seenIds.has(id)) return false;
    this.seenIds.add(id);
    this.seenOrder.push(id);
    if (this.seenOrder.length > 1000) this.seenIds.delete(this.seenOrder.shift());
    return true;
  }

  _advance(conn, ts) {
    const key = this._cursorKey(conn.hub.id);
    if (typeof ts === "number" && ts > (this.cursors[key] ?? -Infinity)) {
      this.cursors[key] = ts;
      this.onCursor(key, ts);
    }
  }

  _event(conn, type, data) {
    if (type === "ping") return;
    if (type === "refused") {
      conn.hub.blockedUntil = this.now() + 60000;
      this._drop(conn.hub.id, false);
      return;
    }
    if (type === "welcome") {
      conn.open = true;
      this.disconnectedSince = null;
      conn.members = (data.members || []).filter((m) => m.id !== this.device.id);
      this._learnHubs(conn, data.hubs);
      // Replay what this device missed while it was away (or asleep, or had a Wi-Fi blip). "First sync" means
      // this device has never been connected to this home through *any* hub: then old alerts are just history.
      const key = this._cursorKey(conn.hub.id);
      const cursor = this.cursors[key];
      const firstSync = !Object.keys(this.cursors).some((k) => k.endsWith(`|${this.code}`));
      const hubNow = typeof data.now === "number" ? data.now : this.now();
      for (const m of data.history || []) {
        if (!m || !m.id || !STORED.has(m.type) || m.from?.id === this.device.id) continue;
        if (cursor !== undefined && m.ts <= cursor) {
          this._remember(m.id); // already handled before: just make sure a twin from another hub is dropped
          continue;
        }
        if (!this._remember(m.id)) continue;
        this.onMessage(m.type, m, { replay: true, age: Math.max(0, (hubNow - m.ts) / 1000), firstSync, hubId: conn.hub.id });
      }
      this._advance(conn, hubNow);
      this.onReplayDone(conn.hub.id);
      this.onChange();
      this.onConnect(conn.hub.id);
      this._flushOutbox(conn);
      this._announceHubs(conn);
      return;
    }
    if (type === "presence") {
      conn.members = (data.members || []).filter((m) => m.id !== this.device.id);
      this.onChange();
      return;
    }
    if (!RELAYED.has(type) || !data || !data.id) return;
    if (STORED.has(type)) this._advance(conn, data.ts);
    if (!this._remember(data.id)) return; // arrived through another hub already
    if (type === "hubs") {
      this._learnHubs(conn, data.payload?.hubs);
      return;
    }
    this.onMessage(type, data, { replay: false, age: 0, firstSync: false, hubId: conn.hub.id });
  }

  _learnHubs(conn, list) {
    if (!Array.isArray(list)) return;
    conn.registry = list;
    let added = false;
    for (const h of list) {
      if (!h || !HUB_ID_RE.test(h.id || "") || !Array.isArray(h.urls)) continue;
      const known = this.hubs.find((x) => x.id === h.id);
      const before = known ? known.urls.join() : null;
      const entry = this.addHub({ id: h.id, urls: h.urls, name: h.name }, { silent: true });
      if (entry && (!known || before !== entry.urls.join())) added = true;
    }
    if (added) {
      this._hubsChanged();
      this.probeNow();
    }
  }

  /** Tell a hub about the other hubs this device knows, so every device of the home can find all of them. */
  _announceHubs(conn) {
    const known = new Map((conn.registry || []).map((h) => [h.id, new Set(h.urls || [])]));
    const share = this.shareableHubs().filter((h) => !known.has(h.id) || h.urls.some((u) => !known.get(h.id).has(u)));
    if (share.length) this._post(conn, "hubs", { hubs: share }).catch(() => {});
  }

  // ------------------------------------------------------------------ sending

  newId() {
    seq = (seq + 1) % 1679616;
    return `${this.device.id}.${this.now().toString(36)}.${seq.toString(36)}`;
  }

  async _post(conn, type, payload, mid = this.newId()) {
    try {
      const r = await this.fetch(`${conn.url}api/send`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ h: this.code, id: this.device.id, name: this.device.name, kind: this.device.kind, mid, type, payload }),
      });
      const body = await r.json().catch(() => ({}));
      return r.ok ? { ok: true, ...body } : { ok: false, error: body.error || `HTTP ${r.status}` };
    } catch {
      return { ok: false, error: "offline" };
    }
  }

  /**
   * Send a message to every device of the home, through every connected hub (receivers drop the twins).
   * @param {{mid?: string, keepFor?: number}} [opts] keepFor: also keep the message for this many ms and deliver
   *   it to every hub that (re)connects meanwhile (a Wi-Fi blip, a hub restart, a hub not reachable right now).
   * @returns {Promise<{ok: boolean, mid: string, hubs: number, recipients: number, queued?: boolean, error?: string}>}
   */
  async send(type, payload, { mid = this.newId(), keepFor = 0 } = {}) {
    this._remember(mid);
    const item = keepFor > 0 ? { type, payload, mid, until: this.now() + keepFor, sentTo: new Set() } : null;
    if (item) {
      this.outbox.push(item);
      if (this.outbox.length > 50) this.outbox.shift();
    }
    const conns = [...this.conns.values()].filter((c) => c.open);
    if (!conns.length) return { ok: false, mid, hubs: 0, recipients: 0, queued: !!item, error: "not connected" };
    const recipients = this.members().length;
    const results = await Promise.all(
      conns.map(async (c) => {
        const r = await this._post(c, type, payload, mid);
        if (r.ok) item?.sentTo.add(c.hub.id);
        return r;
      }),
    );
    const ok = results.some((r) => r.ok);
    return { ok, mid, hubs: results.filter((r) => r.ok).length, recipients: ok ? recipients : 0, queued: !!item, error: ok ? undefined : results[0]?.error };
  }

  /** Deliver kept messages that this hub has not had yet (the hub and the receivers drop repeats by id). */
  _flushOutbox(conn) {
    const now = this.now();
    this.outbox = this.outbox.filter((m) => m.until > now);
    for (const m of this.outbox) {
      if (m.sentTo.has(conn.hub.id)) continue;
      this._post(conn, m.type, m.payload, m.mid).then((r) => r.ok && m.sentTo.add(conn.hub.id));
    }
  }

  // ------------------------------------------------------------------ state

  /** Other devices of the home connected right now (through any hub). */
  members() {
    const out = new Map();
    for (const c of this.conns.values()) if (c.open) for (const m of c.members) out.set(m.id, m);
    return [...out.values()];
  }

  get connectedHubs() {
    return [...this.conns.values()].filter((c) => c.open).map((c) => ({ id: c.hub.id, url: c.url, name: c.hub.name, local: !!c.hub.local }));
  }

  get connected() {
    return this.connectedHubs.length > 0;
  }
}
