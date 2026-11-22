// The alert center: everything this device shows, from its own microphone and from every other device
// of the home network, merged so that one sound is one alert even when several devices hear it.
// Pure module (no DOM, no network): unit-tested.
//
// Rules
// - Same kind of sound within MERGE_SECONDS of each other = the same event ("also heard by the tablet").
// - "I've seen it" on any device acknowledges that event everywhere, plus older unacknowledged events of
//   the same kind. A device reporting the same sound within the merge window joins the acknowledged event
//   quietly; a later or fresh report is a new event and alerts (a second knock, a second alarm).
// - Alerts that happened while this device was away from home (replayed by a hub when it reconnects) are
//   "missed" if older than LIVE_SECONDS: shown as missed, never as a new alarm.

export const MERGE_SECONDS = 30;
export const REPEAT_MERGE_SECONDS = 75;
export const LIVE_SECONDS = 120;
export const MAX_EVENTS = 100;

let counter = 0;

export class AlertCenter {
  /**
   * @param {{now?: () => number, selfId?: string, events?: object[]}} [opts]
   *   events: previously saved events (see toJSON) so history survives a restart
   */
  constructor({ now = () => Date.now(), selfId = "", events = [] } = {}) {
    this.now = now;
    this.selfId = selfId;
    this.events = events.filter((e) => e && e.kind && Array.isArray(e.ids)).map((e) => ({ replies: [], heardBy: [], ...e }));
    this.seen = new Set(this.events.flatMap((e) => e.ids));
  }

  /** The event that contains an alert id. */
  byId(id) {
    return this.events.find((e) => e.ids.includes(id)) || null;
  }

  byKey(key) {
    return this.events.find((e) => e.key === key) || null;
  }

  _find(kind, at, windowSeconds) {
    for (let i = this.events.length - 1; i >= 0; i--) {
      const e = this.events[i];
      if (e.kind === kind && Math.abs(at - e.lastAt) <= windowSeconds * 1000) return e;
    }
    return null;
  }

  /**
   * Add an alert message ({id, from: {id, name, kind}, payload: {kind, label, priority, ...}}).
   * @param {{age?: number, firstSync?: boolean}} [opts]
   *   age: seconds since the alert was raised (hub history replays); firstSync: this device has never been
   *   connected to the hub before, so old alerts are history, not something it missed.
   * @returns {{action: 'new'|'merged'|'repeat'|'quiet'|'missed'|'history'|'duplicate'|'invalid', event?: object}}
   *   new: alert the user. merged: another device heard the same thing (update the display, no new alarm).
   *   repeat: still sounding and not acknowledged. quiet: already acknowledged. missed / history: not live.
   */
  add(msg, { age = 0, firstSync = false } = {}) {
    const p = msg?.payload;
    if (!msg?.id || !p || typeof p.kind !== "string" || !p.label) return { action: "invalid" };
    if (this.seen.has(msg.id)) return { action: "duplicate", event: this.byId(msg.id) };
    this.seen.add(msg.id);
    const at = this.now() - Math.max(0, age) * 1000;
    const live = this.now() - at <= LIVE_SECONDS * 1000;
    const from = msg.from && msg.from.id ? { id: msg.from.id, name: msg.from.name || "Another device", kind: msg.from.kind } : { id: this.selfId, name: "This device" };
    // Urgent repeats come every ~30 s while an alarm keeps sounding: give them a wider window.
    let existing = this._find(p.kind, at, p.repeat ? REPEAT_MERGE_SECONDS : MERGE_SECONDS);
    // A device that already reported this event reporting it again *fresh* (not as a repeat) means its own
    // detector heard the sound stop and start again: after an acknowledgement, that is a new event.
    if (existing?.acked && !p.repeat && existing.heardBy.some((d) => d.id === from.id)) existing = null;
    if (existing) {
      existing.ids.push(msg.id);
      if (!existing.heardBy.some((d) => d.id === from.id)) existing.heardBy.push(from);
      existing.lastAt = Math.max(existing.lastAt, at);
      existing.confidence = Math.max(existing.confidence || 0, p.confidence || 0);
      existing.detail ||= p.detail;
      existing.advice ||= p.advice;
      if (!p.test) existing.test = false; // one real detection makes the event real
      if (existing.acked) return { action: "quiet", event: existing };
      if (existing.missed || existing.history) {
        if (!live) return { action: "quiet", event: existing };
        // it happened while this device was away and it is *still* happening: alert now
        existing.missed = false;
        existing.history = false;
        return { action: "new", event: existing };
      }
      return { action: p.repeat ? "repeat" : "merged", event: existing };
    }
    const event = {
      key: `e${at.toString(36)}${(counter++).toString(36)}`,
      kind: p.kind,
      label: p.label,
      priority: p.priority === "urgent" || p.priority === "info" ? p.priority : "normal",
      at,
      lastAt: at,
      heardBy: [from],
      ids: [msg.id],
      confidence: p.confidence || 0,
      detail: p.detail,
      advice: p.advice,
      vibrate: p.vibrate,
      test: !!p.test,
      custom: !!p.custom,
      acked: null,
      missed: false,
      history: false,
      replies: [],
    };
    let action = "new";
    if (!live) {
      event[firstSync ? "history" : "missed"] = true;
      action = firstSync ? "history" : "missed";
    }
    this.events.push(event);
    this._trim();
    return { action, event };
  }

  _trim() {
    while (this.events.length > MAX_EVENTS) {
      const i = this.events.findIndex((e) => !(e.priority === "urgent" && !e.acked && !e.missed && !e.history));
      this.events.splice(i === -1 ? 0 : i, 1);
    }
  }

  /** Mark one event, and older open events of the same kind, as seen by `by` at time `at`. */
  _ackKind(kind, at, by, alsoKey) {
    const changed = [];
    for (const e of this.events) {
      if (e.kind !== kind || e.acked) continue;
      if (e.key === alsoKey || e.at <= at + 1000) {
        e.acked = { by, at };
        e.missed = false;
        changed.push(e);
      }
    }
    return changed;
  }

  /**
   * The user pressed "I've seen it" on this device.
   * @returns {{event: object, alertId: string, kind: string} | null} what to tell the other devices
   */
  acknowledge(key, by = { id: this.selfId, name: "This device" }) {
    const e = this.byKey(key);
    if (!e) return null;
    const at = this.now();
    this._ackKind(e.kind, at, by, e.key);
    e.missed = false;
    return { event: e, alertId: e.ids[e.ids.length - 1], kind: e.kind };
  }

  /**
   * Another device acknowledged. It covers the event it names and older open events of the same kind, never one
   * that started after it (an acknowledgement delivered late, after a reconnect, must not hide a newer alarm).
   * @returns {object[]} the events that changed
   */
  remoteAck({ alertId, kind }, by, { age = 0 } = {}) {
    const at = this.now() - Math.max(0, age) * 1000;
    const target = alertId ? this.byId(alertId) : null;
    return this._ackKind(kind || target?.kind, target ? Math.min(at, target.lastAt) : at, by, target?.key);
  }

  /** A reply typed on one device, shown on the devices that heard the event. */
  addReply(alertId, reply) {
    const e = alertId ? this.byId(alertId) : null;
    if (e && !e.replies.some((r) => r.id === reply.id)) e.replies.push(reply);
    return e;
  }

  /** Events that need the user now: not acknowledged, not missed, not quiet info. Urgent first, then newest. */
  open() {
    return this.events
      .filter((e) => !e.acked && !e.missed && !e.history && e.priority !== "info")
      .sort((a, b) => (a.priority === "urgent") - (b.priority === "urgent") || a.lastAt - b.lastAt)
      .reverse();
  }

  pendingUrgent() {
    return this.open().filter((e) => e.priority === "urgent");
  }

  /** Alerts that happened while this device was away and nobody has acknowledged since. */
  missed() {
    return this.events.filter((e) => e.missed && !e.acked);
  }

  /** "OK" on the "while this device was away" note: those alerts have been seen here (nobody else is told). */
  dismissMissed(by = { id: this.selfId, name: "This device" }) {
    const at = this.now();
    for (const e of this.events) {
      if (!e.missed) continue;
      e.missed = false;
      e.acked ||= { by, at };
    }
  }

  /** Newest first. */
  list() {
    return this.events.slice().reverse();
  }

  clear() {
    this.events = this.events.filter((e) => e.priority === "urgent" && !e.acked && !e.missed && !e.history);
  }

  toJSON() {
    return this.events.map((e) => ({ ...e }));
  }
}
