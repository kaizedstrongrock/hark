#!/usr/bin/env node
// HARK home hub: serves the app and links the devices of a home (phones, tablets, computers) into one
// listening network. Zero dependencies (Node >= 18). Audio never reaches the hub - only small alert messages.
// Every device also works on its own without a hub; the hub is only what lets devices at home share alerts.
import http from "node:http";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import zlib from "node:zlib";
import crypto from "node:crypto";
import { pipeline } from "node:stream";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Relay, RelayError } from "./lib/relay.js";
import { RateLimiter } from "./lib/ratelimit.js";
import { originAllowed, isPrivateHost } from "./lib/origin.js";
import { checkCode, checkDevice, checkMessageId, checkPayload, cleanText, ValidationError, HUB_ID_RE } from "./lib/validate.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(HERE, "public");
const VERSION = JSON.parse(fs.readFileSync(path.join(HERE, "package.json"), "utf8")).version;
export const PROTOCOL = 2;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".wasm": "application/wasm",
  ".tflite": "application/octet-stream",
  ".txt": "text/plain; charset=utf-8",
  ".wav": "audio/wav",
};
const COMPRESSIBLE = new Set([".html", ".js", ".mjs", ".css", ".json", ".svg", ".webmanifest", ".wasm", ".txt", ".tflite"]);

/** Minimal .env loader (does not override variables that are already set). */
export function loadEnv(file = path.join(HERE, ".env")) {
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return;
  }
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m || line.trim().startsWith("#")) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (process.env[m[1]] === undefined) process.env[m[1]] = v;
  }
}

// Virtual adapters (VMs, containers, VPNs) are never the address a phone on the same Wi-Fi can reach.
const VIRTUAL_IF = /vbox|virtualbox|vmnet|vmware|docker|veth|br-|virbr|vEthernet|wsl|hyper-v|utun|tun\d|tap\d|zt|tailscale|wg\d|llw|awdl|bridge100/i;

/** Home-network URLs of this hub, best first (real Wi-Fi/Ethernet before virtual adapters). */
export function lanUrls(port, interfaces = os.networkInterfaces()) {
  const real = [];
  const virtual = [];
  for (const [name, list] of Object.entries(interfaces)) {
    for (const a of list || []) {
      if ((a.family === "IPv4" || a.family === 4) && !a.internal) (VIRTUAL_IF.test(name) ? virtual : real).push(`http://${a.address}:${port}/`);
    }
  }
  return [...real, ...virtual];
}

/**
 * A random secret kept on this computer (the only thing the hub stores), so that every computer gets its own hub
 * id - even two that share a name, like two Raspberry Pis called "raspberrypi". Null if it cannot be stored.
 */
export function hubSecret(dir) {
  const file = path.join(dir, "hub-secret");
  const readIt = () => {
    try {
      const v = fs.readFileSync(file, "utf8").trim();
      return /^[a-f0-9]{32}$/.test(v) ? v : null;
    } catch {
      return null;
    }
  };
  const existing = readIt();
  if (existing) return existing;
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const v = crypto.randomBytes(16).toString("hex");
    fs.writeFileSync(file, `${v}\n`, { mode: 0o600, flag: "wx" });
    return v;
  } catch {
    return readIt(); // another hub created it first, or the folder is read-only (then: null)
  }
}

/** This hub's id: the same computer (secret) and port always give the same id. */
export function hubIdFor(port, secret = os.hostname()) {
  return "h-" + crypto.createHash("sha256").update(`${secret}|${port}|hark-hub`).digest("hex").slice(0, 16);
}

function sendJson(res, status, body, headers = {}) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    ...headers,
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Length": Buffer.byteLength(data),
  });
  res.end(data);
}

async function readJson(req, limit = 8192) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new ValidationError("Request body too large");
    chunks.push(chunk);
  }
  let body;
  try {
    body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  } catch {
    throw new ValidationError("Body must be JSON");
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new ValidationError("Body must be a JSON object");
  return body;
}

/**
 * @param {{root?: string, relay?: Relay, limiter?: RateLimiter, fetchImpl?: typeof fetch, env?: object,
 *          heartbeatMs?: number, hubId?: string, hubName?: string, interfaces?: object, dataDir?: string}} [opts]
 *   dataDir: where the hub keeps its random id (default ~/.hark, or HARK_DATA_DIR)
 */
export function createServer(opts = {}) {
  const root = opts.root || PUBLIC;
  const limiter = opts.limiter || new RateLimiter();
  const fetchImpl = opts.fetchImpl || globalThis.fetch;
  const env = opts.env || process.env;
  const heartbeatMs = opts.heartbeatMs ?? 10000;
  const list = (v) =>
    String(v || "")
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean);
  const extraOrigins = list(env.HARK_ALLOWED_ORIGINS);
  // Host names (besides home-network ones) this hub may be reached at, e.g. when hosted on a public name.
  const extraHosts = new Set([...list(env.HARK_ALLOWED_HOSTS), ...extraOrigins.map((o) => hostOf(o))].filter(Boolean).map((x) => x.toLowerCase()));
  const dataDir = opts.dataDir || env.HARK_DATA_DIR || path.join(os.homedir(), ".hark");
  let secret = null;
  const configuredId = [opts.hubId, env.HARK_HUB_ID].find((v) => typeof v === "string" && HUB_ID_RE.test(v));
  const hubName = cleanText(String(opts.hubName || env.HARK_HUB_NAME || os.hostname()).slice(0, 40), 40) || "HARK hub";
  const port = () => server.address()?.port ?? 0;
  const hubId = () => configuredId || hubIdFor(port(), (secret ??= hubSecret(dataDir) || os.hostname()));
  const urls = () => lanUrls(port(), opts.interfaces);
  const relay = opts.relay || new Relay({ selfHub: () => ({ id: hubId(), urls: urls(), name: hubName }) });
  const gzCache = new Map(); // path -> {mtimeMs, buf}

  /**
   * The API only answers when it is reached by a home-network address (an IP address, localhost, name.local ...)
   * or a configured name. This stops "DNS rebinding": a website whose name is made to point at the hub.
   */
  function hostAllowed(host) {
    if (!host) return true; // very old HTTP clients
    const name = hostOf(`http://${host}`);
    return !!name && (isPrivateHost(name) || extraHosts.has(name.toLowerCase()));
  }

  /** CORS for the API. @returns {object|null} headers to add, or null when the page may not use the API */
  function cors(req) {
    const origin = req.headers.origin;
    if (!originAllowed(origin, req.headers.host, extraOrigins)) return null;
    if (!origin) return {};
    const h = { "Access-Control-Allow-Origin": origin, Vary: "Origin" };
    if (req.method === "OPTIONS") {
      h["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS";
      h["Access-Control-Allow-Headers"] = "Content-Type";
      h["Access-Control-Max-Age"] = "600";
      if (req.headers["access-control-request-private-network"] === "true") h["Access-Control-Allow-Private-Network"] = "true";
    }
    return h;
  }

  async function serveStatic(req, res, urlPath) {
    let rel;
    try {
      rel = decodeURIComponent(urlPath);
    } catch {
      return sendJson(res, 400, { error: "Bad path" });
    }
    if (rel.includes("\0")) return sendJson(res, 400, { error: "Bad path" });
    if (rel === "/" || rel === "") rel = "/index.html";
    const file = path.resolve(root, "." + path.posix.normalize(rel));
    if (file !== root && !file.startsWith(root + path.sep)) return sendJson(res, 403, { error: "Forbidden" });
    let stat;
    try {
      stat = await fsp.stat(file);
    } catch {
      return sendJson(res, 404, { error: "Not found" });
    }
    if (!stat.isFile()) return sendJson(res, 404, { error: "Not found" });
    const ext = path.extname(file).toLowerCase();
    const immutable = rel.startsWith("/vendor/") || rel.startsWith("/models/");
    const headers = {
      "Content-Type": MIME[ext] || "application/octet-stream",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "Cache-Control": immutable ? "public, max-age=86400" : "no-cache",
    };
    const wantsGzip = /\bgzip\b/.test(req.headers["accept-encoding"] || "");
    if (wantsGzip && COMPRESSIBLE.has(ext) && stat.size > 1024) {
      let entry = gzCache.get(file);
      if (!entry || entry.mtimeMs !== stat.mtimeMs) {
        const raw = await fsp.readFile(file);
        entry = { mtimeMs: stat.mtimeMs, buf: zlib.gzipSync(raw, { level: 6 }) };
        gzCache.set(file, entry);
      }
      headers["Content-Encoding"] = "gzip";
      headers["Vary"] = "Accept-Encoding";
      headers["Content-Length"] = entry.buf.length;
      res.writeHead(200, headers);
      return res.end(req.method === "HEAD" ? undefined : entry.buf);
    }
    headers["Content-Length"] = stat.size;
    res.writeHead(200, headers);
    if (req.method === "HEAD") return res.end();
    // a file that cannot be read (replaced during an update, locked by a virus scanner) must not stop the hub
    pipeline(fs.createReadStream(file), res, (err) => err && res.destroy());
  }

  function handleStream(req, res, url, corsHeaders) {
    const code = checkCode(url.searchParams.get("h"));
    const who = checkDevice({ id: url.searchParams.get("id"), name: url.searchParams.get("name") || undefined, kind: url.searchParams.get("kind") || undefined });
    if (!relay.admit(code, who.id)) return sendJson(res, 429, { error: "Too many devices in this home" }, corsHeaders);
    res.writeHead(200, {
      ...corsHeaders,
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.write("retry: 3000\n\n");
    let open = true;
    const client = {
      ...who,
      send(event, data) {
        if (!open) return;
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      },
      close() {
        open = false;
        res.end();
      },
    };
    let leave;
    try {
      leave = relay.join(code, client);
    } catch (e) {
      client.send("refused", { error: e.message });
      open = false;
      return res.end();
    }
    // A named event (not an SSE comment) so devices can tell a live link from a silently dead one.
    const beat = setInterval(() => client.send("ping", { now: Date.now() }), heartbeatMs);
    beat.unref?.();
    const done = () => {
      open = false;
      clearInterval(beat);
      leave?.();
      leave = null;
    };
    req.on("close", done);
    res.on("close", done);
  }

  async function handleSend(req, res, ip, corsHeaders) {
    if (!limiter.take(ip)) return sendJson(res, 429, { error: "Slow down" }, corsHeaders);
    const body = await readJson(req);
    const code = checkCode(body.h);
    const from = checkDevice({ id: body.id, name: body.name, kind: body.kind });
    const mid = checkMessageId(body.mid);
    if (typeof body.type !== "string") throw new ValidationError("type is required");
    const payload = checkPayload(body.type, body.payload);
    const msg = relay.publish(code, from, body.type, payload, mid);
    return sendJson(res, 200, { ok: true, id: msg.id, ts: msg.ts, delivered: msg.delivered, duplicate: msg.duplicate || undefined }, corsHeaders);
  }

  async function handleTts(req, res, ip, corsHeaders) {
    if (!limiter.take(ip, 5)) return sendJson(res, 429, { error: "Slow down" }, corsHeaders);
    const body = await readJson(req);
    const text = cleanText(body.text, 280, { required: true, field: "text" });
    const code = checkCode(body.h);
    const key = env.ELEVENLABS_API_KEY;
    if (!key) return sendJson(res, 501, { error: "ElevenLabs is not configured; using the on-device voice." }, corsHeaders);
    // only for a home that has a device connected here right now (the voice costs money)
    if (!relay.members(code).length) return sendJson(res, 403, { error: "No device of this home is connected to this hub." }, corsHeaders);
    const voice = /^[A-Za-z0-9]{10,40}$/.test(body.voiceId || "") ? body.voiceId : env.ELEVENLABS_VOICE_ID || "JBFqnCBsd6RMkjVDRZzb";
    const model = env.ELEVENLABS_MODEL_ID || "eleven_flash_v2_5";
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 12000);
    try {
      const r = await fetchImpl(`https://api.elevenlabs.io/v1/text-to-speech/${voice}?output_format=mp3_44100_128`, {
        method: "POST",
        headers: { "xi-api-key": key, "Content-Type": "application/json", Accept: "audio/mpeg" },
        body: JSON.stringify({ text, model_id: model }),
        signal: ctrl.signal,
      });
      if (!r.ok) {
        const detail = (await r.text().catch(() => "")).slice(0, 300);
        return sendJson(res, 502, { error: `ElevenLabs returned ${r.status}`, detail }, corsHeaders);
      }
      const audio = Buffer.from(await r.arrayBuffer());
      res.writeHead(200, { ...corsHeaders, "Content-Type": "audio/mpeg", "Content-Length": audio.length, "Cache-Control": "no-store" });
      return res.end(audio);
    } catch (e) {
      return sendJson(res, 504, { error: e.name === "AbortError" ? "ElevenLabs timed out" : "ElevenLabs request failed" }, corsHeaders);
    } finally {
      clearTimeout(timer);
    }
  }

  const server = http.createServer(async (req, res) => {
    const ip = req.socket.remoteAddress || "?";
    let url;
    try {
      url = new URL(req.url, "http://localhost");
    } catch {
      return sendJson(res, 400, { error: "Bad URL" });
    }
    let corsHeaders = {};
    try {
      if (url.pathname.startsWith("/api/")) {
        if (!hostAllowed(req.headers.host)) return sendJson(res, 403, { error: "This hub only answers on the home network" });
        corsHeaders = cors(req);
        if (!corsHeaders) return sendJson(res, 403, { error: "This page may not use the HARK hub" });
        // HARK's own requests are fetch() and EventSource. An <img>, a link or a "no-cors" request from another
        // web page is something else: refuse it (browsers say what kind of request it is).
        const mode = req.headers["sec-fetch-mode"];
        const dest = req.headers["sec-fetch-dest"];
        if (url.pathname !== "/api/status" && ((mode && (mode === "no-cors" || mode === "navigate")) || (dest && dest !== "empty"))) {
          return sendJson(res, 403, { error: "Not a HARK request" });
        }
        if (req.method === "OPTIONS") {
          res.writeHead(204, corsHeaders);
          return res.end();
        }
        if (req.method === "POST" && !/^application\/json\b/i.test(req.headers["content-type"] || "")) {
          return sendJson(res, 415, { error: "Content-Type must be application/json" }, corsHeaders);
        }
      }
      if (url.pathname === "/api/status" && req.method === "GET") {
        return sendJson(
          res,
          200,
          { ok: true, app: "hark", protocol: PROTOCOL, version: VERSION, hubId: hubId(), name: hubName, lan: urls(), voice: env.ELEVENLABS_API_KEY ? "elevenlabs" : "device", devices: relay.clientCount, time: Date.now() },
          corsHeaders,
        );
      }
      if (url.pathname === "/api/stream" && req.method === "GET") return handleStream(req, res, url, corsHeaders);
      if (url.pathname === "/api/send" && req.method === "POST") return await handleSend(req, res, ip, corsHeaders);
      if (url.pathname === "/api/tts" && req.method === "POST") return await handleTts(req, res, ip, corsHeaders);
      if (url.pathname.startsWith("/api/")) return sendJson(res, 404, { error: "Unknown endpoint" }, corsHeaders);
      if (req.method !== "GET" && req.method !== "HEAD") return sendJson(res, 405, { error: "Method not allowed" });
      return await serveStatic(req, res, url.pathname);
    } catch (e) {
      if (e instanceof ValidationError || e instanceof RelayError) return sendJson(res, e.status, { error: e.message }, corsHeaders);
      console.error("[hark] request failed:", e);
      if (!res.headersSent) sendJson(res, 500, { error: "Internal error" }, corsHeaders);
      else res.end();
    }
  });
  server.relay = relay;
  server.hubId = hubId;
  return server;
}

function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^\[|\]$/g, "");
  } catch {
    return null;
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  loadEnv();
  const port = Number(process.env.PORT || 3000);
  const host = process.env.HOST || "0.0.0.0";
  const server = createServer();
  server.on("error", (e) => {
    if (e.code === "EADDRINUSE") console.error(`\n  Port ${port} is busy. Try:  PORT=3001 npm start\n`);
    else console.error(e);
    process.exit(1);
  });
  server.listen(port, host, () => {
    const lan = lanUrls(port);
    console.log(`\n  HARK home hub is running  (v${VERSION})`);
    console.log(`  Open HARK on this computer:   http://localhost:${port}/`);
    for (const u of lan) console.log(`  Other devices on your Wi-Fi:  ${u}`);
    if (!lan.length) console.log("  (No home network found: other devices cannot connect until this computer joins Wi-Fi.)");
    console.log(`  Voice for replies: ${process.env.ELEVENLABS_API_KEY ? "ElevenLabs" : "on-device"}`);
    console.log("  Sound is analysed on each device. Audio never reaches this hub. Ctrl+C to stop.\n");
  });
}
