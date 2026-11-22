// Live captions + name spotting with the browser's speech recognition (Web Speech API).
// Note: in Chrome/Edge this sends speech audio to the browser vendor's recognition service, so it is
// off by default and clearly labelled. Sound alerts never depend on it and never leave the device.
import { findNames } from "../core/names.js";

const Recognition = globalThis.SpeechRecognition || globalThis.webkitSpeechRecognition;

export class Captions {
  static supported() {
    return !!Recognition;
  }

  /**
   * @param {{onText?: (text: string, final: boolean) => void, onName?: (name: string) => void,
   *          onState?: (state: string, detail?: string) => void, lang?: string}} opts
   */
  constructor(opts = {}) {
    this.onText = opts.onText || (() => {});
    this.onName = opts.onName || (() => {});
    this.onState = opts.onState || (() => {});
    this.lang = opts.lang || navigator.language || "en-US";
    this.names = [];
    this.wanted = false;
    this.rec = null;
    this.reported = new Map(); // result index -> Set(names) already reported
    this.failures = 0;
  }

  setNames(names) {
    this.names = names.filter(Boolean);
  }

  start() {
    if (!Recognition) {
      this.onState("unsupported");
      return;
    }
    this.wanted = true;
    this._open();
  }

  stop() {
    this.wanted = false;
    try {
      this.rec?.stop();
    } catch {
      /* already stopped */
    }
    this.rec = null;
    this.onState("off");
  }

  _open() {
    if (!this.wanted || this.rec) return;
    const rec = new Recognition();
    rec.continuous = true;
    rec.interimResults = true;
    rec.lang = this.lang;
    rec.onstart = () => {
      this.failures = 0;
      this.onState("on");
    };
    rec.onresult = (e) => {
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        const text = r[0].transcript.trim();
        if (!text) continue;
        this.onText(text, r.isFinal);
        const seen = this.reported.get(i) || new Set();
        for (const n of findNames(text, this.names)) {
          if (seen.has(n)) continue;
          seen.add(n);
          this.onName(n);
        }
        this.reported.set(i, seen);
      }
    };
    rec.onerror = (e) => {
      if (e.error === "not-allowed" || e.error === "service-not-allowed") {
        this.wanted = false;
        this.onState("blocked", "Microphone or speech service not allowed");
      } else if (e.error === "network") {
        this.failures++;
        this.onState("error", "Captions need an internet connection");
      } else if (e.error !== "no-speech" && e.error !== "aborted") {
        this.failures++;
        this.onState("error", e.error);
      }
    };
    rec.onend = () => {
      this.rec = null;
      this.reported.clear();
      if (this.wanted) setTimeout(() => this._open(), Math.min(10000, 300 * 2 ** this.failures));
      else this.onState("off");
    };
    this.rec = rec;
    try {
      rec.start();
    } catch {
      this.rec = null;
    }
  }
}
