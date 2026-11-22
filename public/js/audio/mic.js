// Microphone capture at 16 kHz mono. Echo cancellation, noise suppression and auto-gain are turned
// OFF on purpose: they are tuned for voice calls and would filter out alarms, knocks and beeps.
import { Resampler } from "../core/dsp.js";

/**
 * @param {{onAudio: (x: Float32Array) => void, onEnded?: () => void, deviceId?: string}} opts
 *   onEnded: the microphone went away (unplugged, permission revoked, taken by the system)
 * @returns {Promise<{stop: () => Promise<void>, sampleRate: number, label: string}>}
 */
export async function startMic({ onAudio, onEnded, deviceId }) {
  if (!navigator.mediaDevices?.getUserMedia) throw new Error("This browser cannot use the microphone here (HTTPS or localhost is required).");
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      deviceId: deviceId ? { exact: deviceId } : undefined,
      channelCount: 1,
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
    },
  });
  let ctx;
  let source;
  try {
    ctx = new AudioContext({ sampleRate: 16000 });
    source = ctx.createMediaStreamSource(stream);
  } catch {
    // some browsers refuse to mix sample rates: capture at the native rate and resample ourselves
    await ctx?.close().catch(() => {});
    ctx = new AudioContext();
    source = ctx.createMediaStreamSource(stream);
  }
  if (ctx.state === "suspended") {
    // Without a tap or click first, some browsers keep audio suspended (and resume() never settles).
    await Promise.race([ctx.resume().catch(() => {}), new Promise((r) => setTimeout(r, 2500))]);
    if (ctx.state !== "running") {
      stream.getTracks().forEach((t) => t.stop());
      await ctx.close().catch(() => {});
      const e = new Error("Tap Start listening to begin.");
      e.name = "NeedsGesture";
      throw e;
    }
  }
  const resampler = Math.round(ctx.sampleRate) === 16000 ? null : new Resampler(ctx.sampleRate, 16000);
  await ctx.audioWorklet.addModule(new URL("./capture-worklet.js", import.meta.url));
  const node = new AudioWorkletNode(ctx, "hark-capture", { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 1 });
  const mute = ctx.createGain();
  mute.gain.value = 0; // keep the graph running without playing the mic back
  node.port.onmessage = (e) => onAudio(resampler ? resampler.process(e.data) : e.data);
  source.connect(node);
  node.connect(mute).connect(ctx.destination);
  const track = stream.getAudioTracks()[0];
  let stopped = false;
  track?.addEventListener("ended", () => !stopped && onEnded?.());
  return {
    sampleRate: ctx.sampleRate,
    label: track?.label || "Microphone",
    async stop() {
      stopped = true;
      node.port.onmessage = null;
      source.disconnect();
      node.disconnect();
      stream.getTracks().forEach((t) => t.stop());
      await ctx.close().catch(() => {});
    },
  };
}

/** Play samples through the speakers (for "play test sound out loud"). */
export async function playSamples(samples, sr = 16000) {
  const ctx = new AudioContext();
  const buf = ctx.createBuffer(1, samples.length, sr);
  buf.copyToChannel(samples, 0);
  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.connect(ctx.destination);
  src.start();
  await new Promise((r) => (src.onended = r));
  await ctx.close();
}
