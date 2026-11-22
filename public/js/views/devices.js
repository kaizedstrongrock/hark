// Devices: this device, the other devices of the home, and how to connect one more.
import { h, mount, formatCode } from "../ui/dom.js";
import { icon, DEVICE_ICON } from "../ui/icons.js";
import { qrSvg } from "../ui/qr.js";
import { deviceRow, kindWord, devicesKey } from "../ui/parts.js";
import { hubLabel, normalizeCode } from "../core/protocol.js";

export function render(root, hark) {
  // ---- this device
  const nameInput = h("input#device-name", { type: "text", maxlength: 32, value: hark.device.name, autocomplete: "off" });
  const nameForm = h(
    "form.inline-form",
    {
      onsubmit: (e) => {
        e.preventDefault();
        const v = nameInput.value.trim();
        if (!v) return nameInput.focus();
        hark.renameDevice(v);
        hark.toast(`This device is now called "${v}"`, "ok");
      },
    },
    h("label.field-label", { for: "device-name" }, "Name of this device"),
    h("p.hint#name-hint", "Shown on your other devices when this one hears something, for example \"Kitchen tablet\"."),
    h("div.reply-row", nameInput, h("button.btn.primary", { type: "submit" }, "Save name")),
  );
  nameInput.setAttribute("aria-describedby", "name-hint");
  const thisStatus = h("p.row-status");
  const thisCard = h("section.card", { "aria-labelledby": "this-title" }, h("div.status-head", h("span.status-icon.off", { "aria-hidden": "true" }, icon(DEVICE_ICON[hark.device.kind], { size: 40 })), h("h2#this-title", "This device")), thisStatus, nameForm);

  // ---- the home network
  const netText = h("p.lead");
  const netList = h("ul.device-list");
  const netCard = h("section.card", { "aria-labelledby": "net2-title" }, h("h2#net2-title", "Your home network"), netText, netList);

  // ---- add a device
  const addBody = h("div");
  const addCard = h("section.card", { "aria-labelledby": "add-title" }, h("h2#add-title", "Connect another device"), addBody);

  // ---- join another home
  const codeInput = h("input#join-code", { type: "text", maxlength: 7, autocomplete: "off", autocapitalize: "characters", spellcheck: false, placeholder: "K7Q-4MX" });
  const addrInput = h("input#join-addr", { type: "text", maxlength: 80, autocomplete: "off", spellcheck: false, inputmode: "url", placeholder: "192.168.1.20:3000" });
  const joinErr = h("p.error-box", { hidden: true, role: "alert" });
  const joinCard = h(
    "section.card",
    { "aria-labelledby": "join-title" },
    h("h2#join-title", "Join your other devices"),
    h("p", "On a device that is already set up, open Devices to see its home code and address. Type them here."),
    h(
      "form",
      {
        onsubmit: (e) => {
          e.preventDefault();
          joinErr.hidden = true;
          const code = normalizeCode(codeInput.value);
          if (!code) return showJoinError("A home code has 6 letters and numbers, like K7Q-4MX.", codeInput);
          try {
            hark.joinHome(code, addrInput.value.trim() || undefined);
            hark.toast("Connecting to your other devices…", "ok");
            codeInput.value = "";
            addrInput.value = "";
          } catch (err) {
            showJoinError(err.message, addrInput);
          }
        },
      },
      h("label.field-label", { for: "join-code" }, "Home code"),
      codeInput,
      h("label.field-label", { for: "join-addr" }, "Address of the computer (if it shows one)"),
      addrInput,
      joinErr,
      h("button.btn.primary.wide", { type: "submit" }, "Join"),
    ),
  );
  function showJoinError(text, focus) {
    joinErr.textContent = text;
    joinErr.hidden = false;
    focus?.focus();
  }

  // ---- advanced
  const hubList = h("ul.hub-list");
  const hubInput = h("input#hub-addr", { type: "text", maxlength: 80, autocomplete: "off", spellcheck: false, inputmode: "url", placeholder: "192.168.1.20:3000" });
  const hubErr = h("p.error-box", { hidden: true, role: "alert" });
  const newHomeConfirm = h(
    "div.confirm",
    { hidden: true },
    h("p", "Start a new home code? This device will stop sharing alerts with your other devices until you connect them again."),
    h(
      "div.row",
      h("button.btn.danger", { type: "button", onclick: () => (hark.newHome(), (newHomeConfirm.hidden = true), hark.toast("New home code made", "ok")) }, "Yes, new home code"),
      h("button.btn.secondary", { type: "button", onclick: () => (newHomeConfirm.hidden = true) }, "Cancel"),
    ),
  );
  const advanced = h(
    "details.card.advanced",
    h("summary", h("span", "Advanced"), icon("chevronRight", { size: 24, className: "chev" })),
    h("h3", "Home hubs this device knows"),
    h("p.small", "A hub is a computer at home running HARK (npm start). Devices find it on the home Wi-Fi by themselves."),
    hubList,
    h(
      "form.inline-form",
      {
        onsubmit: (e) => {
          e.preventDefault();
          hubErr.hidden = true;
          try {
            hark.addHubAddress(hubInput.value);
            hubInput.value = "";
            hark.toast("Looking for that hub…");
          } catch (err) {
            hubErr.textContent = err.message;
            hubErr.hidden = false;
          }
        },
      },
      h("label.field-label", { for: "hub-addr" }, "Add a hub by its address"),
      h("div.reply-row", hubInput, h("button.btn.secondary", { type: "submit" }, "Add")),
      hubErr,
    ),
    h("h3", "Home code"),
    h("button.btn.secondary", { type: "button", onclick: () => ((newHomeConfirm.hidden = false), newHomeConfirm.querySelector("button").focus()) }, "Start a new home code"),
    newHomeConfirm,
  );

  mount(root, h("div.page", h("h1", { tabindex: "-1" }, "Devices"), h("div.home-grid", h("div.col", thisCard, netCard, joinCard), h("div.col", addCard, advanced))));

  let lastAddKey = "";
  function renderAdd() {
    const code = hark.home.code;
    const local = hark.localHub;
    const shareBase = local?.urls.find((u) => !/\/\/(localhost|127\.)/.test(u)) || hark.link?.shareableHubs()[0]?.urls[0] || null;
    const url = hark.shareUrl(shareBase);
    const key = `${code}|${url}`;
    if (key === lastAddKey) return;
    lastAddKey = key;
    // shown as K7Q-4MX; read out letter by letter ("K 7 Q 4 M X") by screen readers
    const codeBox = h("div.code-box", h("span.code-label", "Home code"), h("span.code-value", { "aria-hidden": "true" }, formatCode(code)), h("span.sr-only", code.split("").join(" ")));
    if (!url && local) {
      mount(addBody, h("p", "This computer runs the home hub, but it is not on a Wi-Fi or wired network right now. Connect it to your home network, then come back to this page."), codeBox);
      return;
    }
    if (!url) {
      mount(
        addBody,
        h("p", "To connect your devices, one computer at home runs the HARK hub. On that computer, start HARK (npm start), open it, and connect your devices from its Devices page."),
        h("p", "Your other devices can also join this device's home with this code, once a hub is running:"),
        codeBox,
      );
      return;
    }
    mount(
      addBody,
      h(
        "ol.steps-list",
        h("li", "Install the HARK app on the other device, or open its web browser."),
        h("li", "Make sure it is on the same Wi-Fi as this one."),
        h("li", "Point its camera at this code, and tap the link. Or, in the HARK app, open Devices and type the home code and address below."),
      ),
      h("div.qr", { dataset: { url } }, qrSvg(url, "QR code to connect another device")),
      codeBox,
      h("div.code-box", h("span.code-label", "Address"), h("span.code-value.addr", hubLabel(shareBase))),
      h("p.small", "Phones and tablets connect over your home Wi-Fi. If they cannot connect, check that the computer's firewall allows HARK on private networks."),
    );
  }

  function update() {
    const k = kindWord(hark.device.kind);
    thisStatus.textContent = `${hark.isListening ? "Listening" : "Not listening"} · this ${k}`;
    thisStatus.className = `row-status ${hark.isListening ? "on" : "off"}`;
    const devices = hark.devices();
    const net = hark.networkState;
    netText.textContent =
      net === "connected"
        ? "These devices are connected now. Whatever one of them hears, all of them show."
        : net === "hub"
          ? "This computer is your home hub. No other device is connected right now."
          : hark.link?.hubs.length
            ? "Not connected right now. This device connects by itself when it is on your home Wi-Fi."
            : "This device is not connected to any other device yet.";
    const devKey = devicesKey(devices);
    if (devKey !== netList.dataset.key) {
      netList.dataset.key = devKey;
      mount(netList, devices.map(deviceRow));
    }
    renderAdd();
    const connected = new Set((hark.link?.connectedHubs || []).map((x) => x.id));
    const hubKey = (hark.link?.hubs || []).map((x) => `${x.key}:${x.name}:${x.urls.join()}:${connected.has(x.id) ? 1 : 0}`).join("|");
    if (hubKey === hubList.dataset.key) return;
    hubList.dataset.key = hubKey;
    mount(
      hubList,
      (hark.link?.hubs || []).map((hub) =>
        h(
          "li.hub-row",
          h("div.row-body", h("p.row-title", hub.name || "HARK hub", hub.local ? h("span.tag", "this computer") : null), h("p.row-meta", hub.urls.map(hubLabel).join(", ")), h(`p.row-status.${connected.has(hub.id) ? "on" : "off"}`, connected.has(hub.id) ? "Connected" : "Not reachable right now")),
          hub.local ? null : h("button.btn.secondary.small", { type: "button", "aria-label": `Forget ${hub.name || "hub"} ${hub.urls.map(hubLabel).join(", ")}`, onclick: () => hark.removeHub(hub.key) }, icon("trash", { size: 22 }), h("span", "Forget")),
        ),
      ),
    );
    if (!hark.link?.hubs.length) mount(hubList, h("li.empty", "None yet."));
  }
  const off = hark.on("change", update);
  update();
  return off;
}
