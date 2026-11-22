// On-device sound classification: Google's YAMNet (521 AudioSet classes) via MediaPipe Tasks Audio.
// Runs in WebAssembly on this device; audio is never uploaded.
const VENDOR = new URL("../../vendor/mediapipe/", import.meta.url);
const MODEL = new URL("../../models/yamnet.tflite", import.meta.url);

let loading = null;

/**
 * @returns {Promise<{classify: (x: Float32Array) => Float32Array, labels: string[], ms: () => number}>}
 */
export function loadYamnet() {
  loading ||= (async () => {
    const { AudioClassifier, FilesetResolver } = await import(new URL("audio_bundle.mjs", VENDOR).href);
    const fileset = await FilesetResolver.forAudioTasks(new URL("wasm", VENDOR).href);
    const clf = await AudioClassifier.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: MODEL.href },
      maxResults: -1,
    });
    const first = clf.classify(new Float32Array(15600), 16000)[0].classifications[0].categories;
    const labels = [];
    for (const c of first) labels[c.index] = c.categoryName;
    let lastMs = 0;
    return {
      labels,
      ms: () => lastMs,
      classify(x) {
        const t = performance.now();
        const res = clf.classify(x, 16000);
        const out = new Float32Array(labels.length);
        // a 0.975 s window yields one result; if more come back, keep the max per class
        for (const r of res) for (const c of r.classifications[0].categories) if (c.score > out[c.index]) out[c.index] = c.score;
        lastMs = performance.now() - t;
        return out;
      },
    };
  })();
  loading.catch(() => {
    loading = null;
  });
  return loading;
}
