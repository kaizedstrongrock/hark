// Join a home, from a QR code or link: #/join?h=K7Q4MX (the page's own hub is the address), or in the
// companion app hark://join?h=K7Q4MX&hub=http://192.168.1.20:3000/
import { h, mount, formatCode } from "../ui/dom.js";
import { icon } from "../ui/icons.js";
import { normalizeCode, normalizeHubAddress, hubLabel } from "../core/protocol.js";

export function render(root, hark, params) {
  const code = normalizeCode(params.get("h"));
  const hub = normalizeHubAddress(params.get("hub") || "") || null;
  const card = h("section.card");
  mount(root, h("div.page.narrow", h("h1", { tabindex: "-1" }, "Join your other devices"), card));
  if (!code) {
    mount(card, h("p.lead", "This link does not contain a valid home code."), h("a.btn.primary.wide", { href: "#/devices" }, "Go to Devices"));
    return;
  }
  if (code === hark.home.code && !hub) {
    mount(card, h("div.status-head", h("span.status-icon.on", { "aria-hidden": "true" }, icon("check", { size: 40 })), h("h2", "Already joined")), h("p.lead", `This device is already part of the home with code ${formatCode(code)}.`), h("a.btn.primary.wide", { href: "#/" }, "Go to Home"));
    return;
  }
  mount(
    card,
    h("p.lead", `Connect this device (${hark.device.name}) to the devices with home code ${formatCode(code)}?`),
    hub ? h("p", `Home hub: ${hubLabel(hub)}`) : null,
    h("p", "Afterwards, whatever one device hears, all of them show. This device keeps listening on its own when it is away from home."),
    h(
      "div.row",
      h(
        "button.btn.primary.huge",
        {
          type: "button",
          onclick: () => {
            try {
              hark.joinHome(code, hub || undefined);
              hark.toast("Joined. Connecting to your other devices…", "ok");
              location.hash = "#/";
            } catch (e) {
              hark.toast(e.message, "error");
            }
          },
        },
        "Join",
      ),
      h("a.btn.secondary", { href: "#/" }, "Not now"),
    ),
  );
}
