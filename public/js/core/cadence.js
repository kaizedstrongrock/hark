// Alarm cadence detector. Smoke and CO alarms do not just beep - they beep in legally standardised
// rhythms, which makes them recognisable even when the sound itself is unusual or muffled:
//   T3 "temporal-three" (smoke / fire evacuation; ANSI/ASA S3.41, ISO 8201, NFPA 72):
//       0.5 s on, 0.5 s off, three times, then 1.5 s off.
//   T4 "temporal-four" (carbon monoxide; NFPA 720 / UL 2034):
//       0.1 s on, 0.1 s off, four times, then about 5 s off.
// Input: frames from FrameAnalyzer ({t, tonal, peakHz}). Pure module.

// stale: once this long has passed since the last complete cycle without another one, the alarm has
// stopped (T3: 1.5 s rest + 2.5 s of beeps + 0.9 s to confirm the next cycle = 4.9 s; T4: 5 + 0.8 + 1.8).
export const PATTERNS = {
  T3: { pulses: 3, on: [0.3, 0.85], gap: [0.25, 0.85], rest: [0.9, 2.8], stale: 6.5 },
  T4: { pulses: 4, on: [0.04, 0.26], gap: [0.04, 0.26], rest: [1.8, 7.5], stale: 10.5 },
};

export class CadenceDetector {
  /**
   * @param {{frameStep?: number, mergeGap?: number, keepSeconds?: number}} [opts]
   *   frameStep: seconds between frames (FrameAnalyzer hop / sr)
   */
  constructor({ frameStep = 0.02, mergeGap = 0.05, keepSeconds = 24 } = {}) {
    this.step = frameStep;
    this.mergeGap = mergeGap;
    this.keep = keepSeconds;
    this.pulses = []; // {start, end, freqs: number[]}
    this.cur = null;
    this.lastTonalT = -Infinity;
    this.now = 0;
  }

  push(frame) {
    this.now = frame.t;
    if (frame.tonal) {
      if (this.cur && frame.t - this.lastTonalT <= this.mergeGap + this.step * 0.5) {
        this.cur.end = frame.t;
        this.cur.freqs.push(frame.peakHz);
      } else {
        this._close();
        this.cur = { start: frame.t - this.step, end: frame.t, freqs: [frame.peakHz] };
      }
      this.lastTonalT = frame.t;
    } else if (this.cur && frame.t - this.lastTonalT > this.mergeGap + this.step * 0.5) {
      this._close();
    }
  }

  _close() {
    if (!this.cur) return;
    const p = this.cur;
    this.cur = null;
    if (p.end - p.start < 0.035) return; // clicks
    p.freq = median(p.freqs);
    delete p.freqs;
    this.pulses.push(p);
    const cutoff = this.now - this.keep;
    while (this.pulses.length && this.pulses[0].end < cutoff) this.pulses.shift();
  }

  /** Consecutive cycles of each pattern in the run that is still going on now (0 once the alarm stops). */
  detect() {
    const cutoff = this.now - this.keep;
    while (this.pulses.length && this.pulses[0].end < cutoff) this.pulses.shift();
    const pulses = this.cur ? [...this.pulses, { ...this.cur, freq: median(this.cur.freqs), open: true }] : this.pulses;
    const out = {};
    for (const [name, pat] of Object.entries(PATTERNS)) out[name] = countCycles(pulses, pat, this.now);
    return out;
  }

  reset() {
    this.pulses = [];
    this.cur = null;
  }
}

function countCycles(pulses, pat, now) {
  const inRange = (v, [lo, hi]) => v >= lo && v <= hi;
  const dur = (p) => p.end - p.start;
  let cycles = 0; // length of the current run of consecutive valid cycles
  let freq = null;
  let lastEnd = null;
  let i = 0;
  while (i < pulses.length) {
    // grow a group of pulses separated by short gaps
    const group = [pulses[i]];
    let j = i + 1;
    while (j < pulses.length) {
      const gap = pulses[j].start - pulses[j - 1].end;
      if (gap > pat.gap[1]) break;
      group.push(pulses[j]);
      j++;
    }
    const next = pulses[j];
    const last = group[group.length - 1];
    const rest = next ? next.start - last.end : now - last.end;
    // the newest group is still forming (more beeps or its rest may still come): judge it later
    if (!next && rest < pat.rest[0]) break;
    const gapsOk = group.every((p, k) => k === 0 || inRange(p.start - group[k - 1].end, pat.gap));
    const onsOk = group.every((p) => !p.open && inRange(dur(p), pat.on));
    const f = median(group.map((p) => p.freq));
    const pitchOk = group.every((p) => Math.abs(p.freq - f) <= 0.12 * f);
    const restOk = rest >= pat.rest[0] && (!next || rest <= pat.rest[1] * 1.5);
    const valid = group.length === pat.pulses && gapsOk && onsOk && pitchOk && restOk;
    if (valid && (freq === null || Math.abs(f - freq) <= 0.15 * freq)) {
      cycles++;
      freq = freq ?? f;
      lastEnd = last.end;
    } else if (valid) {
      // a valid cycle at a different pitch starts a new run
      cycles = 1;
      freq = f;
      lastEnd = last.end;
    } else if (group.some((p) => !p.open)) {
      // a broken (closed) group ends the run; an open group is just the next cycle still sounding
      cycles = 0;
      freq = null;
      lastEnd = null;
    }
    i = j;
  }
  // the run only counts while it is still going on
  if (lastEnd === null || now - lastEnd > pat.stale) return { cycles: 0, freq: null, lastEnd: null };
  return { cycles, freq, lastEnd };
}

function median(xs) {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}
