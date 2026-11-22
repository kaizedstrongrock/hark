// Settings and history in localStorage. Nothing here ever leaves the device, except the device name and the
// home code, which the hubs of your own home network see.
import { CODE_ALPHABET, CODE_RE } from "./core/protocol.js";

const PREFIX = "hark.v2.";
const V1 = "hark.v1.";

function storage(kind = "localStorage") {
  try {
    return globalThis[kind] || null;
  } catch {
    return null; // storage disabled (privacy mode)
  }
}

function read(key, fallback) {
  try {
    const v = storage()?.getItem(PREFIX + key);
    return v === null || v === undefined ? fallback : JSON.parse(v);
  } catch {
    return fallback;
  }
}

function write(key, value) {
  try {
    storage()?.setItem(PREFIX + key, JSON.stringify(value));
  } catch {
    /* storage full or disabled: settings just won't persist */
  }
}

function random(alphabet, n) {
  const bytes = new Uint8Array(n);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => alphabet[b % alphabet.length]).join("");
}

export const newCode = () => random(CODE_ALPHABET, 6);

/** What kind of device this is (only used to pick an icon and a default name). */
export function detectKind(nav = globalThis.navigator) {
  const ua = nav?.userAgent || "";
  if (/iPad|Tablet|PlayBook|Silk/i.test(ua) || (/Android/i.test(ua) && !/Mobile/i.test(ua)) || (/Macintosh/.test(ua) && nav?.maxTouchPoints > 1)) return "tablet";
  if (/Mobi|iPhone|iPod|Android/i.test(ua)) return "phone";
  return "computer";
}

export const DEFAULT_NAMES = { phone: "My phone", tablet: "My tablet", computer: "My computer" };

const memoryIds = {};
/**
 * This device's id on the home network. Kept per browser tab (sessionStorage), so a reload keeps it while two
 * tabs - two listening devices - never knock each other off a hub.
 */
export function deviceId() {
  const key = `${PREFIX}deviceId`;
  const make = () => `d-${random("abcdefghijkmnopqrstuvwxyz23456789", 12)}`;
  try {
    const ss = storage("sessionStorage");
    let id = ss?.getItem(key);
    if (!id) {
      id = make();
      ss?.setItem(key, id);
    }
    return id || (memoryIds.id ||= make());
  } catch {
    return (memoryIds.id ||= make());
  }
}

/**
 * Make sure no other open tab of HARK uses the same device id: a duplicated browser tab copies sessionStorage,
 * and two connections with one id would keep knocking each other off the hub. A Web Lock per id is held for
 * as long as the page is open; if another tab holds it, this tab takes a new id.
 * @returns {Promise<string>}
 */
export async function claimDeviceId(id) {
  const locks = globalThis.navigator?.locks;
  if (!locks?.request) return id;
  const tryLock = (candidate) =>
    new Promise((resolve) => {
      locks
        .request(`hark-device:${candidate}`, { ifAvailable: true }, (lock) => {
          resolve(!!lock);
          return lock ? new Promise(() => {}) : undefined; // keep it until the page goes away
        })
        .catch(() => resolve(true));
    });
  let candidate = id;
  for (let i = 0; i < 5; i++) {
    if (await tryLock(candidate)) {
      if (candidate !== id) {
        try {
          globalThis.sessionStorage?.setItem(`${PREFIX}deviceId`, candidate);
        } catch {
          /* storage disabled */
        }
      }
      return candidate;
    }
    candidate = `d-${random("abcdefghijkmnopqrstuvwxyz23456789", 12)}`;
  }
  return candidate;
}

export const DEFAULT_SETTINGS = {
  sensitivity: "normal",
  enabled: {}, // alert id -> on/off (otherwise each alert's default)
  autoListen: true, // start listening when HARK opens (once the microphone has been allowed)
  showAlerts: true, // show alerts on this device (off for a device that only listens, e.g. in a nursery)
  vibrate: true,
  flash: true,
  tone: false, // a low (520 Hz) beep with each alert, for people who can hear low tones
  names: [],
  captions: false,
  doorSign: false,
  doorMessage: "Hello! The person who lives here is Deaf or hard of hearing. They are being alerted that you are here.",
  speakReplies: true,
  textSize: "normal", // normal | large | larger
  testMode: "feed", // feed | air (play test sounds out loud)
};

/** Bring settings over from HARK 1 (the pager version) once: taught sounds are precious. */
export function migrateV1() {
  const ls = storage();
  if (!ls || read("migrated", false)) return false;
  let moved = false;
  try {
    const v1 = (k) => {
      const v = ls.getItem(V1 + k);
      return v === null ? undefined : JSON.parse(v);
    };
    const code = v1("code") || v1("pagerCode");
    if (typeof code === "string" && CODE_RE.test(code) && !read("home", null)) {
      write("home", { code, joinedAt: Date.now() });
      moved = true;
    }
    const s = v1("settings");
    if (s && typeof s === "object") {
      const keep = ["sensitivity", "enabled", "names", "captions", "doorMessage", "speakReplies"];
      write("settings", { ...Object.fromEntries(keep.filter((k) => s[k] !== undefined).map((k) => [k, s[k]])), ...read("settings", {}) });
      if (typeof s.room === "string" && s.room.trim() && !read("device", null)) write("device", { name: s.room.trim().slice(0, 32) });
      moved = true;
    }
    const custom = v1("custom");
    if (Array.isArray(custom) && custom.length && !read("custom", null)) {
      write("custom", custom);
      moved = true;
    }
  } catch {
    /* unreadable old data: start fresh */
  }
  write("migrated", true);
  return moved;
}

export const store = {
  /** {code} of the home this device belongs to (created on first run). */
  /** {code, joinedAt} of the home this device belongs to (created on first run). */
  home() {
    let h = read("home", null);
    if (!h || !CODE_RE.test(h.code || "")) {
      h = { code: newCode(), joinedAt: Date.now() };
      write("home", h);
    }
    return h;
  },
  saveHome(h) {
    write("home", h);
  },
  device() {
    const kind = detectKind();
    const d = read("device", {});
    return { name: typeof d.name === "string" && d.name.trim() ? d.name : DEFAULT_NAMES[kind], kind, named: !!d.name };
  },
  saveDevice(patch) {
    write("device", { ...read("device", {}), ...patch });
  },
  hubs() {
    const v = read("hubs", []);
    return Array.isArray(v) ? v : [];
  },
  /** Ids of hubs the person removed (so other devices mentioning them do not bring them back). */
  forgottenHubs() {
    const v = read("forgottenHubs", []);
    return Array.isArray(v) ? v.filter((x) => typeof x === "string").slice(-20) : [];
  },
  saveForgottenHubs(list) {
    write("forgottenHubs", list.slice(-20));
  },
  saveHubs(list) {
    write("hubs", list);
  },
  cursors() {
    return read("cursors", {});
  },
  saveCursor(key, ts) {
    const c = read("cursors", {});
    c[key] = ts;
    const keys = Object.keys(c);
    if (keys.length > 40) for (const k of keys.slice(0, keys.length - 40)) delete c[k];
    write("cursors", c);
  },
  settings() {
    return { ...DEFAULT_SETTINGS, ...read("settings", {}) };
  },
  saveSettings(patch) {
    const next = { ...this.settings(), ...patch };
    write("settings", next);
    return next;
  },
  customSounds() {
    const v = read("custom", []);
    return Array.isArray(v) ? v : [];
  },
  saveCustomSounds(list) {
    write("custom", list);
  },
  events() {
    const v = read("events", []);
    return Array.isArray(v) ? v : [];
  },
  saveEvents(list) {
    write("events", list.slice(-100));
  },
};
