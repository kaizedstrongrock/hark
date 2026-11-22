// Which web pages may use this hub's API from a browser (CORS).
// The devices of one home load HARK from different places: from this hub (same origin), from another
// hub on the home network (http://<private address>:<port>), from a computer's own hub
// (http://localhost:<port>) or from the companion app (capacitor://localhost, https://localhost).
// Pages on the public internet are refused, so a website cannot drive a hub on your home network
// through your browser.

const APP_ORIGINS = new Set(["capacitor://localhost", "https://localhost", "http://localhost", "ionic://localhost"]);

/** True for loopback, private (RFC 1918), link-local, CGNAT and ULA addresses, and local host names. */
export function isPrivateHost(hostname) {
  const h = String(hostname || "")
    .replace(/^\[|\]$/g, "")
    .toLowerCase();
  if (!h) return false;
  if (h === "localhost" || h.endsWith(".localhost")) return true;
  if (/\.(local|lan|home\.arpa|internal)$/.test(h)) return true;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    if ([a, b, Number(v4[3]), Number(v4[4])].some((x) => x > 255)) return false;
    return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127);
  }
  if (h.includes(":")) return h === "::1" || /^f[cd][0-9a-f]{0,2}:/.test(h) || /^fe[89ab][0-9a-f]?:/.test(h);
  return !h.includes("."); // a single-label name on the local network, e.g. "kitchen-pc"
}

/**
 * @param {string|undefined} origin the request's Origin header
 * @param {string|undefined} host the request's Host header (same-origin requests are always allowed)
 * @param {string[]} [extra] additional allowed origins (HARK_ALLOWED_ORIGINS)
 */
export function originAllowed(origin, host, extra = []) {
  if (origin === undefined || origin === null || origin === "") return true; // same-origin GET or not a browser
  if (APP_ORIGINS.has(origin) || extra.includes(origin)) return true;
  let u;
  try {
    u = new URL(origin);
  } catch {
    return false; // includes the opaque origin "null" (sandboxed frames, file://)
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return false;
  if (host && u.host.toLowerCase() === String(host).toLowerCase()) return true;
  return isPrivateHost(u.hostname);
}
