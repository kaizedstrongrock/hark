// Wire-format constants shared with the hub (lib/validate.js - a unit test keeps them identical),
// plus helpers for the codes and addresses people type in. Pure module.

export const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no I, O, 0, 1
export const CODE_RE = new RegExp(`^[${CODE_ALPHABET}]{6}$`);
export const DEVICE_ID_RE = /^[A-Za-z0-9_-]{6,40}$/;
export const MESSAGE_ID_RE = /^[A-Za-z0-9_.-]{8,64}$/;
export const HUB_ID_RE = /^h-[a-f0-9]{8,32}$/;
export const DEVICE_KINDS = ["phone", "tablet", "computer"];
export const PROTOCOL = 2;
export const DEFAULT_PORT = 3000;

/** "k7q-4mx" -> "K7Q4MX"; null if it is not a valid home code. Look-alikes are forgiven (O->0 is not in the alphabet). */
export function normalizeCode(text) {
  const s = String(text || "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
  return CODE_RE.test(s) ? s : null;
}

/** "K7Q4MX" -> "K7Q-4MX" (easier to read out and type). */
export function formatCode(code) {
  return code ? `${code.slice(0, 3)}-${code.slice(3)}` : "";
}

const LOOPBACK = /^(localhost|127(?:\.\d{1,3}){3}|\[::1\])$/i;

export function isLoopbackUrl(url) {
  try {
    return LOOPBACK.test(new URL(url).hostname);
  } catch {
    return false;
  }
}

/**
 * Turn what someone typed ("192.168.1.20", "192.168.1.20:3000", "http://kitchen-pc.local:3000/") into a hub
 * base URL ("http://192.168.1.20:3000/"), or null.
 */
export function normalizeHubAddress(text) {
  let s = String(text || "").trim();
  if (!s) return null;
  if (!/^https?:\/\//i.test(s)) s = `http://${s}`;
  let u;
  try {
    u = new URL(s);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  if (u.username || u.password || u.search || u.hash || (u.pathname && u.pathname !== "/")) return null;
  if (!/^[A-Za-z0-9.\-]+$|^\[[0-9A-Fa-f:.]+\]$/.test(u.hostname)) return null;
  if (!u.port && u.protocol === "http:" && !/^https?:\/\/(\[[^\]]*\]|[^/:]+):\d+/i.test(s)) u.port = String(DEFAULT_PORT);
  return `${u.protocol}//${u.host}/`;
}

/** A short label for a hub address: "192.168.1.20:3000". */
export function hubLabel(url) {
  try {
    return new URL(url).host;
  } catch {
    return String(url || "");
  }
}
