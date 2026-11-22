#!/usr/bin/env node
// Step 1 of the benchmark: run the real YAMNet model (MediaPipe, in headless Chromium - exactly what
// the app runs) over every ESC-50 clip with the app's windowing, and cache the scores.
//
//   node bench/yamnet-cache.mjs --esc50 /path/to/ESC-50-master
//
// Output: bench/cache/yamnet-esc50.json  { labels, clips: [{file, fold, category, windows: base64 Uint8 scores}] }
// ESC-50: K. J. Piczak, "ESC: Dataset for Environmental Sound Classification", ACM MM 2015 (CC BY-NC 3.0).
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { createServer } from "../server.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const args = Object.fromEntries(process.argv.slice(2).map((a, i, all) => (a.startsWith("--") ? [a.slice(2), all[i + 1]] : null)).filter(Boolean));
const ESC = args.esc50 || process.env.ESC50_DIR;
if (!ESC || !fs.existsSync(path.join(ESC, "meta/esc50.csv"))) {
  console.error("Usage: node bench/yamnet-cache.mjs --esc50 /path/to/ESC-50-master");
  process.exit(2);
}
const OUT = path.join(HERE, "cache/yamnet-esc50.json");
fs.mkdirSync(path.dirname(OUT), { recursive: true });

const rows = fs
  .readFileSync(path.join(ESC, "meta/esc50.csv"), "utf8")
  .trim()
  .split("\n")
  .slice(1)
  .map((l) => {
    const [filename, fold, target, category] = l.split(",");
    return { file: filename, fold: Number(fold), category };
  });

// A throwaway web root: the app's public files plus the ESC-50 audio folder.
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "hark-bench-"));
for (const d of ["vendor", "models", "js"]) fs.symlinkSync(path.join(ROOT, "public", d), path.join(tmpRoot, d));
fs.symlinkSync(path.join(ESC, "audio"), path.join(tmpRoot, "esc50"));
fs.writeFileSync(path.join(tmpRoot, "index.html"), "<!doctype html><title>bench</title>");

const server = createServer({ root: tmpRoot });
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;
const launchEnv = process.env.HARK_BROWSER_LIBS ? { ...process.env, LD_LIBRARY_PATH: process.env.HARK_BROWSER_LIBS } : process.env;
const browser = await chromium.launch({ env: launchEnv });
const page = await browser.newPage();
await page.goto(`http://127.0.0.1:${port}/`);
const labels = await page.evaluate(async () => {
  const { AudioClassifier, FilesetResolver } = await import("/vendor/mediapipe/audio_bundle.mjs");
  const fileset = await FilesetResolver.forAudioTasks("/vendor/mediapipe/wasm");
  window.clf = await AudioClassifier.createFromOptions(fileset, { baseOptions: { modelAssetPath: "/models/yamnet.tflite" }, maxResults: -1 });
  window.dsp = await import("/js/core/dsp.js");
  const cats = window.clf.classify(new Float32Array(15600), 16000)[0].classifications[0].categories;
  const labels = [];
  for (const c of cats) labels[c.index] = c.categoryName;
  return labels;
});
console.log(`YAMNet loaded (${labels.length} classes). Scoring ${rows.length} clips...`);

const clips = [];
const BATCH = 100;
const t0 = Date.now();
for (let b = 0; b < rows.length; b += BATCH) {
  const batch = rows.slice(b, b + BATCH);
  const res = await page.evaluate(async (files) => {
    const out = [];
    for (const f of files) {
      const bytes = new Uint8Array(await (await fetch(`/esc50/${f}`)).arrayBuffer());
      const { samples, sr } = window.dsp.decodeWav(bytes);
      const x = window.dsp.resample(samples, sr, 16000);
      const windows = [];
      // identical windowing to Listener: windows end at 16000 + 8000k samples
      for (let end = 16000; end <= x.length; end += 8000) {
        const w = x.slice(end - 15600, end);
        const cats = window.clf.classify(w, 16000)[0].classifications[0].categories;
        const q = new Uint8Array(cats.length);
        for (const c of cats) q[c.index] = Math.round(c.score * 255);
        windows.push(q);
      }
      const flat = new Uint8Array(windows.length * (windows[0]?.length || 0));
      windows.forEach((w, i) => flat.set(w, i * w.length));
      let bin = "";
      for (let i = 0; i < flat.length; i++) bin += String.fromCharCode(flat[i]);
      out.push({ n: windows.length, b64: btoa(bin) });
    }
    return out;
  }, batch.map((r) => r.file));
  res.forEach((r, i) => clips.push({ ...batch[i], nWindows: r.n, scores: r.b64 }));
  process.stdout.write(`\r  ${clips.length}/${rows.length} clips (${((Date.now() - t0) / 1000).toFixed(0)} s)`);
}
console.log();
fs.writeFileSync(OUT, JSON.stringify({ model: "yamnet float32 v1 (MediaPipe)", labels, clips }));
console.log(`Cached YAMNet scores -> ${path.relative(ROOT, OUT)}`);
await browser.close();
server.close();
fs.rmSync(tmpRoot, { recursive: true, force: true });
