// Alert engine: turns YAMNet class scores, alarm cadences and custom-sound matches into pages.
// Thresholds for the ESC-50-covered alerts were tuned on folds 1-3 and evaluated on held-out folds 4-5
// (bench/evaluate.mjs, results in bench/results/esc50.json).
// Pure module.

/**
 * Alert definitions. `classes` are exact YAMNet (AudioSet) label names - a unit test checks them
 * against the model's embedded label list so a typo can never silently disable an alert.
 * hits: consecutive 0.975 s windows (hop 0.5 s) at or above threshold before paging.
 * vibrate: the pager's haptic signature, so you can tell sounds apart without looking.
 */
export const ALERTS = [
  {
    id: "smoke",
    label: "Smoke alarm",
    icon: "🔥",
    priority: "urgent",
    // "Fire alarm" is too broad on its own (crickets 0.85, sirens 0.67 on ESC-50), so the direct
    // route uses only the specific smoke-detector class; the T3 cadence route catches the rest.
    classes: ["Smoke detector, smoke alarm"],
    threshold: 0.5,
    hits: 2,
    cadence: "T3",
    vibrate: [500, 250, 500, 250, 500, 900],
    advice: "This is the smoke alarm pattern. Leave the building, then check.",
  },
  {
    id: "co",
    label: "Carbon monoxide alarm",
    icon: "⚠️",
    priority: "urgent",
    classes: [],
    threshold: 1,
    hits: 1,
    cadence: "T4",
    vibrate: [120, 100, 120, 100, 120, 100, 120, 900],
    advice: "This is the carbon monoxide alarm pattern. Go outside into fresh air now.",
  },
  {
    id: "baby",
    label: "Baby crying",
    icon: "👶",
    priority: "urgent",
    classes: ["Baby cry, infant cry"],
    threshold: 0.35,
    hits: 1,
    vibrate: [300, 150, 700],
  },
  {
    id: "glass",
    label: "Glass breaking",
    icon: "💥",
    priority: "urgent",
    classes: ["Shatter", "Breaking"],
    threshold: 0.15,
    hits: 1,
    vibrate: [100, 60, 100, 60, 100, 60, 600],
  },
  {
    id: "scream",
    label: "Someone screamed",
    icon: "😱",
    priority: "urgent",
    classes: ["Screaming"],
    threshold: 0.4,
    hits: 1,
    vibrate: [700, 150, 700],
  },
  {
    id: "doorbell",
    label: "Doorbell",
    icon: "🔔",
    priority: "normal",
    classes: ["Doorbell", "Ding-dong"],
    threshold: 0.3,
    hits: 1,
    vibrate: [200, 120, 400],
  },
  {
    id: "knock",
    label: "Knocking",
    icon: "🚪",
    priority: "normal",
    classes: ["Knock"],
    threshold: 0.3,
    hits: 1,
    vibrate: [90, 90, 90, 90, 90],
  },
  {
    id: "siren",
    label: "Siren nearby",
    icon: "🚨",
    priority: "normal",
    classes: ["Siren", "Civil defense siren", "Police car (siren)", "Ambulance (siren)", "Fire engine, fire truck (siren)", "Emergency vehicle"],
    threshold: 0.35,
    hits: 1,
    vibrate: [600, 200, 600],
  },
  {
    id: "phone",
    label: "Phone ringing",
    icon: "📞",
    priority: "normal",
    classes: ["Telephone bell ringing", "Ringtone", "Telephone"],
    threshold: 0.35,
    hits: 2,
    // Off by default: most people's phones already vibrate, and YAMNet often hears appliance beeps as
    // "Telephone"/"Ringtone" (a synthetic timer beep scores Telephone 0.96). When enabled, strong
    // alarm/beep evidence vetoes it so one sound gives one page.
    unless: { classes: ["Beep, bleep", "Alarm", "Alarm clock", "Buzzer", "Microwave oven"], threshold: 0.6 },
    defaultOff: true,
    vibrate: [250, 100, 250, 100, 250],
  },
  {
    id: "alarm",
    label: "Alarm or timer",
    icon: "⏰",
    priority: "normal",
    classes: ["Alarm clock", "Alarm", "Buzzer", "Beep, bleep"],
    threshold: 0.3,
    hits: 1,
    vibrate: [150, 100, 150, 100, 150],
    suppressedBy: ["smoke", "co", "siren"],
    holdSeconds: 4, // wait for a possible T3/T4 smoke/CO rhythm before paging a generic beep
    waitForRhythm: true, // ...and keep waiting (up to 14 s) while a T3/T4 candidate is still forming
  },
  {
    id: "dog",
    label: "Dog barking",
    icon: "🐕",
    priority: "normal",
    classes: ["Bark", "Dog", "Bow-wow", "Yip", "Howl", "Growling"],
    threshold: 0.35,
    hits: 2,
    vibrate: [200, 100, 200],
  },
  {
    id: "horn",
    label: "Car horn",
    icon: "🚗",
    priority: "normal",
    classes: ["Vehicle horn, car horn, honking", "Air horn, truck horn", "Car alarm"],
    threshold: 0.15,
    hits: 1,
    holdSeconds: 1.5, // give a siren the chance to claim the event (fire trucks honk too)
    suppressedBy: ["siren"],
    vibrate: [400, 150, 400],
  },
  {
    id: "water",
    label: "Water running",
    icon: "💧",
    priority: "info",
    classes: ["Water tap, faucet", "Sink (filling or washing)", "Bathtub (filling or washing)"],
    threshold: 0.3,
    hits: 1,
    sustainSeconds: 20,
    vibrate: [150],
  },
  {
    id: "cat",
    label: "Cat",
    icon: "🐈",
    priority: "info",
    classes: ["Cat", "Meow", "Purr", "Hiss", "Caterwaul"],
    threshold: 0.3,
    hits: 2,
    suppressedBy: ["baby"], // YAMNet hears parts of infant cries as "Meow"
    vibrate: [100],
  },
  {
    id: "speech",
    label: "Someone is talking",
    icon: "💬",
    priority: "info",
    classes: ["Speech"],
    threshold: 0.6,
    hits: 3,
    defaultOff: true,
    vibrate: [100, 80, 100],
  },
];

export const ALERTS_BY_ID = Object.fromEntries(ALERTS.map((a) => [a.id, a]));

/**
 * YAMNet classes that let a single T3/T4 cycle count as an alarm. Generic beeps are deliberately NOT
 * enough: a microwave that beeps three times (0.4 s on/off) fits one T3 cycle, while a real smoke alarm
 * keeps repeating, so without specific evidence we wait for a second full cycle (about 4 s more).
 */
const ALARM_SPECIFIC = ["Smoke detector, smoke alarm", "Fire alarm"];

export const SENSITIVITY = { low: 1.3, normal: 1, high: 0.75 };
export const CUSTOM_HITS = 2;

export class AlertEngine {
  /**
   * @param {{enabled?: Record<string, boolean>, sensitivity?: keyof SENSITIVITY, cooldown?: number, repeatUrgent?: number}} [opts]
   */
  constructor(opts = {}) {
    this.enabled = { ...Object.fromEntries(ALERTS.map((a) => [a.id, !a.defaultOff])), ...(opts.enabled || {}) };
    this.factor = SENSITIVITY[opts.sensitivity] ?? 1;
    this.cooldown = opts.cooldown ?? 12; // seconds of quiet before the same alert can page again
    this.repeatUrgent = opts.repeatUrgent ?? 30; // urgent alerts re-page while still sounding
    this.state = new Map(); // id -> {hits, active, firedAt, lastSeen, sustainStart, lastRepeat}
  }

  setOptions({ enabled, sensitivity } = {}) {
    if (enabled) this.enabled = { ...this.enabled, ...enabled };
    if (sensitivity) this.factor = SENSITIVITY[sensitivity] ?? this.factor;
  }

  _st(id) {
    let s = this.state.get(id);
    if (!s) this.state.set(id, (s = { hits: 0, active: false, firedAt: -Infinity, lastSeen: -Infinity, sustainStart: null, lastRepeat: -Infinity }));
    return s;
  }

  /**
   * Process one analysis window.
   * @param {{t: number, scores: Map<string, number>, cadence?: {T3?: {cycles:number, freq:number|null}, T4?: {cycles:number, freq:number|null}}, custom?: {id:string,label:string,icon?:string,priority:string,score:number,match:boolean}[], names?: string[]}} input
   * @returns {object[]} pages to send
   */
  tick({ t, scores, cadence = {}, custom = [], names = [] }) {
    const fired = [];
    const score = (cls) => cls.reduce((m, c) => Math.max(m, scores.get(c) || 0), 0);
    const specific = score(ALARM_SPECIFIC);

    // Taught sounds first: they are the user's most specific knowledge about their own home.
    let customFired = false;
    for (const c of custom) {
      // two consecutive matching windows (0.5 s apart): halves false pages in the ESC-50 few-shot benchmark
      const st = this._st(`custom:${c.id}`);
      st.hits = c.match ? st.hits + 1 : 0;
      const def = { id: `custom-${c.id}`, label: String(c.label), icon: c.icon || "⭐", priority: c.priority || "normal", vibrate: [200, 100, 200, 100, 200], custom: true };
      const before = fired.length;
      this._update(def, st, t, st.hits >= CUSTOM_HITS, c.score, `a sound you taught HARK · match ${Math.round(c.score * 100)}%`, fired);
      if (fired.length > before) customFired = true;
    }
    const customMatching = custom.some((c) => c.match);
    const customOngoing =
      customFired ||
      custom.some((c) => {
        const st = this.state.get(`custom:${c.id}`);
        return st?.active && t - st.lastSeen <= 1;
      });

    for (const a of ALERTS) {
      if (!this.enabled[a.id]) continue;
      const st = this._st(a.id);
      let present = false;
      let confidence = 0;
      let detail = "";
      if (a.cadence) {
        const c = cadence[a.cadence] || { cycles: 0 };
        if (c.cycles >= 2 || (c.cycles >= 1 && specific >= 0.3)) {
          present = true;
          confidence = Math.min(0.99, 0.75 + 0.1 * c.cycles + 0.2 * specific);
          detail = `${a.cadence} beep pattern · ${c.freq ? (c.freq / 1000).toFixed(2) + " kHz" : ""} · ${c.cycles} cycle${c.cycles > 1 ? "s" : ""}`;
        }
      }
      if (!present && a.classes.length) {
        const s = score(a.classes);
        const vetoed = a.unless && score(a.unless.classes) >= a.unless.threshold;
        if (s >= a.threshold * this.factor && !vetoed) {
          st.hits++;
          if (st.hits >= a.hits) {
            present = true;
            confidence = s;
            const top = a.classes.map((c) => [c, scores.get(c) || 0]).sort((x, y) => y[1] - x[1])[0];
            detail = `heard "${top[0]}" ${Math.round(top[1] * 100)}%`;
          }
        } else st.hits = 0;
      }
      // One sound, one page with taught sounds: if you taught HARK *your* doorbell, a ring should page
      // "FRONT DOOR", not also YAMNet's generic DOORBELL. While a taught sound is matching, non-urgent
      // built-in pages wait one window; if the taught sound confirms, the built-in page is dropped.
      // Urgent alerts are never delayed.
      if (a.priority !== "urgent") {
        if (customOngoing && (present || st.deferred)) {
          st.deferred = null;
          st.hold = null;
          st.active = true; // consumed by the taught sound: no page for the rest of this event
          st.lastSeen = t;
          st.firedAt = t;
          continue;
        }
        if (present && customMatching && !st.active) {
          st.deferred ??= { confidence, detail };
          continue;
        }
        if (st.deferred) {
          // the taught sound did not confirm: page the built-in alert after all
          const d = st.deferred;
          st.deferred = null;
          if (!present) {
            present = true;
            confidence = d.confidence;
            detail = d.detail;
          }
        }
      }
      if (a.holdSeconds) {
        if (present && !st.active) {
          st.hold ??= { t0: t, confidence, detail };
          present = false;
        }
        // A confirmed CO alarm takes two T4 cycles: the second completes ~7.6 s after the first one ended
        // (5 s rest + 0.8 s of beeps + 1.8 s of rest to confirm), T3 after ~4.9 s. Keep holding meanwhile.
        const forming = a.waitForRhythm && ["T3", "T4"].some((p) => cadence[p]?.cycles >= 1 && cadence[p].lastEnd != null && t - cadence[p].lastEnd < 8);
        if (st.hold && t - st.hold.t0 >= a.holdSeconds && !(forming && t - st.hold.t0 < 14)) {
          const held = st.hold;
          st.hold = null;
          const suppressed = (a.suppressedBy || []).some((id) => this._st(id).active || fired.some((f) => f.kind === id));
          if (!suppressed) {
            this._update(a, st, t, true, held.confidence, held.detail, fired);
            continue;
          }
        }
      }
      this._update(a, st, t, present, confidence, detail, fired);
    }

    for (const name of names) {
      // names are point events: page at most once per cooldown per name
      const st = this._st(`name:${name.toLowerCase()}`);
      if (t - st.firedAt < this.cooldown) continue;
      st.firedAt = t;
      const def = { id: "name", label: `Someone said "${name}"`, icon: "🗣️", priority: "normal", vibrate: [120, 80, 120, 80, 400] };
      fired.push(this._page(def, 0.9, "someone said your name", t, false));
    }

    // One sound, one page: drop pages whose "suppressor" alert is active or fired in this window
    // (smoke/CO over generic beeps, siren over horn and beeps, baby over cat).
    const live = new Set(fired.map((f) => f.kind));
    for (const a of ALERTS) if (this.state.get(a.id)?.active) live.add(a.id);
    return fired.filter((f) => !(ALERTS_BY_ID[f.kind]?.suppressedBy || []).some((s) => live.has(s)));
  }

  _update(a, st, t, present, confidence, detail, fired) {
    if (present) {
      if (a.sustainSeconds) {
        st.sustainStart ??= t;
        if (t - st.sustainStart < a.sustainSeconds) {
          st.lastSeen = t;
          return;
        }
      }
      const quietFor = t - st.lastSeen;
      st.lastSeen = t;
      if (!st.active || quietFor > this.cooldown) {
        st.active = true;
        st.acked = false; // a new occurrence: an acknowledgement of an earlier one does not cover it
        st.firedAt = t;
        st.lastRepeat = t;
        fired.push(this._page(a, confidence, detail, t, false));
      } else if (a.priority === "urgent" && !st.acked && t - st.lastRepeat >= this.repeatUrgent) {
        st.lastRepeat = t;
        fired.push(this._page(a, confidence, detail, t, true));
      }
    } else {
      if (a.sustainSeconds && t - st.lastSeen > 3) st.sustainStart = null;
      if (st.active && t - st.lastSeen > this.cooldown) {
        st.active = false;
        st.acked = false;
      }
    }
  }

  _page(a, confidence, detail, t, repeat) {
    return {
      kind: a.id,
      label: a.label,
      icon: a.icon,
      priority: a.priority,
      confidence: Math.max(0, Math.min(1, Number(confidence.toFixed(3)))),
      detail: repeat ? `still sounding · ${detail}` : detail,
      vibrate: a.vibrate,
      advice: a.advice,
      custom: a.custom || undefined,
      repeat: repeat || undefined,
      t,
    };
  }

  /**
   * Someone has seen this alert: stop re-paging it until the sound stops and starts again. Only a sound that
   * is going on right now on this device is covered (an acknowledgement of an alarm another device heard
   * must not silence the repeats of a later alarm here).
   */
  ack(kind) {
    const st = this.state.get(kind) || this.state.get(`custom:${String(kind).replace(/^custom-/, "")}`);
    if (st && st.active) st.acked = true;
  }

  /** Forget everything (e.g. after the user acknowledges). */
  reset(id) {
    if (id) this.state.delete(id);
    else this.state.clear();
  }
}
