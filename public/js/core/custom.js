// "Teach HARK a sound": few-shot custom sound recognition.
// Every doorbell, microwave and washing machine sounds different, and nobody else's model knows
// *your* dryer. The user records 3 short examples; we embed each 0.975 s window and recognise the
// sound later by nearest-neighbour similarity with a threshold calibrated on their own recordings
// (leave-one-recording-out) against background audio from their home.
// Pure module.
import { FFT, hann, melFilterbank, applyFilterbank, tonalPeak, rms } from "./dsp.js";

const N_FFT = 512;
const HOP = 256;
const N_MELS = 40;
const PEAK_BINS = 24;
const RHYTHM_LAGS = 16;
const WEIGHTS = { mel: 1.0, peaks: 0.6, rhythm: 0.4, yamnet: 0.9 };

let fft;
let filters;

function l2(v) {
  let s = 0;
  for (const x of v) s += x * x;
  const n = Math.sqrt(s);
  if (n > 0) for (let i = 0; i < v.length; i++) v[i] /= n;
  return v;
}

export function dot(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

/**
 * Embed one analysis window.
 * @param {Float32Array} x 16 kHz samples (~15600)
 * @param {Float32Array|number[]|null} yamnetScores scores for the 521 YAMNet classes (index order), or null
 * @returns {Float32Array} unit-length embedding
 */
export function embed(x, yamnetScores = null, sr = 16000) {
  fft ||= new FFT(N_FFT);
  filters ||= melFilterbank(N_FFT, sr, N_MELS, 60, 7800);
  const win = hann(N_FFT);
  const frame = new Float32Array(N_FFT);
  const mag = new Float32Array(N_FFT / 2 + 1);
  const mel = new Float32Array(N_MELS);
  const sum = new Float64Array(N_MELS);
  const sumSq = new Float64Array(N_MELS);
  const peaks = new Float32Array(PEAK_BINS);
  const env = [];
  let frames = 0;
  for (let start = 0; start + N_FFT <= x.length; start += HOP) {
    for (let i = 0; i < N_FFT; i++) frame[i] = x[start + i] * win[i];
    fft.magnitude(frame, mag);
    applyFilterbank(mag, filters, mel);
    for (let m = 0; m < N_MELS; m++) {
      sum[m] += mel[m];
      sumSq[m] += mel[m] * mel[m];
    }
    const p = tonalPeak(mag, sr, N_FFT, 200, 7800);
    if (p.prominence >= 8) {
      const bin = Math.max(0, Math.min(PEAK_BINS - 1, Math.floor((Math.log(p.freq / 200) / Math.log(7800 / 200)) * PEAK_BINS)));
      peaks[bin] += Math.log(p.prominence);
    }
    env.push(rms(x, start, start + N_FFT));
    frames++;
  }
  const melStats = new Float32Array(N_MELS * 2);
  if (frames) {
    let meanAll = 0;
    for (let m = 0; m < N_MELS; m++) meanAll += sum[m] / frames;
    meanAll /= N_MELS;
    for (let m = 0; m < N_MELS; m++) {
      const mean = sum[m] / frames;
      melStats[m] = mean - meanAll; // level-invariant spectral shape
      melStats[N_MELS + m] = Math.sqrt(Math.max(0, sumSq[m] / frames - mean * mean));
    }
  }
  // rhythm: normalised autocorrelation of the energy envelope
  const rhythm = new Float32Array(RHYTHM_LAGS);
  if (env.length > RHYTHM_LAGS + 2) {
    const mean = env.reduce((a, b) => a + b, 0) / env.length;
    const d = env.map((v) => v - mean);
    const zero = d.reduce((a, b) => a + b * b, 0) || 1;
    for (let lag = 1; lag <= RHYTHM_LAGS; lag++) {
      let s = 0;
      for (let i = lag; i < d.length; i++) s += d[i] * d[i - lag];
      rhythm[lag - 1] = s / zero;
    }
  }
  const parts = [
    [l2(melStats), WEIGHTS.mel],
    [l2(peaks), WEIGHTS.peaks],
    [l2(rhythm), WEIGHTS.rhythm],
  ];
  if (yamnetScores) {
    const y = new Float32Array(yamnetScores.length);
    for (let i = 0; i < y.length; i++) y[i] = Math.log(yamnetScores[i] + 0.01) - Math.log(0.01);
    parts.push([l2(y), WEIGHTS.yamnet]);
  }
  const total = parts.reduce((n, [v]) => n + v.length, 0);
  const out = new Float32Array(total);
  let o = 0;
  for (const [v, w] of parts) {
    for (let i = 0; i < v.length; i++) out[o + i] = v[i] * w;
    o += v.length;
  }
  return l2(out);
}

function quantile(xs, q) {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const pos = (s.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return s[lo] + (s[hi] - s[lo]) * (pos - lo);
}

/**
 * Train a detector.
 * @param {Float32Array[][]} positives embeddings grouped by recording (at least 1 recording, ideally 3)
 * @param {Float32Array[]} negatives embeddings of background / other sounds from the same home
 * @returns {{exemplars: Float32Array[], negatives: Float32Array[], threshold: number, margin: number, quality: 'good'|'ok'|'poor'}}
 */
export function trainCustom(positives, negatives = [], { posQuantile = 0.25, negQuantile = 0.98, mix = 0.5 } = {}) {
  const groups = positives.filter((g) => g.length);
  if (!groups.length) throw new Error("No usable audio in the recordings - try again a little closer to the sound.");
  const exemplars = groups.flat();
  // leave-one-recording-out similarity for each positive window
  const P = [];
  groups.forEach((g, gi) => {
    const others = groups.length > 1 ? groups.filter((_, k) => k !== gi).flat() : null;
    g.forEach((e, ei) => {
      const pool = others || g.filter((_, k) => k !== ei);
      if (pool.length) P.push(Math.max(...pool.map((x) => dot(e, x))));
    });
  });
  const N = negatives.map((e) => Math.max(...exemplars.map((x) => dot(e, x))));
  const pLow = P.length ? quantile(P, posQuantile) : 0.9;
  const nHigh = N.length ? quantile(N, negQuantile) : 0.5;
  const margin = pLow - nHigh;
  // threshold sits between "how similar your recordings are to each other" and "how similar your
  // home's background is to them"; mix < 0.5 favours recall, > 0.5 favours fewer false pages
  const threshold = Math.min(0.97, Math.max(0.55, N.length ? nHigh + mix * (pLow - nHigh) : pLow - 0.05));
  const quality = margin >= 0.08 ? "good" : margin >= 0.02 ? "ok" : "poor";
  return { exemplars, negatives: negatives.slice(-80), threshold, margin, quality };
}

/** @returns {{score: number, negScore: number, match: boolean}} */
export function matchCustom(model, e) {
  let score = -1;
  for (const x of model.exemplars) score = Math.max(score, dot(e, x));
  let negScore = -1;
  for (const x of model.negatives) negScore = Math.max(negScore, dot(e, x));
  return { score, negScore, match: score >= model.threshold && score - negScore >= 0.01 };
}

/** Compact JSON form for localStorage (arrays of rounded numbers). */
export function serializeModel(m) {
  const pack = (v) => Array.from(v, (x) => Math.round(x * 1e4) / 1e4);
  return { v: 1, exemplars: m.exemplars.map(pack), negatives: m.negatives.map(pack), threshold: m.threshold, margin: m.margin, quality: m.quality };
}

export function deserializeModel(o) {
  if (!o || o.v !== 1) return null;
  return {
    exemplars: o.exemplars.map((a) => Float32Array.from(a)),
    negatives: o.negatives.map((a) => Float32Array.from(a)),
    threshold: o.threshold,
    margin: o.margin,
    quality: o.quality,
  };
}
