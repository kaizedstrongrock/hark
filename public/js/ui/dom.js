// Tiny DOM helpers. Text from the network is only ever set via textContent (never innerHTML).
export { formatCode } from "../core/protocol.js";

/**
 * h("button.big#go", {onclick, "aria-label": "Go"}, "Go!", childNode, [more])
 */
export function h(tag, attrs = {}, ...children) {
  const m = /^([a-z0-9-]+)?((?:[.#][\w-]+)*)$/i.exec(tag);
  const el = document.createElement((m && m[1]) || "div");
  if (m && m[2]) {
    for (const part of m[2].match(/[.#][\w-]+/g)) {
      if (part[0] === ".") el.classList.add(part.slice(1));
      else el.id = part.slice(1);
    }
  }
  if (attrs && (typeof attrs !== "object" || attrs instanceof Node || Array.isArray(attrs))) {
    children.unshift(attrs);
    attrs = {};
  }
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v);
    else if (k === "class") el.className = v;
    else if (k === "style" && typeof v === "object") Object.assign(el.style, v);
    else if (k === "dataset") Object.assign(el.dataset, v);
    else if (k in el && typeof v !== "string") el[k] = v;
    else el.setAttribute(k, v === true ? "" : String(v));
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c === undefined || c === null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

export function clear(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
  return el;
}

export function mount(el, ...children) {
  clear(el);
  append(el, children);
  return el;
}

export const $ = (sel, root = document) => root.querySelector(sel);

let toastBox;
let errorBox;
/** A short message at the bottom of the screen (announced to screen readers). */
export function toast(text, { kind = "info", ms = 4500 } = {}) {
  toastBox ||= document.body.appendChild(h("div.toasts", { role: "status", "aria-live": "polite" }));
  errorBox ||= document.body.appendChild(h("div.toasts.toasts-errors", { role: "alert", "aria-live": "assertive" }));
  const t = h(`div.toast.${kind}`, text);
  (kind === "error" ? errorBox : toastBox).append(t);
  setTimeout(() => t.classList.add("out"), ms);
  setTimeout(() => t.remove(), ms + 400);
}

export function timeLabel(ts) {
  return new Date(ts).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

/** "Today", "Yesterday" or the date. */
export function dayLabel(ts, now = Date.now()) {
  const d = new Date(ts);
  const today = new Date(now);
  const startOf = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((startOf(today) - startOf(d)) / 86400000);
  if (diff === 0) return "Today";
  if (diff === 1) return "Yesterday";
  return d.toLocaleDateString([], { weekday: "long", month: "long", day: "numeric" });
}

/** "just now", "5 minutes ago", "2 hours ago", or the time. */
export function ago(ts, now = Date.now()) {
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 45) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} minute${m === 1 ? "" : "s"} ago`;
  const hr = Math.round(m / 60);
  if (hr < 6) return `${hr} hour${hr === 1 ? "" : "s"} ago`;
  return `${dayLabel(ts, now) === "Today" ? "" : `${dayLabel(ts, now)}, `}${timeLabel(ts)}`;
}

/** A labelled on/off switch (a real checkbox, so it works with every assistive technology). */
export function switchField({ label, hint, checked, onchange, id }) {
  const input = h("input", { type: "checkbox", role: "switch", checked: !!checked, id, onchange: (e) => onchange(e.target.checked) });
  return h("label.switch-row", input, h("span.switch-ui", { "aria-hidden": "true" }), h("span.switch-text", h("span.switch-label", label), hint ? h("span.hint", hint) : null));
}

/** A group of large radio buttons. */
export function radioGroup({ legend, name, value, options, onchange }) {
  return h(
    "fieldset.radios",
    h("legend", legend),
    options.map((o) =>
      h(
        "label.radio-row",
        h("input", { type: "radio", name, value: o.value, checked: o.value === value, onchange: () => onchange(o.value) }),
        h("span.radio-text", h("span.radio-label", o.label), o.hint ? h("span.hint", o.hint) : null),
      ),
    ),
  );
}
