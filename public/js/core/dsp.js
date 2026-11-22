// Signal-processing building blocks. Pure module (runs in browsers, Node tests and the benchmark).

export const SR = 16000;

/** In-place iterative radix-2 FFT of size n (power of two) on separate real/imag arrays. */
export class FFT {
  constructor(n) {
    if (n & (n - 1)) throw new Error("FFT size must be a power of two");
    this.n = n;
    this.rev = new Uint32Array(n);
    const bits = Math.log2(n);
    for (let i = 0; i < n; i++) {
      let r = 0;
      for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b);
      this.rev[i] = r;
    }
    this.cos = new Float64Array(n / 2);
    this.sin = new Float64Array(n / 2);
    for (let i = 0; i < n / 2; i++) {
      this.cos[i] = Math.cos((2 * Math.PI * i) / n);
      this.sin[i] = -Math.sin((2 * Math.PI * i) / n);
    }
    this.re = new Float64Array(n);
    this.im = new Float64Array(n);
  }

  /** Magnitude spectrum (n/2 + 1 bins) of a real frame (already windowed). */
  magnitude(frame, out = new Float32Array(this.n / 2 + 1)) {
    const { n, re, im, rev } = this;
    for (let i = 0; i < n; i++) {
      re[rev[i]] = i < frame.length ? frame[i] : 0;
      im[rev[i]] = 0;
    }
    for (let size = 2; size <= n; size <<= 1) {
      const half = size >> 1;
      const step = n / size;
      for (let start = 0; start < n; start += size) {
        for (let k = 0; k < half; k++) {
          const c = this.cos[k * step];
          const s = this.sin[k * step];
          const a = start + k;
          const b = a + half;
          const tr = re[b] * c - im[b] * s;
          const ti = re[b] * s + im[b] * c;
          re[b] = re[a] - tr;
          im[b] = im[a] - ti;
          re[a] += tr;
          im[a] += ti;
        }
      }
    }
    for (let k = 0; k <= n / 2; k++) out[k] = Math.hypot(re[k], im[k]);
    return out;
  }
}

const hannCache = new Map();
export function hann(n) {
  let w = hannCache.get(n);
  if (!w) {
    w = new Float32Array(n);
    for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
    hannCache.set(n, w);
  }
  return w;
}

const hzToMel = (f) => 2595 * Math.log10(1 + f / 700);
const melToHz = (m) => 700 * (10 ** (m / 2595) - 1);

/** Triangular mel filters as sparse rows: [{start, weights: Float32Array}] */
export function melFilterbank(nFft, sr, nMels = 40, fMin = 60, fMax = sr / 2) {
  const bins = nFft / 2 + 1;
  const mMin = hzToMel(fMin);
  const mMax = hzToMel(fMax);
  const pts = [];
  for (let i = 0; i < nMels + 2; i++) pts.push(melToHz(mMin + ((mMax - mMin) * i) / (nMels + 1)));
  const binHz = sr / nFft;
  const filters = [];
  for (let m = 1; m <= nMels; m++) {
    const lo = pts[m - 1];
    const mid = pts[m];
    const hi = pts[m + 1];
    const start = Math.max(0, Math.floor(lo / binHz));
    const end = Math.min(bins - 1, Math.ceil(hi / binHz));
    const weights = new Float32Array(end - start + 1);
    for (let k = start; k <= end; k++) {
      const f = k * binHz;
      let w = 0;
      if (f >= lo && f <= mid) w = (f - lo) / (mid - lo || 1);
      else if (f > mid && f <= hi) w = (hi - f) / (hi - mid || 1);
      weights[k - start] = Math.max(0, w);
    }
    filters.push({ start, weights });
  }
  return filters;
}

export function applyFilterbank(mag, filters, out = new Float32Array(filters.length)) {
  for (let m = 0; m < filters.length; m++) {
    const { start, weights } = filters[m];
    let s = 0;
    for (let k = 0; k < weights.length; k++) s += weights[k] * mag[start + k] * mag[start + k];
    out[m] = Math.log10(s + 1e-10);
  }
  return out;
}

export function rms(x, start = 0, end = x.length) {
  let s = 0;
  for (let i = start; i < end; i++) s += x[i] * x[i];
  return Math.sqrt(s / Math.max(1, end - start));
}

export const toDb = (v) => 20 * Math.log10(Math.max(v, 1e-9));

/**
 * Strongest spectral peak between fLo and fHi.
 * prominence = peak magnitude / median magnitude in the band (a pure tone is >> 10).
 */
export function tonalPeak(mag, sr, nFft, fLo = 400, fHi = 5000) {
  const binHz = sr / nFft;
  const lo = Math.max(1, Math.floor(fLo / binHz));
  const hi = Math.min(mag.length - 2, Math.ceil(fHi / binHz));
  let best = lo;
  for (let k = lo; k <= hi; k++) if (mag[k] > mag[best]) best = k;
  const band = Array.from(mag.subarray(lo, hi + 1)).sort((a, b) => a - b);
  const median = band[Math.floor(band.length / 2)] || 1e-12;
  // parabolic interpolation for a finer frequency estimate
  const a = mag[best - 1];
  const b = mag[best];
  const c = mag[best + 1];
  const denom = a - 2 * b + c;
  const shift = denom ? (0.5 * (a - c)) / denom : 0;
  return { freq: (best + shift) * binHz, prominence: b / (median + 1e-12), peak: b };
}

/**
 * Streaming frame analyser. Push 16 kHz samples of any length; every `hop` samples it emits a frame:
 *   { t, levelDb, floorDb, peakHz, prominence, tonal }
 * `tonal` is true when a narrow peak stands well above both the band median and the noise floor:
 * the signature of a beep, an alarm or a chime.
 */
export class FrameAnalyzer {
  constructor({ sr = SR, nFft = 512, hop = 320, onFrame = () => {} } = {}) {
    this.sr = sr;
    this.nFft = nFft;
    this.hop = hop;
    this.fft = new FFT(nFft);
    this.win = hann(nFft);
    this.buf = new Float32Array(nFft); // ring buffer
    this.write = 0;
    this.filled = 0;
    this.sinceHop = 0;
    this.samples = 0;
    this.frame = new Float32Array(nFft);
    this.mag = new Float32Array(nFft / 2 + 1);
    this.floorDb = -70;
    this.onFrame = onFrame;
    this.frameRate = sr / hop;
  }

  push(chunk) {
    const n = this.nFft;
    for (let i = 0; i < chunk.length; i++) {
      this.buf[this.write] = chunk[i];
      this.write = (this.write + 1) % n;
      if (this.filled < n) this.filled++;
      this.samples++;
      this.sinceHop++;
      if (this.filled === n && this.sinceHop >= this.hop) {
        this.sinceHop = 0;
        this._emit();
      }
    }
  }

  _emit() {
    const { buf, frame, win, nFft } = this;
    let energy = 0;
    for (let i = 0; i < nFft; i++) {
      const v = buf[(this.write + i) % nFft]; // oldest -> newest
      energy += v * v;
      frame[i] = v * win[i];
    }
    const level = toDb(Math.sqrt(energy / nFft));
    this.fft.magnitude(frame, this.mag);
    const peak = tonalPeak(this.mag, this.sr, nFft);
    // noise floor: follow quickly downwards, creep slowly upwards (~3 dB/s)
    if (level < this.floorDb) this.floorDb = level;
    else this.floorDb += 3 / this.frameRate;
    this.floorDb = Math.max(-90, Math.min(this.floorDb, -10));
    const tonal = peak.prominence >= 12 && level >= this.floorDb + 12 && level > -60;
    this.onFrame({
      t: this.samples / this.sr,
      levelDb: level,
      floorDb: this.floorDb,
      peakHz: peak.freq,
      prominence: peak.prominence,
      tonal,
      mag: this.mag, // shared buffer: copy it if you keep it
    });
  }
}

/**
 * Streaming resampler (linear interpolation behind a 2-stage low-pass) for browsers whose
 * AudioContext cannot run at 16 kHz directly.
 */
export class Resampler {
  constructor(fromSr, toSr = SR) {
    this.ratio = fromSr / toSr;
    this.pos = 0;
    this.prev = 0;
    this.passthrough = Math.abs(fromSr - toSr) < 1;
    const fc = Math.min(0.45 * toSr, 0.45 * fromSr);
    this.lp = [biquadLowpass(fromSr, fc), biquadLowpass(fromSr, fc)];
  }

  process(input) {
    if (this.passthrough) return Float32Array.from(input);
    const x = new Float32Array(input.length);
    for (let i = 0; i < input.length; i++) {
      let v = input[i];
      for (const f of this.lp) v = f(v);
      x[i] = v;
    }
    const out = [];
    let pos = this.pos;
    while (pos < x.length) {
      const i = Math.floor(pos);
      const frac = pos - i;
      const a = i - 1 < 0 ? this.prev : x[i - 1];
      const b = x[i];
      out.push(a + (b - a) * frac);
      pos += this.ratio;
    }
    this.pos = pos - x.length;
    this.prev = x[x.length - 1] ?? this.prev;
    return Float32Array.from(out);
  }
}

function biquadLowpass(sr, fc, q = Math.SQRT1_2) {
  const w0 = (2 * Math.PI * fc) / sr;
  const alpha = Math.sin(w0) / (2 * q);
  const cos = Math.cos(w0);
  const a0 = 1 + alpha;
  const b0 = (1 - cos) / 2 / a0;
  const b1 = (1 - cos) / a0;
  const b2 = (1 - cos) / 2 / a0;
  const a1 = (-2 * cos) / a0;
  const a2 = (1 - alpha) / a0;
  let x1 = 0;
  let x2 = 0;
  let y1 = 0;
  let y2 = 0;
  return (x) => {
    const y = b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    x2 = x1;
    x1 = x;
    y2 = y1;
    y1 = y;
    return y;
  };
}

/** One-shot resample of a whole buffer. */
export function resample(x, fromSr, toSr = SR) {
  return new Resampler(fromSr, toSr).process(x);
}

/** Parse a 16-bit PCM (or 32-bit float) WAV file into mono float samples. */
export function decodeWav(bytes) {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (o) => String.fromCharCode(v.getUint8(o), v.getUint8(o + 1), v.getUint8(o + 2), v.getUint8(o + 3));
  if (tag(0) !== "RIFF" || tag(8) !== "WAVE") throw new Error("Not a WAV file");
  let o = 12;
  let fmt = null;
  while (o + 8 <= v.byteLength) {
    const id = tag(o);
    const size = v.getUint32(o + 4, true);
    const body = o + 8;
    if (id === "fmt ") {
      fmt = { format: v.getUint16(body, true), channels: v.getUint16(body + 2, true), sr: v.getUint32(body + 4, true), bits: v.getUint16(body + 14, true) };
    } else if (id === "data" && fmt) {
      const frames = Math.floor(size / (fmt.channels * (fmt.bits / 8)));
      const out = new Float32Array(frames);
      for (let i = 0; i < frames; i++) {
        let s = 0;
        for (let c = 0; c < fmt.channels; c++) {
          const p = body + (i * fmt.channels + c) * (fmt.bits / 8);
          if (fmt.bits === 16) s += v.getInt16(p, true) / 32768;
          else if (fmt.bits === 32 && fmt.format === 3) s += v.getFloat32(p, true);
          else if (fmt.bits === 24) s += ((v.getUint8(p) | (v.getUint8(p + 1) << 8) | (v.getInt8(p + 2) << 16)) / 8388608);
          else if (fmt.bits === 8) s += (v.getUint8(p) - 128) / 128;
          else throw new Error(`Unsupported WAV: ${fmt.bits}-bit format ${fmt.format}`);
        }
        out[i] = s / fmt.channels;
      }
      return { samples: out, sr: fmt.sr };
    }
    o = body + size + (size & 1);
  }
  throw new Error("WAV has no audio data");
}
