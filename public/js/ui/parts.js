// Pieces shared by several screens.
import { h, timeLabel, ago } from "./dom.js";
import { icon, iconFor, DEVICE_ICON } from "./icons.js";

/** What happened to an alert, in words. */
export function alertStatus(e, hark) {
  if (e.missed && !e.acked) return { text: "Missed while this device was away", cls: "missed" };
  if (e.acked) {
    if (e.acked.by?.id === "auto") return { text: "", cls: "seen" };
    const who = e.acked.by?.id === hark.device.id ? "you" : e.acked.by?.name || "someone";
    return { text: `Seen by ${who}`, cls: "seen" };
  }
  if (e.history) return { text: "", cls: "seen" };
  return { text: e.priority === "urgent" ? "Needs attention" : "Not seen yet", cls: "open" };
}

/** One alert in a list. */
export function alertRow(e, hark, { actions = true } = {}) {
  const st = alertStatus(e, hark);
  const lastReply = e.replies?.[e.replies.length - 1];
  return h(
    `li.alert-row.${e.priority}.${st.cls}`,
    h("span.row-icon", { "aria-hidden": "true" }, icon(iconFor(e.kind), { size: 30 })),
    h(
      "div.row-body",
      h("p.row-title", e.label, e.test ? h("span.tag", "test") : null, e.priority === "urgent" ? h("span.tag.urgent", "urgent") : null),
      h("p.row-meta", `${hark.whereLabel(e)} · ${timeLabel(e.at)}`),
      st.text ? h(`p.row-status.${st.cls}`, st.text) : null,
      lastReply ? h("p.row-reply", icon("message", { size: 20 }), ` ${lastReply.mine ? "You replied" : `${lastReply.by?.name} replied`}: "${lastReply.text}"`) : null,
    ),
    actions && !e.acked && !e.history
      ? h("div.row-actions", h("button.btn.secondary.small", { type: "button", onclick: () => hark.acknowledge(e.key) }, "I've seen it"))
      : null,
  );
}

/** Another device of the home, with what it is doing. */
export function deviceRow(d) {
  const status = !d.responding ? "Not responding" : d.listening ? "Listening" : d.canListen === false ? "Shows alerts (cannot listen)" : "Not listening";
  const cls = !d.responding ? "warn" : d.listening ? "on" : "off";
  return h(
    `li.device-row.${cls}`,
    h("span.row-icon", { "aria-hidden": "true" }, icon(DEVICE_ICON[d.kind] || "computer", { size: 30 })),
    h("div.row-body", h("p.row-title", d.name), h(`p.row-status.${cls}`, status)),
  );
}

/** A short fingerprint of what an alert list shows, so lists are only rebuilt (and focus only lost) when it changes. */
export function eventsKey(events) {
  return events.map((e) => `${e.key}:${e.acked ? e.acked.by?.id || "?" : ""}:${e.missed ? 1 : 0}:${e.history ? 1 : 0}:${e.heardBy.length}:${e.replies?.length || 0}:${e.test ? 1 : 0}`).join("|");
}

/** The same for a list of devices. */
export function devicesKey(devices) {
  return devices.map((d) => `${d.id}:${d.name}:${d.listening ? 1 : 0}:${d.responding ? 1 : 0}:${d.canListen ? 1 : 0}`).join("|");
}

export function kindWord(kind) {
  return { phone: "phone", tablet: "tablet", computer: "computer" }[kind] || "device";
}

export { ago };
