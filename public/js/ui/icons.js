// Simple line icons (24 x 24, drawn for HARK). Built with createElementNS from the shapes below - no
// icon font, no emoji - so they look the same on every device and follow the text colour.
// Icons always sit next to a text label; on their own they are hidden from screen readers.

/** Gear outline with 8 teeth, computed once. */
function gearPath() {
  const pts = [];
  const teeth = 8;
  for (let i = 0; i < teeth; i++) {
    const a = (i / teeth) * Math.PI * 2;
    const w = Math.PI / teeth;
    for (const [r, da] of [
      [7.2, -w * 0.95],
      [9.6, -w * 0.45],
      [9.6, w * 0.45],
      [7.2, w * 0.95],
    ]) {
      pts.push([12 + r * Math.cos(a + da), 12 + r * Math.sin(a + da)]);
    }
  }
  return `M${pts.map(([x, y]) => `${x.toFixed(2)} ${y.toFixed(2)}`).join("L")}Z`;
}

const dot = (cx, cy, r = 1) => ["circle", { cx, cy, r, fill: "currentColor", stroke: "none" }];
const p = (d) => ["path", { d }];
const c = (cx, cy, r) => ["circle", { cx, cy, r }];

export const SHAPES = {
  flame: [p("M12 2.8c1.2 3.4 5.6 5.6 5.6 10.6a5.6 5.6 0 0 1-11.2 0c0-2.9 1.5-4.7 3-6 .1 2.1 1 3.4 2.4 3.9-.8-2.8-.9-5.5.2-8.5z"), p("M12 20.6a2.4 2.4 0 0 1-2.4-2.4c0-1.5 1.1-2.5 2.4-3.8 1.3 1.3 2.4 2.3 2.4 3.8a2.4 2.4 0 0 1-2.4 2.4z")],
  warn: [p("M10.3 4.6 2.7 17.8A2 2 0 0 0 4.4 20.8h15.2a2 2 0 0 0 1.7-3L13.7 4.6a2 2 0 0 0-3.4 0z"), p("M12 9.2v4.6"), dot(12, 17.1, 1.1)],
  baby: [c(12, 13, 7.6), p("M12 5.4c-.2-1.7 1-2.8 2.6-2.6"), dot(9.4, 12.4), dot(14.6, 12.4), p("M9.8 15.8c1.3 1.1 3.1 1.1 4.4 0")],
  glass: [p("M7 3h10l-.7 5.6a4.3 4.3 0 0 1-8.6 0z"), p("M12 12.9V20"), p("M8.5 20.5h7"), p("M11 3.4l1.5 2.2-1.3 1.6 1.2 1.9")],
  scream: [c(12, 12, 9), dot(9, 9.8, 1.1), dot(15, 9.8, 1.1), ["ellipse", { cx: 12, cy: 15.4, rx: 2.1, ry: 2.7 }]],
  bell: [p("M6 16.5V11a6 6 0 0 1 12 0v5.5l1.6 2H4.4z"), p("M10 20.8a2.1 2.1 0 0 0 4 0"), p("M12 3.2V5")],
  door: [p("M6.5 21V4.5A1.5 1.5 0 0 1 8 3h8a1.5 1.5 0 0 1 1.5 1.5V21"), p("M4 21h16"), dot(14.6, 12.4, 1.1)],
  siren: [p("M7 18v-5a5 5 0 0 1 10 0v5"), ["rect", { x: 5, y: 18, width: 14, height: 3, rx: 1 }], p("M12 2.5v2.2M4.6 5.8l1.5 1.5M19.4 5.8l-1.5 1.5M2.6 12.2h2.1M19.3 12.2h2.1")],
  phone: [p("M5.6 3.4h3l1.6 4-2.1 1.5a11 11 0 0 0 7 7l1.5-2.1 4 1.6v3a2 2 0 0 1-2.1 2A16.2 16.2 0 0 1 3.5 5.5a2 2 0 0 1 2.1-2.1z")],
  clock: [c(12, 13, 7.5), p("M12 9.4V13l2.6 2"), p("M3.4 6.6l3.2-3.2M20.6 6.6l-3.2-3.2"), p("M6.6 19.4 5 21.5M17.4 19.4 19 21.5")],
  paw: [p("M7.8 17.6c0-2.7 1.9-4.7 4.2-4.7s4.2 2 4.2 4.7c0 1.6-1.2 2.6-2.6 2.6-.7 0-1.1-.3-1.6-.3s-.9.3-1.6.3c-1.4 0-2.6-1-2.6-2.6z"), c(5.7, 11.2, 1.8), c(9.4, 6.9, 1.9), c(14.6, 6.9, 1.9), c(18.3, 11.2, 1.8)],
  car: [p("M3 16v-3l2.1-4.6A2 2 0 0 1 6.9 7.2h10.2a2 2 0 0 1 1.8 1.2L21 13v3"), p("M2.5 16h19"), p("M3.5 12.8h17"), c(7.4, 17.6, 1.9), c(16.6, 17.6, 1.9)],
  drop: [p("M12 3c3.6 4.3 6.1 7.6 6.1 10.9a6.1 6.1 0 0 1-12.2 0C5.9 10.6 8.4 7.3 12 3z")],
  cat: [p("M5 9.6V4.2l4.1 3h5.8l4.1-3v5.4c.9 1.3 1.5 2.9 1.5 4.5 0 4.1-3.8 6.9-8.5 6.9s-8.5-2.8-8.5-6.9c0-1.6.6-3.2 1.5-4.5z"), dot(9.1, 13, 1), dot(14.9, 13, 1), p("M11 16.1h2l-1 1.1z")],
  speech: [p("M4 5.5A1.5 1.5 0 0 1 5.5 4h13A1.5 1.5 0 0 1 20 5.5v9a1.5 1.5 0 0 1-1.5 1.5H10.2L5.8 19.8V16h-.3A1.5 1.5 0 0 1 4 14.5z")],
  message: [p("M4 5.5A1.5 1.5 0 0 1 5.5 4h13A1.5 1.5 0 0 1 20 5.5v9a1.5 1.5 0 0 1-1.5 1.5H10.2L5.8 19.8V16h-.3A1.5 1.5 0 0 1 4 14.5z"), p("M8 8.5h8M8 12h5")],
  name: [c(9, 8, 3.6), p("M2.6 20.5c0-3.6 2.9-6.1 6.4-6.1s6.4 2.5 6.4 6.1"), p("M16.9 6.2a4.2 4.2 0 0 1 0 5.6M19.6 4.2a7.2 7.2 0 0 1 0 9.6")],
  star: [p("M12 3.4l2.7 5.4 6 .9-4.3 4.2 1 5.9L12 17l-5.4 2.8 1-5.9-4.3-4.2 6-.9z")],
  check: [p("M4.5 12.6l5 5L19.5 6.6")],
  home: [p("M3.4 11 12 3.6l8.6 7.4"), p("M5.6 9.4V20.4h12.8V9.4"), p("M10 20.4v-5.6h4v5.6")],
  computer: [["rect", { x: 4.5, y: 4, width: 15, height: 10.5, rx: 1.5 }], p("M2.2 18.6h19.6l-2.2-4.1H4.4z")],
  smartphone: [["rect", { x: 7, y: 2.5, width: 10, height: 19, rx: 2 }], p("M10.8 5.5h2.4"), dot(12, 18.4, 0.9)],
  tablet: [["rect", { x: 4.5, y: 3, width: 15, height: 18, rx: 2 }], dot(12, 18, 0.9)],
  devices: [p("M2.5 15V6.4A1.4 1.4 0 0 1 3.9 5h10.2a1.4 1.4 0 0 1 1.4 1.4V8"), p("M1.5 18.5h11"), ["rect", { x: 15, y: 9.5, width: 7, height: 11, rx: 1.5 }], dot(18.5, 18, 0.8)],
  gear: [["path", { d: gearPath() }], c(12, 12, 3)],
  list: [p("M9 6.5h11M9 12h11M9 17.5h11"), dot(4.6, 6.5, 1.2), dot(4.6, 12, 1.2), dot(4.6, 17.5, 1.2)],
  mic: [p("M9 5.6a3 3 0 0 1 6 0V12a3 3 0 0 1-6 0z"), p("M5.5 11.5a6.5 6.5 0 0 0 13 0M12 18v3M8.5 21h7")],
  micOff: [p("M9 5.6a3 3 0 0 1 6 0V12a3 3 0 0 1-6 0z"), p("M5.5 11.5a6.5 6.5 0 0 0 13 0M12 18v3M8.5 21h7"), p("M3.5 3.5l17 17")],
  wifi: [p("M2.4 9.2a14 14 0 0 1 19.2 0M5.4 12.6a9.6 9.6 0 0 1 13.2 0M8.4 16a5.2 5.2 0 0 1 7.2 0"), dot(12, 19.4, 1.2)],
  wifiOff: [p("M2.4 9.2a14 14 0 0 1 19.2 0M5.4 12.6a9.6 9.6 0 0 1 13.2 0M8.4 16a5.2 5.2 0 0 1 7.2 0"), dot(12, 19.4, 1.2), p("M3.5 3.5l17 17")],
  plus: [p("M12 5v14M5 12h14")],
  trash: [p("M4.5 6.5h15M9.5 6.5V4.5h5v2M6.5 6.5l1 14h9l1-14M10 10.5v6M14 10.5v6")],
  close: [p("M6 6l12 12M18 6 6 18")],
  chevronRight: [p("M9.5 5.5 16 12l-6.5 6.5")],
  chevronLeft: [p("M14.5 5.5 8 12l6.5 6.5")],
  play: [p("M8 5.4v13.2L18.6 12z")],
  stop: [["rect", { x: 6.5, y: 6.5, width: 11, height: 11, rx: 1.5 }]],
  lock: [["rect", { x: 5, y: 10.5, width: 14, height: 10, rx: 2 }], p("M8 10.5V8a4 4 0 0 1 8 0v2.5")],
  info: [c(12, 12, 9), p("M12 11v5.6"), dot(12, 7.8, 1.1)],
  qr: [p("M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4z"), p("M14 14h2.5v2.5H14zM17.5 17.5H20V20h-2.5zM14 19.5h1M19.5 14h.5")],
  volume: [p("M4 9.5h3.5L12 5.5v13l-4.5-4H4z"), p("M15.5 9a4 4 0 0 1 0 6M18.2 6.4a7.6 7.6 0 0 1 0 11.2")],
  logo: [p("M10 7.8a5.4 5.4 0 0 1 0 8.4M13.4 4.9a9.4 9.4 0 0 1 0 14.2M16.8 2a13.6 13.6 0 0 1 0 20"), dot(5.8, 12, 2.4)],
  sign: [["rect", { x: 3, y: 4, width: 18, height: 12, rx: 1.5 }], p("M7 8.5h10M7 12h6"), p("M12 16v4.5M8.5 20.5h7")],
};

const KIND_ICON = {
  smoke: "flame",
  co: "warn",
  baby: "baby",
  glass: "glass",
  scream: "scream",
  doorbell: "bell",
  knock: "door",
  siren: "siren",
  phone: "phone",
  alarm: "clock",
  dog: "paw",
  horn: "car",
  water: "drop",
  cat: "cat",
  speech: "speech",
  name: "name",
  reply: "message",
  ack: "check",
};

/** The icon for an alert kind ("custom-..." sounds you taught HARK get a star). */
export function iconFor(kind) {
  if (String(kind).startsWith("custom")) return "star";
  return KIND_ICON[kind] || "star";
}

export const DEVICE_ICON = { phone: "smartphone", tablet: "tablet", computer: "computer" };

const NS = "http://www.w3.org/2000/svg";

/** An <svg> icon; colour follows CSS `color`. */
export function icon(name, { size = 24, label, className } = {}) {
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "2");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("class", `icon${className ? ` ${className}` : ""}`);
  svg.setAttribute("focusable", "false");
  if (label) {
    svg.setAttribute("role", "img");
    svg.setAttribute("aria-label", label);
  } else svg.setAttribute("aria-hidden", "true");
  for (const [tag, attrs] of SHAPES[name] || SHAPES.star) {
    const el = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
    svg.append(el);
  }
  return svg;
}

export const ICON_NAMES = Object.keys(SHAPES);
