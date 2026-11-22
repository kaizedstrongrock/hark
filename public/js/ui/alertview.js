// The full-screen alert: what HARK heard, where, and one big "I've seen it" button.
// Urgent alerts flash (once a second - under the WCAG limit of 3 flashes per second - and not at all with
// "reduce motion") and keep buzzing until someone acknowledges them on any device.
import { h, mount, ago } from "./dom.js";
import { icon, iconFor } from "./icons.js";
import { openModal, closeModal } from "./modal.js";

export const QUICK_REPLIES = ["I'm coming!", "One minute, please.", "Please leave it at the door.", "Who is it?", "Please wait, I'm on my way.", "Please send me a text message."];

export function mountAlertView(parent, hark) {
  const title = h("h2.alert-title#alert-title");
  const kicker = h("p.alert-kicker");
  const where = h("p.alert-where#alert-where");
  const advice = h("p.alert-advice", { hidden: true });
  const detail = h("p.alert-detail");
  const more = h("ul.alert-more", { "aria-label": "Other alerts" });
  const iconBox = h("div.alert-icon", { "aria-hidden": "true" });
  const seenBtn = h("button.btn.primary.huge.alert-seen", { type: "button", onclick: () => seen() }, icon("check", { size: 30 }), h("span", "I've seen it"));
  const replyBtn = h("button.btn.secondary.alert-reply-btn", { type: "button", "aria-expanded": "false", onclick: () => toggleReply() }, icon("message", { size: 26 }), h("span", "Reply"));
  const replyText = h("input#reply-text", { type: "text", maxlength: 140, autocomplete: "off", enterkeyhint: "send" });
  const speakBox = h("input", { type: "checkbox", role: "switch", checked: true });
  const replyStatus = h("p.reply-status", { role: "status" });
  const replyPanel = h(
    "div.reply-panel",
    { hidden: true },
    h("p.reply-intro", "Your message is shown in large letters on the device that heard it, and read out loud."),
    h(
      "div.quick-replies",
      QUICK_REPLIES.map((t) => h("button.btn.secondary.quick", { type: "button", onclick: () => sendReply(t) }, t)),
    ),
    h(
      "form.reply-form",
      {
        onsubmit: (e) => {
          e.preventDefault();
          const t = replyText.value.trim();
          if (t) sendReply(t);
        },
      },
      h("label.field-label", { for: "reply-text" }, "Or type your own message"),
      h("div.reply-row", replyText, h("button.btn.primary", { type: "submit" }, "Send")),
    ),
    h("label.switch-row.compact", speakBox, h("span.switch-ui", { "aria-hidden": "true" }), h("span.switch-text", h("span.switch-label", "Read my message out loud"))),
    replyStatus,
  );
  const card = h(
    "div.alert-card",
    iconBox,
    kicker,
    title,
    where,
    advice,
    h("div.alert-actions", seenBtn, replyBtn),
    replyPanel,
    detail,
    more,
  );
  const overlay = h("div.alert-overlay", { hidden: true, role: "alertdialog", "aria-modal": "true", "aria-labelledby": "alert-title", "aria-describedby": "alert-where" }, card);
  parent.append(overlay);

  let shownKey = null;
  let current = null;
  let returnFocus = null;

  function seen() {
    // one press acknowledges everything that is waiting (as on the old pager: one OK clears every alarm)
    hark.acknowledgeAll();
  }

  function toggleReply(force) {
    const open = force ?? replyPanel.hidden;
    replyPanel.hidden = !open;
    replyBtn.setAttribute("aria-expanded", String(open));
    if (open) replyPanel.querySelector("button")?.focus();
  }

  async function sendReply(text) {
    if (!current) return;
    replyStatus.textContent = "Sending…";
    const r = await hark.reply(current.key, text, speakBox.checked);
    if (r.ok) {
      replyStatus.textContent = r.recipients ? `Sent: "${text}"` : `Sent: "${text}" (the other device may be offline)`;
      replyText.value = "";
      hark.toast(`Message sent: "${text}"`, "ok");
    } else replyStatus.textContent = `Not sent: ${r.error === "not connected" ? "this device is not connected to your other devices" : r.error}`;
  }

  function update() {
    const open = hark.settings.showAlerts ? hark.alerts.open() : [];
    const e = open[0] || null;
    if (!e) {
      if (!overlay.hidden) {
        overlay.hidden = true;
        closeModal(overlay);
        document.body.classList.remove("alert-open");
        document.title = hark.screenTitle || "HARK";
        shownKey = null;
        current = null;
        returnFocus?.focus?.();
        returnFocus = null;
      }
      return;
    }
    current = e;
    const urgent = e.priority === "urgent";
    overlay.className = `alert-overlay ${urgent ? "urgent" : "normal"}${urgent && hark.settings.flash ? " flashing" : ""}`;
    mount(iconBox, icon(iconFor(e.kind), { size: 96 }));
    kicker.textContent = `${urgent ? "Urgent alert" : "Alert"}${e.test ? " · test" : ""}`;
    title.textContent = e.label;
    where.textContent = `${hark.whereLabel(e)} · ${ago(e.at)}`;
    advice.hidden = !e.advice;
    advice.textContent = e.advice || "";
    detail.textContent = e.detail ? `How HARK knew: ${e.detail}` : "";
    const others = e.heardBy.some((d) => d.id !== hark.device.id);
    replyBtn.hidden = !others || !hark.link?.connected;
    if (replyBtn.hidden) toggleReply(false);
    mount(
      more,
      open.slice(1).map((x) => h("li", icon(iconFor(x.kind), { size: 26 }), h("span", h("b", x.label), ` · ${hark.whereLabel(x)} · ${ago(x.at)}`))),
    );
    seenBtn.querySelector("span").textContent = open.length > 1 ? `I've seen them (${open.length})` : "I've seen it";
    document.title = `${urgent ? "URGENT: " : ""}${e.label} · HARK`;
    if (overlay.hidden) {
      returnFocus = document.activeElement;
      overlay.hidden = false;
      openModal(overlay);
      document.body.classList.add("alert-open");
    }
    if (shownKey !== e.key) {
      shownKey = e.key;
      replyStatus.textContent = "";
      toggleReply(false);
      seenBtn.focus();
    }
  }

  overlay.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape" && current && current.priority !== "urgent") {
      ev.preventDefault();
      seen();
    }
    if (ev.key === "Tab") {
      // keep keyboard focus inside the alert while it is open
      const f = [...overlay.querySelectorAll("button, input, [href], [tabindex]:not([tabindex='-1'])")].filter((x) => !x.disabled && x.offsetParent !== null);
      if (!f.length) return;
      const first = f[0];
      const last = f[f.length - 1];
      if (ev.shiftKey && document.activeElement === first) {
        ev.preventDefault();
        last.focus();
      } else if (!ev.shiftKey && document.activeElement === last) {
        ev.preventDefault();
        first.focus();
      }
    }
  });
  hark.on("change", update);
  setInterval(() => current && (where.textContent = `${hark.whereLabel(current)} · ${ago(current.at)}`), 20000);
  update();
}
