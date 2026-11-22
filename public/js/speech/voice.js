// Speaks the Deaf user's replies at the listening device ("Coming! One minute").
// Uses ElevenLabs through the HARK server when it is configured, otherwise the device's own voice.

let serverVoice = null; // null = unknown, true/false after the first status check

export function setServerVoice(available) {
  serverVoice = !!available;
}

function chime() {
  try {
    const ctx = new AudioContext();
    const t = ctx.currentTime;
    for (const [f, d] of [[880, 0], [1320, 0.12]]) {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, t + d);
      g.gain.exponentialRampToValueAtTime(0.2, t + d + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + d + 0.3);
      o.connect(g).connect(ctx.destination);
      o.start(t + d);
      o.stop(t + d + 0.32);
    }
    setTimeout(() => ctx.close(), 600);
  } catch {
    /* audio unavailable */
  }
}

function speakLocal(text) {
  return new Promise((resolve) => {
    if (!("speechSynthesis" in globalThis)) return resolve(false);
    const u = new SpeechSynthesisUtterance(text);
    u.rate = 0.95;
    u.onend = () => resolve(true);
    u.onerror = () => resolve(false);
    speechSynthesis.cancel();
    speechSynthesis.speak(u);
    setTimeout(() => resolve(true), 15000);
  });
}

/** @returns {Promise<'elevenlabs'|'device'|'none'>} which voice was used */
export async function speak(text, { code } = {}) {
  chime();
  await new Promise((r) => setTimeout(r, 450));
  if (serverVoice && code) {
    try {
      const r = await fetch("/api/tts", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text, h: code }) });
      if (r.ok) {
        const url = URL.createObjectURL(await r.blob());
        const audio = new Audio(url);
        await audio.play();
        await new Promise((res) => {
          audio.onended = res;
          audio.onerror = res;
        });
        URL.revokeObjectURL(url);
        return "elevenlabs";
      }
    } catch {
      /* fall back to the device voice */
    }
  }
  return (await speakLocal(text)) ? "device" : "none";
}
