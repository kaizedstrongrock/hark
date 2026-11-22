// In-memory message relay for one home hub. Every device of a home (phones, tablets, computers) is an
// equal member: each one listens and alerts, and whatever one device hears is relayed to all the others.
// Nothing is persisted and no audio ever reaches the hub - only small alert messages.

export const MESSAGE_TYPES = ["alert", "ack", "reply", "caption", "status", "hubs"];

/** Kept for devices that reconnect after a Wi-Fi blip or come back home (see the app's alert center). */
const STORED = new Set(["alert", "ack", "reply"]);
const HISTORY_MAX_AGE_MS = 24 * 3600 * 1000;
const REMEMBERED_IDS = 300;

export class Relay {
  /**
   * @param {{historySize?: number, now?: () => number, maxClientsPerHome?: number, maxHomes?: number,
   *          maxHubsPerHome?: number, selfHub?: () => ({id: string, urls: string[], name?: string})}} [opts]
   *   selfHub describes this hub, so devices learn how to reach it from the rest of the home network.
   */
  constructor(opts = {}) {
    this.historySize = opts.historySize ?? 100;
    this.now = opts.now ?? Date.now;
    this.maxClients = opts.maxClientsPerHome ?? 32;
    this.maxHomes = opts.maxHomes ?? 500;
    this.maxHubs = opts.maxHubsPerHome ?? 8;
    this.selfHub = opts.selfHub ?? null;
    /** @type {Map<string, {clients: Map<string, object>, history: object[], ids: Map<string, object>, hubs: Map<string, object>, seq: number, touched: number}>} */
    this.homes = new Map();
  }

  _home(code, create = true) {
    let h = this.homes.get(code);
    if (!h && create) {
      if (this.homes.size >= this.maxHomes) this._evict();
      h = { clients: new Map(), history: [], ids: new Map(), hubs: new Map(), seq: 0, touched: this.now() };
      this.homes.set(code, h);
    }
    if (h) h.touched = this.now();
    return h;
  }

  /** Make room for a new home: drop the least recently used home that has no connected device. */
  _evict() {
    let victim = null;
    for (const [code, h] of this.homes) {
      if (h.clients.size) continue;
      if (!victim || h.touched < victim[1].touched) victim = [code, h];
    }
    if (!victim) throw new RelayError(503, "This hub is full");
    this.homes.delete(victim[0]);
  }

  /** Whether a device may connect (a reconnecting device always may: it replaces its old connection). */
  admit(code, deviceId) {
    const h = this.homes.get(code);
    return !h || h.clients.has(deviceId) || h.clients.size < this.maxClients;
  }

  /**
   * Attach a device. `client.send(event, data)` delivers one server-sent event.
   * @returns {() => void} detach function
   */
  join(code, client) {
    if (!this.admit(code, client.id)) throw new RelayError(429, "Too many devices in this home");
    const h = this._home(code);
    const previous = h.clients.get(client.id);
    if (previous && previous !== client) previous.close?.();
    h.clients.set(client.id, client);
    client.send("welcome", { you: client.id, now: this.now(), members: this.members(code), history: this.history(code), hubs: this.hubs(code) });
    this._presence(code);
    return () => {
      const cur = h.clients.get(client.id);
      if (cur === client) {
        h.clients.delete(client.id);
        h.touched = this.now();
        this._presence(code);
        if (!h.clients.size && !h.history.length && !h.hubs.size) this.homes.delete(code);
      }
    };
  }

  members(code) {
    const h = this.homes.get(code);
    if (!h) return [];
    return [...h.clients.values()].map((c) => ({ id: c.id, name: c.name, kind: c.kind }));
  }

  /** Recent stored messages (newest last), at most a day old. */
  history(code) {
    const h = this.homes.get(code);
    if (!h) return [];
    const cutoff = this.now() - HISTORY_MAX_AGE_MS;
    return h.history.filter((m) => m.ts >= cutoff).slice(-this.historySize);
  }

  /** Every hub this home's devices know about, this hub first. */
  hubs(code) {
    const self = this.selfHub?.();
    const list = self && self.urls?.length ? [{ id: self.id, urls: self.urls.slice(0, 4), name: self.name }] : [];
    for (const hub of this.homes.get(code)?.hubs.values() || []) {
      if (hub.id !== self?.id) list.push({ id: hub.id, urls: hub.urls.slice(), name: hub.name });
    }
    return list;
  }

  _presence(code) {
    const h = this.homes.get(code);
    if (!h) return;
    const members = this.members(code);
    for (const c of h.clients.values()) c.send("presence", { members });
  }

  /** Merge hub addresses reported by a device. @returns {boolean} whether anything changed */
  _mergeHubs(h, hubs) {
    const selfId = this.selfHub?.()?.id;
    let changed = false;
    for (const hub of hubs) {
      if (hub.id === selfId) continue;
      const known = h.hubs.get(hub.id);
      if (known) {
        const urls = [...new Set([...hub.urls, ...known.urls])].slice(0, 4);
        if (urls.join() !== known.urls.join() || (hub.name && hub.name !== known.name)) changed = true;
        known.urls = urls;
        known.name = hub.name || known.name;
        known.seenAt = this.now();
        continue;
      }
      if (h.hubs.size >= this.maxHubs) {
        const oldest = [...h.hubs.values()].sort((a, b) => a.seenAt - b.seenAt)[0];
        h.hubs.delete(oldest.id);
      }
      h.hubs.set(hub.id, { id: hub.id, urls: hub.urls.slice(0, 4), name: hub.name, seenAt: this.now() });
      changed = true;
    }
    return changed;
  }

  /**
   * Relay a message to every other device of the home.
   * @param {string} [mid] sender-generated message id; a message id seen before is not relayed again
   * @returns {{id: string, ts: number, type: string, from: object, payload: object, delivered: number, duplicate?: boolean}}
   */
  publish(code, from, type, payload, mid) {
    if (!MESSAGE_TYPES.includes(type)) throw new RelayError(400, `Unknown message type: ${type}`);
    const h = this._home(code);
    if (mid && h.ids.has(mid)) return { ...h.ids.get(mid), delivered: 0, duplicate: true };
    h.seq += 1;
    const id = mid || `${this.now().toString(36)}-${h.seq}`;
    let body = payload;
    if (type === "hubs") {
      const changed = this._mergeHubs(h, payload.hubs || []);
      body = { hubs: this.hubs(code) };
      if (!changed) return { id, ts: this.now(), type, from, payload: body, delivered: 0 };
    }
    const msg = { id, ts: this.now(), type, from: { id: from.id, name: from.name, kind: from.kind }, payload: body };
    // Repeats of an alarm that is still sounding are only needed live (the next one comes within 30 s): keeping
    // them would push doorbells and acknowledgements out of the history before returning devices see them.
    if (STORED.has(type) && !(type === "alert" && body.repeat)) {
      h.history.push(msg);
      if (h.history.length > this.historySize) h.history.splice(0, h.history.length - this.historySize);
    }
    h.ids.set(id, msg);
    if (h.ids.size > REMEMBERED_IDS) h.ids.delete(h.ids.keys().next().value);
    let delivered = 0;
    for (const c of h.clients.values()) {
      if (c.id === from.id) continue;
      c.send(type, msg);
      delivered++;
    }
    return { ...msg, delivered };
  }

  /** Total connected devices (for /api/status). */
  get clientCount() {
    let n = 0;
    for (const h of this.homes.values()) n += h.clients.size;
    return n;
  }
}

export class RelayError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
