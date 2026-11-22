// QR code as an SVG element (qrcode-generator by Kazuhiko Arase, MIT licence, vendored).
// Always dark modules on a white background (in dark mode too), which every phone camera can read.
import qrcode from "../../vendor/qrcode/qrcode.mjs";

export function qrSvg(text, label = "QR code") {
  const qr = qrcode(0, "M");
  qr.addData(text);
  qr.make();
  const n = qr.getModuleCount();
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", `0 0 ${n + 8} ${n + 8}`);
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", label);
  svg.setAttribute("shape-rendering", "crispEdges");
  const bg = document.createElementNS(ns, "rect");
  bg.setAttribute("width", String(n + 8));
  bg.setAttribute("height", String(n + 8));
  bg.setAttribute("fill", "#ffffff");
  svg.append(bg);
  let d = "";
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) d += `M${c + 4} ${r + 4}h1v1h-1z`;
  const path = document.createElementNS(ns, "path");
  path.setAttribute("d", d);
  path.setAttribute("fill", "#000000");
  svg.append(path);
  return svg;
}
