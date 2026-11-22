// Synthesised household sounds for the "Test sounds" panel and the automated tests.
// Everything is generated from scratch (no recordings, no licensing questions).
// Pure module: returns Float32Array mono samples in [-1, 1].

export const SR = 16000;

function rng(seed) {
  // small deterministic PRNG so tests are reproducible
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return ((s >>> 0) / 4294967296) * 2 - 1;
  };
}

/** RBJ biquad band-pass (constant skirt gain), applied in place. */
function bandpass(x, sr, f0, q) {
  const w0 = (2 * Math.PI * f0) / sr;
  const alpha = Math.sin(w0) / (2 * q);
  const b0 = alpha;
  const b2 = -alpha;
  const a0 = 1 + alpha;
  const a1 = -2 * Math.cos(w0);
  const a2 = 1 - alpha;
  let x1 = 0;
  let x2 = 0;
  let y1 = 0;
  let y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const y = (b0 * x[i] + b2 * x2 - a1 * y1 - a2 * y2) / a0;
    x2 = x1;
    x1 = x[i];
    y2 = y1;
    y1 = y;
    x[i] = y;
  }
  return x;
}

function normalize(x, peak = 0.8) {
  let m = 0;
  for (const v of x) m = Math.max(m, Math.abs(v));
  if (m > 0) for (let i = 0; i < x.length; i++) x[i] = (x[i] / m) * peak;
  return x;
}

function addNoise(x, level, seed = 7) {
  const r = rng(seed);
  for (let i = 0; i < x.length; i++) x[i] += r() * level;
  return x;
}

/**
 * Smoke alarm: the standard "temporal-three" (T3) evacuation pattern - three 0.5 s beeps with
 * 0.5 s gaps, then 1.5 s of silence - on a piezo tone around 3.1 kHz.
 */
export function smokeAlarm(seconds = 8, sr = SR) {
  const x = new Float32Array(Math.round(seconds * sr));
  const f = 3150;
  for (let i = 0; i < x.length; i++) {
    const t = i / sr;
    const cycle = t % 4; // 0.5 on, 0.5 off, 0.5 on, 0.5 off, 0.5 on, 1.5 off
    const on = (cycle < 0.5) || (cycle >= 1 && cycle < 1.5) || (cycle >= 2 && cycle < 2.5);
    if (!on) continue;
    // piezo: strong fundamental, odd harmonic folded under Nyquist is avoided (sr=16k -> only fundamental + 2nd)
    x[i] = Math.sin(2 * Math.PI * f * t) * 0.9 + Math.sin(2 * Math.PI * 2 * f * t) * 0.15;
  }
  return normalize(addNoise(x, 0.01, 11));
}

/**
 * Carbon-monoxide alarm: the "temporal-four" (T4) pattern - four 0.1 s beeps with 0.1 s gaps,
 * then about 5 s of silence (NFPA 720 / UL 2034).
 */
export function coAlarm(seconds = 13, sr = SR) {
  const x = new Float32Array(Math.round(seconds * sr));
  const f = 3300;
  for (let i = 0; i < x.length; i++) {
    const t = i / sr;
    const c = t % 5.8; // 4 x (0.1 on + 0.1 off) = 0.8 s, then 5.0 s off
    const on = c < 0.8 && c % 0.2 < 0.1;
    if (on) x[i] = Math.sin(2 * Math.PI * f * t) * 0.9 + Math.sin(2 * Math.PI * 2 * f * t) * 0.1;
  }
  return normalize(addNoise(x, 0.01, 31));
}

/** Two-tone door chime ("ding-dong"): struck-bell partials on E5 then C5. */
export function doorbell(seconds = 3, sr = SR) {
  const x = new Float32Array(Math.round(seconds * sr));
  const strike = (start, f0) => {
    const partials = [
      [1, 1.0, 1.6],
      [2.0, 0.5, 1.0],
      [2.76, 0.35, 0.7],
      [5.4, 0.15, 0.35],
    ];
    const s0 = Math.round(start * sr);
    for (let i = s0; i < x.length; i++) {
      const t = (i - s0) / sr;
      let v = 0;
      for (const [ratio, amp, decay] of partials) {
        const f = f0 * ratio;
        if (f >= sr / 2) continue;
        v += amp * Math.exp(-t / decay) * Math.sin(2 * Math.PI * f * t);
      }
      const attack = Math.min(1, t / 0.004);
      x[i] += v * attack;
    }
  };
  strike(0.1, 659.25);
  strike(0.85, 523.25);
  return normalize(addNoise(x, 0.004, 3));
}

/**
 * A sample door chime for the "Teach a sound" demo: two struck metal bars (free-free bar partials
 * 1 : 2.756 : 5.404 : 8.933) with a mallet click and a little room reverb. `variant` nudges pitch
 * and timing so the three training "rings" are not identical.
 */
export function sampleChime(variant = 0, sr = SR) {
  const x = new Float32Array(Math.round(3 * sr));
  const r = rng(41 + variant);
  const detune = 1 + variant * 0.004;
  const start = 0.1 + variant * 0.03;
  for (const [t0, f0] of [[start, 659.25 * detune], [start + 0.6, 523.25 * detune]]) {
    const s0 = Math.round(t0 * sr);
    for (let i = s0; i < x.length; i++) {
      const t = (i - s0) / sr;
      let v = 0;
      [[1, 1, 0.7], [2.756, 0.7, 0.35], [5.404, 0.35, 0.18], [8.933, 0.15, 0.1]].forEach(([ratio, amp, dec]) => {
        if (f0 * ratio < sr / 2) v += amp * Math.exp(-t / dec) * Math.sin(2 * Math.PI * f0 * ratio * t);
      });
      x[i] += v * Math.min(1, t / 0.002);
    }
    for (let i = 0; i < 0.012 * sr && s0 + i < x.length; i++) x[s0 + i] += r() * 0.8 * Math.exp(-i / (0.002 * sr));
  }
  // short diffuse room reverb (convolution with decaying noise)
  const n = Math.round(0.45 * sr);
  const out = Float32Array.from(x, (v) => v * 0.65);
  const ir = Float32Array.from({ length: n }, (_, i) => r() * Math.exp((-6.9 * i) / n) * 0.02);
  for (let i = 0; i < x.length; i++) {
    if (!x[i]) continue;
    for (let k = 0; k < n && i + k < x.length; k += 2) out[i + k] += x[i] * ir[k] * 2.1;
  }
  return normalize(addNoise(out, 0.003, 43 + variant));
}

/** Knuckles on a wooden door: three short resonant impacts. */
export function knock(seconds = 2.5, sr = SR, times = [0.2, 0.45, 0.7, 1.6, 1.85, 2.1]) {
  const x = new Float32Array(Math.round(seconds * sr));
  const r = rng(5);
  for (const t0 of times) {
    const s0 = Math.round(t0 * sr);
    const len = Math.round(0.09 * sr);
    const burst = new Float32Array(len);
    for (let i = 0; i < len; i++) burst[i] = r() * Math.exp(-i / (0.004 * sr));
    const low = bandpass(Float32Array.from(burst), sr, 190, 3);
    const mid = bandpass(Float32Array.from(burst), sr, 820, 4);
    for (let i = 0; i < len && s0 + i < x.length; i++) x[s0 + i] += low[i] * 4 + mid[i] * 1.5;
  }
  return normalize(addNoise(x, 0.002, 9));
}

/** Emergency-vehicle "wail": slow sweep between ~650 and ~1500 Hz. */
export function siren(seconds = 8, sr = SR) {
  const x = new Float32Array(Math.round(seconds * sr));
  let phase = 0;
  for (let i = 0; i < x.length; i++) {
    const t = i / sr;
    const f = 650 + 850 * (0.5 - 0.5 * Math.cos((2 * Math.PI * t) / 4));
    phase += (2 * Math.PI * f) / sr;
    x[i] = Math.sin(phase) * 0.8 + Math.sin(2 * phase) * 0.25 + Math.sin(3 * phase) * 0.1;
  }
  return normalize(addNoise(x, 0.01, 13));
}

/**
 * Timer / appliance "done": quick triple beeps at 2.8 kHz (0.12 s on, 0.12 s off), once a second.
 * Chosen because YAMNet recognises it as a beep at every alignment, and because three short pulses
 * can never satisfy the T3 (0.5 s pulses) or T4 (four pulses) alarm rhythms.
 */
export function applianceBeep(seconds = 3.5, sr = SR) {
  const x = new Float32Array(Math.round(seconds * sr));
  for (let i = 0; i < x.length; i++) {
    const t = i / sr;
    const c = t % 1.0;
    if (c < 0.72 && c % 0.24 < 0.12) x[i] = Math.sin(2 * Math.PI * 2800 * t) * 0.8 + Math.sin(2 * Math.PI * 5600 * t) * 0.2;
  }
  return normalize(addNoise(x, 0.004, 17));
}

/** Old-style telephone bell: two bell tones hammered at 20 Hz, 2 s on / 4 s off. */
export function phoneRing(seconds = 6, sr = SR) {
  const x = new Float32Array(Math.round(seconds * sr));
  for (let i = 0; i < x.length; i++) {
    const t = i / sr;
    if (t % 6 >= 2) continue;
    const hammer = 0.5 + 0.5 * Math.sign(Math.sin(2 * Math.PI * 20 * t));
    x[i] = hammer * (Math.sin(2 * Math.PI * 1100 * t) + 0.7 * Math.sin(2 * Math.PI * 1370 * t) + 0.3 * Math.sin(2 * Math.PI * 2750 * t));
  }
  return normalize(addNoise(x, 0.006, 19));
}

/** A crude infant cry: harmonic "waah" with vibrato and vowel formants. */
export function babyCry(seconds = 6, sr = SR) {
  const x = new Float32Array(Math.round(seconds * sr));
  let phase = 0;
  for (let i = 0; i < x.length; i++) {
    const t = i / sr;
    const c = t % 1.3;
    const env = c < 1.0 ? Math.sin((Math.PI * c) / 1.0) ** 0.6 : 0;
    const f0 = 470 + 60 * Math.sin(2 * Math.PI * 0.9 * t) + 18 * Math.sin(2 * Math.PI * 7 * t);
    phase += (2 * Math.PI * f0) / sr;
    let v = 0;
    for (let h = 1; h <= 14; h++) {
      if (f0 * h >= sr / 2) break;
      v += Math.sin(h * phase) / h;
    }
    x[i] = v * env;
  }
  const f1 = bandpass(Float32Array.from(x), sr, 1100, 2.5);
  const f2 = bandpass(Float32Array.from(x), sr, 3000, 3);
  for (let i = 0; i < x.length; i++) x[i] = f1[i] * 1.0 + f2[i] * 0.6 + x[i] * 0.05;
  return normalize(addNoise(x, 0.006, 23));
}

/** Quiet room tone (for calibration / negatives). */
export function roomTone(seconds = 3, sr = SR, level = 0.01) {
  const x = new Float32Array(Math.round(seconds * sr));
  addNoise(x, level, 29);
  return bandpass(x, sr, 400, 0.3);
}

/** A pure tone - handy for custom-sound tests. */
export function tone(freq, seconds = 2, sr = SR, { onOff = null } = {}) {
  const x = new Float32Array(Math.round(seconds * sr));
  for (let i = 0; i < x.length; i++) {
    const t = i / sr;
    if (onOff && t % (onOff[0] + onOff[1]) >= onOff[0]) continue;
    x[i] = Math.sin(2 * Math.PI * freq * t) * 0.6;
  }
  return addNoise(x, 0.003, Math.round(freq));
}

/** Synthesised sounds (used by the unit tests, and the ones the detectors recognise reliably). */
export const SYNTH_SOUNDS = {
  smoke: { label: "Smoke alarm", make: smokeAlarm },
  co: { label: "CO alarm", make: coAlarm },
  doorbell: { label: "Doorbell", make: doorbell },
  knock: { label: "Knocking", make: knock },
  siren: { label: "Siren", make: siren },
  baby: { label: "Baby crying", make: babyCry },
  phone: { label: "Phone ringing", make: phoneRing },
  beep: { label: "Appliance beep", make: applianceBeep },
};

/**
 * The listener's Test sounds panel. Alarms are synthesised exactly to standard (T3/T4) and the rest are
 * short CC0 recordings (public/sounds/CREDITS.md): a synthesised knock or cry does not fool YAMNet, and
 * a demo button that does nothing would be worse than none.
 */
export const TEST_SOUNDS = {
  smoke: { label: "Smoke alarm", make: smokeAlarm },
  co: { label: "CO alarm", make: coAlarm },
  knock: { label: "Knocking", url: "sounds/knock.wav" },
  baby: { label: "Baby crying", url: "sounds/baby.wav" },
  glass: { label: "Glass breaking", url: "sounds/glass.wav" },
  dog: { label: "Dog barking", url: "sounds/dog.wav" },
  siren: { label: "Siren", make: siren },
  horn: { label: "Car horn", url: "sounds/horn.wav" },
  beep: { label: "Timer beep", make: applianceBeep },
};

/** Encode mono float samples as a 16-bit PCM WAV (for Chrome's fake-microphone test input). */
export function toWav(samples, sr = SR) {
  const buf = new ArrayBuffer(44 + samples.length * 2);
  const v = new DataView(buf);
  const w = (o, s) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  w(0, "RIFF");
  v.setUint32(4, 36 + samples.length * 2, true);
  w(8, "WAVE");
  w(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, sr, true);
  v.setUint32(28, sr * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  w(36, "data");
  v.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) v.setInt16(44 + i * 2, Math.max(-1, Math.min(1, samples[i])) * 32767, true);
  return new Uint8Array(buf);
}
