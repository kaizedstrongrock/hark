// The listening pipeline: 16 kHz audio in, pages out.
//   audio -> FrameAnalyzer (level, tonal frames) -> CadenceDetector (T3/T4 alarm rhythms)
//         -> every 0.5 s: classifier(last 0.975 s) -> custom-sound matcher -> AlertEngine -> pages
// The classifier is injected (MediaPipe YAMNet in the browser, a scripted fake in tests). Pure module.
import { FrameAnalyzer, rms, toDb } from "./dsp.js";
import { CadenceDetector } from "./cadence.js";
import { AlertEngine } from "./alerts.js";
import { embed, matchCustom } from "./custom.js";

export const WINDOW = 15600; // YAMNet input: 0.975 s at 16 kHz
export const HOP = 8000; // analyse twice per second

export class Listener {
  /**
   * @param {{classify: (x: Float32Array) => Float32Array, labels: string[], engine?: AlertEngine,
   *          onPage?: (p: object) => void, onStatus?: (s: object) => void, sr?: number}} opts
   *   classify returns the 521 YAMNet scores in label-index order.
   */
  constructor(opts) {
    this.classify = opts.classify;
    this.labels = opts.labels;
    this.engine = opts.engine || new AlertEngine();
    this.onPage = opts.onPage || (() => {});
    this.onStatus = opts.onStatus || (() => {});
    this.onFrame = opts.onFrame || null;
    this.sr = opts.sr || 16000;
    this.buf = new Float32Array(WINDOW * 2);
    this.filled = 0;
    this.sinceHop = 0;
    this.t = 0;
    this.lastFrame = null;
    this.cadence = new CadenceDetector({ frameStep: 320 / this.sr });
    this.frames = new FrameAnalyzer({
      sr: this.sr,
      onFrame: (f) => {
        this.lastFrame = f;
        this.cadence.push(f);
        this.onFrame?.(f);
      },
    });
    this.custom = []; // [{id, label, icon, priority, model}]
    this.pendingNames = [];
    this.background = []; // recent embeddings of ordinary room sound (negatives for training)
    this.lastBackgroundAt = -Infinity;
    this.recording = null;
    this.paused = false;
  }

  setCustomSounds(list) {
    this.custom = list.filter((s) => s && s.model);
  }

  /** Called by the captions module when a configured name is heard. */
  heardName(name) {
    this.pendingNames.push(name);
  }

  startRecording() {
    this.recording = [];
  }

  /** @returns {Float32Array} everything pushed since startRecording() */
  stopRecording() {
    const chunks = this.recording || [];
    this.recording = null;
    const n = chunks.reduce((s, c) => s + c.length, 0);
    const out = new Float32Array(n);
    let o = 0;
    for (const c of chunks) {
      out.set(c, o);
      o += c.length;
    }
    return out;
  }

  push(chunk) {
    if (this.recording) this.recording.push(Float32Array.from(chunk));
    this.frames.push(chunk);
    // append to the sliding analysis buffer
    if (chunk.length >= this.buf.length) {
      this.buf.set(chunk.subarray(chunk.length - this.buf.length));
      this.filled = this.buf.length;
    } else {
      const overflow = Math.max(0, this.filled + chunk.length - this.buf.length);
      if (overflow) {
        this.buf.copyWithin(0, overflow, this.filled);
        this.filled -= overflow;
      }
      this.buf.set(chunk, this.filled);
      this.filled += chunk.length;
    }
    this.t += chunk.length / this.sr;
    this.sinceHop += chunk.length;
    if (this.sinceHop >= HOP && this.filled >= WINDOW) {
      this.sinceHop = 0;
      if (!this.paused) this._analyse();
    }
  }

  _analyse() {
    const x = this.buf.slice(this.filled - WINDOW, this.filled);
    const scoresArr = this.classify(x);
    const scores = new Map();
    for (let i = 0; i < this.labels.length; i++) scores.set(this.labels[i], scoresArr[i] || 0);
    const cadence = this.cadence.detect();
    const levelDb = toDb(rms(x));
    const floorDb = this.lastFrame ? this.lastFrame.floorDb : -70;
    const loudEnough = levelDb >= floorDb + 6 && levelDb > -55;

    let e = null;
    const custom = [];
    if (this.custom.length || this.t - this.lastBackgroundAt >= 2) {
      e = embed(x, scoresArr, this.sr);
    }
    for (const s of this.custom) {
      const m = matchCustom(s.model, e);
      custom.push({ id: s.id, label: s.label, icon: s.icon, priority: s.priority, score: m.score, match: loudEnough && m.match });
    }

    const names = this.pendingNames;
    this.pendingNames = [];
    const pages = this.engine.tick({ t: this.t, scores, cadence, custom, names });
    for (const p of pages) this.onPage(p);

    // keep a rolling sample of "normal" room sound as negatives for custom-sound training
    if (e && !pages.length && this.t - this.lastBackgroundAt >= 2) {
      this.background.push(e);
      if (this.background.length > 60) this.background.shift();
      this.lastBackgroundAt = this.t;
    }

    const top = [];
    for (let i = 0; i < scoresArr.length; i++) {
      if (top.length < 5 || scoresArr[i] > top[top.length - 1][1]) {
        top.push([this.labels[i], scoresArr[i]]);
        top.sort((a, b) => b[1] - a[1]);
        if (top.length > 5) top.pop();
      }
    }
    this.onStatus({
      t: this.t,
      levelDb,
      floorDb,
      level: Math.max(0, Math.min(1, (levelDb + 70) / 70)),
      top: top.map(([name, score]) => ({ name, score })),
      cadence,
      custom,
    });
  }
}

/** Split a recording into analysis windows (hop 0.25 s) whose level is clearly above the room floor. */
export function windowsForTraining(x, { sr = 16000, floorDb = -70, hop = 4000 } = {}) {
  const out = [];
  const levels = [];
  for (let s = 0; s + WINDOW <= x.length; s += hop) levels.push([s, toDb(rms(x, s, s + WINDOW))]);
  if (!levels.length && x.length >= sr * 0.5) {
    const padded = new Float32Array(WINDOW);
    padded.set(x.subarray(0, Math.min(x.length, WINDOW)));
    return [padded];
  }
  const loudest = Math.max(...levels.map((l) => l[1]));
  for (const [s, db] of levels) {
    if (db >= Math.max(floorDb + 6, loudest - 15)) out.push(x.slice(s, s + WINDOW));
  }
  return out;
}
