// Input validation for everything that crosses the network. Messages come from other devices on the
// home network, so every field is length-limited and type-checked here (and the app renders text with
// textContent only).

export const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no I, O, 0, 1
export const CODE_RE = new RegExp(`^[${CODE_ALPHABET}]{6}$`);
export const DEVICE_ID_RE = /^[A-Za-z0-9_-]{6,40}$/;
export const MESSAGE_ID_RE = /^[A-Za-z0-9_.-]{8,64}$/;
export const HUB_ID_RE = /^h-[a-f0-9]{8,32}$/;
export const KIND_RE = /^[a-z0-9_-]{1,24}$/;
export const DEVICE_KINDS = ["phone", "tablet", "computer"];
const PRIORITIES = ["urgent", "normal", "info"];
const MAX_HUBS = 8;
const MAX_HUB_URLS = 4;

export class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.status = 400;
  }
}

function fail(msg) {
  throw new ValidationError(msg);
}

/** Trim, strip control characters, enforce a max length. */
export function cleanText(value, max, { required = false, field = "text" } = {}) {
  if (value === undefined || value === null) {
    if (required) fail(`${field} is required`);
    return undefined;
  }
  if (typeof value !== "string") fail(`${field} must be a string`);
  const s = value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  if (required && !s) fail(`${field} is required`);
  if (s.length > max) fail(`${field} is too long (max ${max})`);
  return s;
}

/** The 6-character home code shared by every device of one home. */
export function checkCode(code) {
  if (typeof code !== "string" || !CODE_RE.test(code)) fail("Invalid home code");
  return code;
}

/** A device of the home network (phone, tablet or computer). */
export function checkDevice({ id, name, kind }) {
  if (typeof id !== "string" || !DEVICE_ID_RE.test(id)) fail("Invalid device id");
  const k = kind === undefined || kind === null || kind === "" ? "computer" : kind;
  if (!DEVICE_KINDS.includes(k)) fail("Invalid device kind");
  return { id, name: cleanText(name, 32, { field: "name" }) || "HARK device", kind: k };
}

/** Optional sender-generated message id (lets devices connected to several hubs drop duplicates). */
export function checkMessageId(mid) {
  if (mid === undefined || mid === null) return undefined;
  if (typeof mid !== "string" || !MESSAGE_ID_RE.test(mid)) fail("Invalid message id");
  return mid;
}

const LOOPBACK = /^(localhost|127(?:\.\d{1,3}){3}|\[::1\])$/i;

/**
 * A home hub address that other devices may connect to: http(s)://host[:port]/ with nothing else.
 * Loopback addresses are refused: "localhost" means a different machine on every device.
 */
export function checkHubUrl(value) {
  if (typeof value !== "string" || value.length > 100) fail("Invalid hub address");
  let u;
  try {
    u = new URL(value);
  } catch {
    fail("Invalid hub address");
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") fail("Invalid hub address");
  if (u.username || u.password || u.search || u.hash || (u.pathname && u.pathname !== "/")) fail("Invalid hub address");
  if (!/^[A-Za-z0-9.\-]+$|^\[[0-9A-Fa-f:.]+\]$/.test(u.hostname)) fail("Invalid hub address");
  if (LOOPBACK.test(u.hostname)) fail("Loopback hub addresses cannot be shared");
  return `${u.protocol}//${u.host}/`;
}

function checkHubs(list) {
  if (!Array.isArray(list) || list.length > MAX_HUBS) fail(`hubs must be a list of up to ${MAX_HUBS}`);
  return list.map((hub) => {
    if (!hub || typeof hub !== "object") fail("Invalid hub");
    if (typeof hub.id !== "string" || !HUB_ID_RE.test(hub.id)) fail("Invalid hub id");
    if (!Array.isArray(hub.urls) || !hub.urls.length || hub.urls.length > MAX_HUB_URLS) fail(`a hub needs 1 to ${MAX_HUB_URLS} addresses`);
    return { id: hub.id, urls: [...new Set(hub.urls.map(checkHubUrl))], name: cleanText(hub.name, 40, { field: "hub name" }) };
  });
}

function num(v, lo, hi, field) {
  if (typeof v !== "number" || !Number.isFinite(v) || v < lo || v > hi) fail(`${field} must be a number in [${lo}, ${hi}]`);
  return v;
}

function checkVibrate(v) {
  if (v === undefined) return undefined;
  if (!Array.isArray(v) || v.length > 12 || !v.every((x) => Number.isInteger(x) && x >= 0 && x <= 2000)) fail("vibrate must be up to 12 durations in ms");
  return v.slice();
}

/** Validate and normalise a message payload. Returns a fresh object containing only known fields. */
export function checkPayload(type, p) {
  if (!p || typeof p !== "object" || Array.isArray(p)) fail("payload must be an object");
  switch (type) {
    case "alert": {
      if (typeof p.kind !== "string" || !KIND_RE.test(p.kind)) fail("Invalid alert kind");
      if (!PRIORITIES.includes(p.priority)) fail("Invalid priority");
      return {
        kind: p.kind,
        label: cleanText(p.label, 60, { required: true, field: "label" }),
        priority: p.priority,
        confidence: p.confidence === undefined ? undefined : num(p.confidence, 0, 1, "confidence"),
        detail: cleanText(p.detail, 200, { field: "detail" }),
        advice: cleanText(p.advice, 140, { field: "advice" }),
        vibrate: checkVibrate(p.vibrate),
        test: p.test === true ? true : undefined,
        custom: p.custom === true ? true : undefined,
        repeat: p.repeat === true ? true : undefined,
      };
    }
    case "ack":
      if (typeof p.kind !== "string" || !KIND_RE.test(p.kind)) fail("Invalid alert kind");
      if (typeof p.alertId !== "string" || !MESSAGE_ID_RE.test(p.alertId)) fail("Invalid alertId");
      return { alertId: p.alertId, kind: p.kind };
    case "reply": {
      if (p.to !== undefined && (!Array.isArray(p.to) || p.to.length > 16 || !p.to.every((x) => typeof x === "string" && DEVICE_ID_RE.test(x)))) fail("to must be a list of device ids");
      return {
        text: cleanText(p.text, 140, { required: true, field: "text" }),
        speak: p.speak !== false,
        replyTo: p.replyTo === undefined ? undefined : checkMessageId(p.replyTo),
        to: p.to ? [...new Set(p.to)] : undefined,
      };
    }
    case "caption":
      return { text: cleanText(p.text, 300, { required: true, field: "text" }), final: p.final === true };
    case "status":
      return { listening: p.listening === true, canListen: p.canListen !== false, tone: p.tone === true };
    case "hubs":
      return { hubs: checkHubs(p.hubs) };
    default:
      fail("Unknown message type");
  }
}
