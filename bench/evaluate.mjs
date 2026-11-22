#!/usr/bin/env node
// Step 2 of the benchmark (pure Node, uses the app's own modules):
//   A. Built-in alerts: tune each alert's threshold/hits on ESC-50 folds 1-3, report on held-out folds 4-5.
//   B. Alarm cadence (T3/T4): false triggers across all 2,000 real-world clips.
//   C. "Teach HARK a sound" few-shot learning: 3 recordings -> detect the other clips of that class.
//
//   node bench/evaluate.mjs --esc50 /path/to/ESC-50-master [--write]
// --write updates bench/results/*.json (committed alongside the code).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ALERTS, AlertEngine } from "../public/js/core/alerts.js";
import { decodeWav, resample, FrameAnalyzer, rms, toDb } from "../public/js/core/dsp.js";
import { CadenceDetector } from "../public/js/core/cadence.js";
import { embed, trainCustom, matchCustom } from "../public/js/core/custom.js";
import { WINDOW } from "../public/js/core/pipeline.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const args = Object.fromEntries(process.argv.slice(2).map((a, i, all) => (a.startsWith("--") ? [a.slice(2), all[i + 1] && !all[i + 1].startsWith("--") ? all[i + 1] : true] : null)).filter(Boolean));
const ESC = args.esc50 || process.env.ESC50_DIR;
const cache = JSON.parse(fs.readFileSync(path.join(HERE, "cache/yamnet-esc50.json"), "utf8"));
const labels = cache.labels;
const L = labels.length;

// ESC-50 category -> the built-in alert that should fire for it
const EXPECT = {
  crying_baby: "baby",
  door_wood_knock: "knock",
  siren: "siren",
  clock_alarm: "alarm",
  glass_breaking: "glass",
  dog: "dog",
  car_horn: "horn",
  cat: "cat",
};

// ---------------------------------------------------------------------------------------------
// Load audio once: per-window audio + level/floor + cadence state + YAMNet scores
console.log("Decoding 2,000 clips and running the DSP front end...");
const t0 = Date.now();
const clips = cache.clips.map((c) => {
  const bin = Buffer.from(c.scores, "base64");
  const windows = [];
  for (let w = 0; w < c.nWindows; w++) {
    const s = new Float32Array(L);
    for (let k = 0; k < L; k++) s[k] = bin[w * L + k] / 255;
    windows.push({ scores: s });
  }
  return { ...c, windows };
});
for (const c of clips) {
  const { samples, sr } = decodeWav(new Uint8Array(fs.readFileSync(path.join(ESC, "audio", c.file))));
  const x = resample(samples, sr, 16000);
  c.audio = x;
  const det = new CadenceDetector({ frameStep: 320 / 16000 });
  let last = null;
  const fa = new FrameAnalyzer({ onFrame: (f) => { last = f; det.push(f); } });
  let pos = 0;
  c.windows.forEach((w, i) => {
    const end = 16000 + 8000 * i;
    fa.push(x.subarray(pos, end));
    pos = end;
    w.end = end;
    w.cadence = det.detect();
    w.levelDb = toDb(rms(x, end - WINDOW, end));
    w.floorDb = last ? last.floorDb : -70;
  });
}
console.log(`  done in ${((Date.now() - t0) / 1000).toFixed(1)} s`);

// ---------------------------------------------------------------------------------------------
// A. Built-in alerts
const scoreMap = (s) => {
  const m = new Map();
  for (let k = 0; k < L; k++) m.set(labels[k], s[k]);
  return m;
};
for (const c of clips) for (const w of c.windows) w.map = scoreMap(w.scores);

const SILENCE = new Map();
function firedFor(clip) {
  const engine = new AlertEngine({ enabled: { speech: false } });
  const kinds = new Set();
  for (const w of clip.windows) {
    for (const p of engine.tick({ t: w.end / 16000, scores: w.map, cadence: w.cadence })) kinds.add(p.kind);
  }
  // listening is continuous: give held alerts (e.g. the 4 s beep hold) 5 s of quiet after the 5 s clip
  const last = clip.windows[clip.windows.length - 1];
  for (let k = 1; k <= 10; k++) {
    for (const p of engine.tick({ t: last.end / 16000 + k * 0.5, scores: SILENCE, cadence: last.cadence })) kinds.add(p.kind);
  }
  return kinds;
}

const tunable = Object.values(EXPECT);
const train = clips.filter((c) => c.fold <= 3);
const test = clips.filter((c) => c.fold >= 4);

function metricsFor(set, alertId) {
  let tp = 0, fn = 0, fp = 0, tn = 0;
  for (const c of set) {
    const fired = c._fired.has(alertId);
    const positive = EXPECT[c.category] === alertId;
    if (positive && fired) tp++;
    else if (positive) fn++;
    else if (fired) fp++;
    else tn++;
  }
  return { tp, fn, fp, tn, recall: tp / Math.max(1, tp + fn), precision: tp / Math.max(1, tp + fp), fpr: fp / Math.max(1, fp + tn) };
}

const tuned = {};
const GRID = [0.15, 0.2, 0.25, 0.3, 0.35, 0.4, 0.45, 0.5, 0.6, 0.7];
for (const id of tunable) {
  const a = ALERTS.find((x) => x.id === id);
  const beta = a.priority === "urgent" ? 2 : 1;
  let best = null;
  for (const threshold of GRID) {
    for (const hits of [1, 2]) {
      a.threshold = threshold;
      a.hits = hits;
      for (const c of train) c._fired = firedFor(c);
      const m = metricsFor(train, id);
      const f = ((1 + beta * beta) * m.precision * m.recall) / Math.max(1e-9, beta * beta * m.precision + m.recall);
      // tie-break towards fewer false alarms
      if (!best || f > best.f + 1e-9 || (Math.abs(f - best.f) <= 1e-9 && m.fpr < best.m.fpr)) best = { threshold, hits, f, m };
    }
  }
  a.threshold = best.threshold;
  a.hits = best.hits;
  tuned[id] = { threshold: best.threshold, hits: best.hits, trainF: Number(best.f.toFixed(3)) };
}
for (const c of clips) c._fired = firedFor(c);

const alertRows = tunable.map((id) => {
  const m = metricsFor(test, id);
  return { alert: id, esc50: Object.keys(EXPECT).find((k) => EXPECT[k] === id), ...tuned[id], recall: m.recall, precision: m.precision, falseAlarmRate: m.fpr, tp: m.tp, fn: m.fn, fp: m.fp };
});
const negatives = test.filter((c) => !EXPECT[c.category]);
const anyFalse = negatives.filter((c) => c._fired.size > 0);
const byCause = {};
for (const c of anyFalse) for (const k of c._fired) byCause[`${c.category} -> ${k}`] = (byCause[`${c.category} -> ${k}`] || 0) + 1;

// ---------------------------------------------------------------------------------------------
// B. Cadence false triggers on real sounds (all folds)
const cad = { T3: { one: [], two: [] }, T4: { one: [], two: [] } };
for (const c of clips) {
  for (const p of ["T3", "T4"]) {
    const maxCycles = Math.max(...c.windows.map((w) => w.cadence[p].cycles));
    if (maxCycles >= 1) cad[p].one.push(c.category);
    if (maxCycles >= 2) cad[p].two.push(c.category);
  }
}
const smokeOrCoFalse = clips.filter((c) => c._fired.has("smoke") || c._fired.has("co")).map((c) => c.category);

// ---------------------------------------------------------------------------------------------
// C. Few-shot custom sounds
console.log("Embedding windows for the few-shot experiment...");
const t1 = Date.now();
for (const c of clips) {
  for (const w of c.windows) w.emb = embed(c.audio.slice(w.end - WINDOW, w.end), w.scores);
}
console.log(`  done in ${((Date.now() - t1) / 1000).toFixed(1)} s`);

function rngFactory(seed) {
  let s = seed;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}
function sample(arr, n, rand) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a.slice(0, n);
}
const categories = [...new Set(clips.map((c) => c.category))].sort();
const byCat = Object.fromEntries(categories.map((k) => [k, clips.filter((c) => c.category === k)]));
const TRIALS = Number(args.trials || 5);
const CUSTOM_CFG = { negQuantile: Number(args.negq || 0.98), mix: Number(args.mix || 0.5), hits: Number(args.chits || 2) };
const perClass = {};
let totTP = 0, totFN = 0, totFP = 0, totTN = 0;
const t2 = Date.now();
for (const [ci, cat] of categories.entries()) {
  const stats = { tp: 0, fn: 0, fp: 0, tn: 0, poor: 0 };
  for (let trial = 0; trial < TRIALS; trial++) {
    const rand = rngFactory(1000 * ci + trial + 1);
    const pos = sample(byCat[cat], 3, rand);
    const rest = byCat[cat].filter((c) => !pos.includes(c));
    const others = clips.filter((c) => c.category !== cat);
    const bg = sample(others, 10, rand); // "what this home normally sounds like"
    const negTest = sample(others.filter((c) => !bg.includes(c)), 200, rand);
    // training windows: loud windows of each recording, embedded with that window's YAMNet scores
    const groups = pos.map((c) => {
      const keep = [];
      const loudest = Math.max(...c.windows.map((w) => w.levelDb));
      for (const w of c.windows) if (w.levelDb >= Math.max(w.floorDb + 6, loudest - 15)) keep.push(w.emb);
      return keep;
    });
    const negEmb = bg.flatMap((c) => c.windows.map((w) => w.emb));
    const model = trainCustom(groups, negEmb, CUSTOM_CFG);
    if (model.quality === "poor") stats.poor++;
    const detect = (c) => {
      let run = 0;
      for (const w of c.windows) {
        const ok = w.levelDb >= w.floorDb + 6 && w.levelDb > -55 && matchCustom(model, w.emb).match;
        run = ok ? run + 1 : 0;
        if (run >= CUSTOM_CFG.hits) return true;
      }
      return false;
    };
    for (const c of rest) detect(c) ? stats.tp++ : stats.fn++;
    for (const c of negTest) detect(c) ? stats.fp++ : stats.tn++;
  }
  perClass[cat] = { recall: stats.tp / (stats.tp + stats.fn), fpr: stats.fp / (stats.fp + stats.tn), poorTrainings: stats.poor };
  totTP += stats.tp; totFN += stats.fn; totFP += stats.fp; totTN += stats.tn;
}
console.log(`  few-shot trials done in ${((Date.now() - t2) / 1000).toFixed(1)} s`);
const fewShot = {
  shots: 3,
  config: CUSTOM_CFG,
  trialsPerClass: TRIALS,
  classes: categories.length,
  recall: totTP / (totTP + totFN),
  falsePositiveRate: totFP / (totFP + totTN),
  perClass,
};

// ---------------------------------------------------------------------------------------------
const pct = (x) => `${(100 * x).toFixed(1)}%`;
console.log("\nA. Built-in alerts on held-out ESC-50 folds 4-5 (thresholds tuned on folds 1-3)\n");
console.log("| Alert | ESC-50 class | threshold / hits | Recall | Precision | False-alarm rate |");
console.log("|---|---|---|---|---|---|");
for (const r of alertRows) console.log(`| ${r.alert} | ${r.esc50} | ${r.threshold} / ${r.hits} | ${pct(r.recall)} (${r.tp}/${r.tp + r.fn}) | ${pct(r.precision)} | ${pct(r.falseAlarmRate)} |`);
console.log(`\nClips of the other 42 everyday classes that triggered ANY page: ${anyFalse.length}/${negatives.length} (${pct(anyFalse.length / negatives.length)})`);
console.log("Most common false pages:", Object.entries(byCause).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, v]) => `${k} x${v}`).join(", ") || "none");
console.log("\nB. Alarm cadence on 2,000 real clips (none of which is a smoke or CO alarm):");
console.log(`  T3 >=1 cycle: ${cad.T3.one.length} clips ${JSON.stringify(count(cad.T3.one))}; >=2 cycles: ${cad.T3.two.length}`);
console.log(`  T4 >=1 cycle: ${cad.T4.one.length} clips ${JSON.stringify(count(cad.T4.one))}; >=2 cycles: ${cad.T4.two.length}`);
console.log(`  SMOKE/CO pages fired: ${smokeOrCoFalse.length} ${JSON.stringify(count(smokeOrCoFalse))}`);
console.log(`\nC. Teach-a-sound (3 recordings, ${categories.length} classes x ${TRIALS} trials): recall ${pct(fewShot.recall)}, false-positive rate ${pct(fewShot.falsePositiveRate)}`);
const sorted = Object.entries(perClass).sort((a, b) => b[1].recall - a[1].recall);
console.log("  best:", sorted.slice(0, 6).map(([k, v]) => `${k} ${pct(v.recall)}/${pct(v.fpr)}`).join(", "));
console.log("  worst:", sorted.slice(-6).map(([k, v]) => `${k} ${pct(v.recall)}/${pct(v.fpr)}`).join(", "));
console.log("\nRecommended alert settings:", JSON.stringify(tuned));

if (args.write) {
  const outDir = path.join(HERE, "results");
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(
    path.join(outDir, "esc50.json"),
    JSON.stringify(
      {
        dataset: "ESC-50 (Piczak 2015), 2,000 clips x 5 s, 50 classes; tune folds 1-3, test folds 4-5",
        model: cache.model,
        alerts: alertRows,
        tuned,
        negativesWithAnyPage: { count: anyFalse.length, of: negatives.length, rate: anyFalse.length / negatives.length, causes: byCause },
        cadence: { T3: { oneCycle: cad.T3.one.length, twoCycles: cad.T3.two.length }, T4: { oneCycle: cad.T4.one.length, twoCycles: cad.T4.two.length }, smokeOrCoPages: smokeOrCoFalse.length },
        fewShot,
      },
      null,
      2,
    ) + "\n",
  );
  console.log(`\nWrote ${path.relative(path.resolve(HERE, ".."), path.join(outDir, "esc50.json"))}`);
}

function count(list) {
  const m = {};
  for (const k of list) m[k] = (m[k] || 0) + 1;
  return m;
}
