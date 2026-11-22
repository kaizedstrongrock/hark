// Platform bridge. The same app runs in a web browser (computers, or any device on the home Wi-Fi) and
// inside the HARK companion app for Android and iOS (a Capacitor shell around these same files).
// In the app, native plugins add what a web page cannot do reliably: notifications while the phone is
// locked, vibration on iPhone, keeping the screen on, and on Android a foreground service so listening
// continues with the app in the background. Everything falls back to standard web APIs.

const Cap = globalThis.Capacitor;
export const isNative = !!Cap?.isNativePlatform?.();
export const platformName = isNative ? Cap.getPlatform() : "web";

const PLUGINS = ["App", "Haptics", "LocalNotifications", "Network", "KeepAwake", "ForegroundService"];
let nativeReady = null;

/** Native plugin proxies (empty object on the web). */
function native() {
  if (!isNative) return Promise.resolve({});
  nativeReady ||= (async () => {
    const { Capacitor, registerPlugin } = await import("../vendor/capacitor/core.mjs");
    const p = {};
    for (const name of PLUGINS) if (Capacitor.isPluginAvailable(name)) p[name] = registerPlugin(name);
    if (p.LocalNotifications && platformName === "android") {
      // Android notification channels: urgent alerts must be able to break through
      await p.LocalNotifications.createChannel({ id: "hark-urgent", name: "Urgent alerts", description: "Smoke and CO alarms, glass breaking, a baby crying", importance: 5, vibration: true, visibility: 1 }).catch(() => {});
      await p.LocalNotifications.createChannel({ id: "hark-alerts", name: "Alerts", description: "Doorbell, knocking and other sounds", importance: 4, vibration: true, visibility: 1 }).catch(() => {});
    }
    if (p.ForegroundService) {
      await p.ForegroundService.createNotificationChannel({ id: "hark-listening", name: "Listening", description: "Shown while HARK listens in the background", importance: 2 }).catch(() => {});
    }
    return p;
  })().catch(() => ({}));
  return nativeReady;
}

export function initPlatform() {
  return native();
}

// ------------------------------------------------------------------ vibration

// Computers report navigator.vibrate but have nothing to vibrate; iPhones have no web vibration at all
// (the companion app uses the phone's haptics instead).
export const canVibrate = isNative || (typeof navigator !== "undefined" && typeof navigator.vibrate === "function" && /Android/i.test(navigator.userAgent));
let vibeTimers = [];

/**
 * When each buzz of a pattern ([on, off, on, ...] in ms) starts, for haptics that can only buzz once per call.
 * @returns {{at: number, duration: number}[]}
 */
export function hapticSchedule(pattern) {
  const out = [];
  let t = 0;
  (pattern || []).forEach((ms, i) => {
    if (i % 2 === 0 && ms > 0) out.push({ at: t, duration: ms });
    t += Math.max(0, ms);
  });
  return out;
}

/**
 * A browser only lets a page vibrate after the person has tapped it at least once since it was opened.
 * True while this device could vibrate but has not been tapped yet.
 */
export function vibrationNeedsTap() {
  if (isNative || !canVibrate) return false;
  const ua = navigator.userActivation;
  return !!ua && !ua.hasBeenActive;
}

/** Play a vibration pattern ([on, off, on, ...] in ms). @returns {boolean} whether the device accepted it */
export function vibrate(pattern) {
  stopVibration();
  if (!pattern || !pattern.length || !canVibrate) return false;
  if (!isNative) {
    try {
      return navigator.vibrate(pattern) !== false;
    } catch {
      return false;
    }
  }
  native().then((p) => {
    if (!p.Haptics) return;
    for (const { at, duration } of hapticSchedule(pattern)) vibeTimers.push(setTimeout(() => p.Haptics.vibrate({ duration }).catch(() => {}), at));
  });
  return true;
}

export function stopVibration() {
  vibeTimers.forEach(clearTimeout);
  vibeTimers = [];
  if (!isNative && canVibrate) {
    try {
      navigator.vibrate(0);
    } catch {
      /* ignore */
    }
  }
}

// ------------------------------------------------------------------ notifications

function numericId(key) {
  let h = 0;
  for (const c of String(key)) h = (Math.imul(h, 31) + c.charCodeAt(0)) | 0;
  return Math.abs(h) % 2147483647 || 1;
}

/** "granted" | "denied" | "default" | "unsupported" */
export async function notificationState() {
  if (isNative) {
    const p = await native();
    if (!p.LocalNotifications) return "unsupported";
    const s = await p.LocalNotifications.checkPermissions().catch(() => null);
    return s?.display === "granted" ? "granted" : s?.display === "denied" ? "denied" : "default";
  }
  if (typeof Notification === "undefined" || !globalThis.isSecureContext) return "unsupported";
  return Notification.permission;
}

export async function requestNotifications() {
  if (isNative) {
    const p = await native();
    await p.LocalNotifications?.requestPermissions().catch(() => null);
    return notificationState();
  }
  if (typeof Notification === "undefined" || !globalThis.isSecureContext) return "unsupported";
  try {
    return await Notification.requestPermission();
  } catch {
    return Notification.permission;
  }
}

/** A system notification, so an alert is seen while HARK is in the background or the phone is locked. */
export async function notify({ key, title, body, urgent = false, vibrate: pattern }) {
  try {
    if (isNative) {
      const p = await native();
      if (!p.LocalNotifications) return false;
      await p.LocalNotifications.schedule({
        notifications: [{ id: numericId(key), title, body, channelId: urgent ? "hark-urgent" : "hark-alerts", autoCancel: true, extra: { key } }],
      });
      return true;
    }
    if ((await notificationState()) !== "granted") return false;
    // the notification carries the alert's own buzz pattern, so a phone in a pocket vibrates even with HARK in the background
    const options = { body, tag: String(key), renotify: true, requireInteraction: urgent, icon: "icon-192.png", badge: "icon-192.png", vibrate: pattern, data: { key } };
    const reg = await navigator.serviceWorker?.getRegistration?.().catch(() => null);
    if (reg) {
      await reg.showNotification(title, options);
      return true;
    }
    new Notification(title, options); // eslint-disable-line no-new
    return true;
  } catch {
    return false;
  }
}

export async function clearNotification(key) {
  try {
    if (isNative) {
      const p = await native();
      await p.LocalNotifications?.cancel({ notifications: [{ id: numericId(key) }] });
      await p.LocalNotifications?.removeDeliveredNotificationsById?.({ ids: [numericId(key)] });
      return;
    }
    const reg = await navigator.serviceWorker?.getRegistration?.().catch(() => null);
    for (const n of (await reg?.getNotifications?.({ tag: String(key) })) || []) n.close();
  } catch {
    /* nothing to clear */
  }
}

// ------------------------------------------------------------------ screen and background

let wakeLock = null;
let wantAwake = false;
async function requestWakeLock() {
  if (!wantAwake || wakeLock || typeof navigator === "undefined" || !("wakeLock" in navigator)) return;
  try {
    wakeLock = await navigator.wakeLock.request("screen");
    wakeLock.addEventListener("release", () => (wakeLock = null));
  } catch {
    wakeLock = null; // needs HTTPS or localhost, and a visible page
  }
}
if (typeof document !== "undefined") document.addEventListener("visibilitychange", () => document.visibilityState === "visible" && requestWakeLock());

/** Keep the screen on while listening (a sleeping computer or tablet cannot hear anything). */
export async function keepScreenOn(on) {
  wantAwake = on;
  if (isNative) {
    const p = await native();
    await (on ? p.KeepAwake?.keepAwake() : p.KeepAwake?.allowSleep())?.catch?.(() => {});
    return;
  }
  if (on) await requestWakeLock();
  else {
    await wakeLock?.release?.().catch(() => {});
    wakeLock = null;
  }
}

/**
 * Android app: run a foreground service while listening, so the microphone keeps working with the app in
 * the background or the screen off. (A web page, and iOS, pause the microphone in the background.)
 * @returns {Promise<boolean>} whether background listening is active
 */
export async function backgroundListening(on) {
  if (platformName !== "android") return false;
  const p = await native();
  if (!p.ForegroundService) return false;
  try {
    if (on) {
      const perm = await p.ForegroundService.checkPermissions().catch(() => null);
      if (perm && perm.display !== "granted") await p.ForegroundService.requestPermissions().catch(() => null);
      await p.ForegroundService.startForegroundService({
        id: 7,
        title: "HARK is listening",
        body: "Listening for important sounds. Tap to open.",
        smallIcon: "ic_stat_hark",
        serviceType: 128, // ServiceType.Microphone
        silent: true,
        notificationChannelId: "hark-listening",
      });
      return true;
    }
    await p.ForegroundService.stopForegroundService();
  } catch {
    /* not available */
  }
  return false;
}

/** Whether this device keeps listening when HARK is not on screen. */
export const listensInBackground = platformName === "android";

// ------------------------------------------------------------------ events

/** The app came back to the foreground. */
export function onResume(cb) {
  if (typeof document !== "undefined") document.addEventListener("visibilitychange", () => document.visibilityState === "visible" && cb());
  native().then((p) => p.App?.addListener("resume", cb).catch(() => {}));
}

/** The network changed (joined Wi-Fi, came back online). */
export function onNetworkChange(cb) {
  if (typeof window !== "undefined") window.addEventListener("online", cb);
  native().then((p) => p.Network?.addListener("networkStatusChange", (s) => s?.connected && cb()).catch(() => {}));
}

/** hark://join?... links opened by the phone's camera or another app (companion app only). */
export function onDeepLink(cb) {
  native().then((p) => p.App?.addListener("appUrlOpen", (e) => e?.url && cb(e.url)).catch(() => {}));
}

/** Tapping a notification brings the alert back on screen. */
export function onNotificationTap(cb) {
  native().then((p) => p.LocalNotifications?.addListener("localNotificationActionPerformed", (a) => cb(a?.notification?.extra?.key)).catch(() => {}));
  if (typeof navigator !== "undefined" && navigator.serviceWorker) {
    navigator.serviceWorker.addEventListener("message", (e) => e.data?.type === "hark-notification" && cb(e.data.key));
  }
}
