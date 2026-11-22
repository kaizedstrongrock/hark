// Settings. Every change takes effect straight away and is kept on this device.
import { h, mount, switchField, radioGroup } from "../ui/dom.js";
import { icon, iconFor } from "../ui/icons.js";
import { ALERTS, TEST_SOUNDS } from "../app/hark.js";
import { Captions } from "../speech/captions.js";
import * as platform from "../platform.js";

export function render(root, hark) {
  const saved = h("p.sr-only", { role: "status", "aria-live": "polite" });
  let savedTimer;
  const save = (patch, what = "Saved") => {
    hark.saveSettings(patch);
    saved.textContent = "";
    clearTimeout(savedTimer);
    savedTimer = setTimeout(() => (saved.textContent = what), 50);
  };
  const s = () => hark.settings;

  // ---- sounds to listen for
  const soundList = h(
    "ul.switch-list",
    ALERTS.map((a) =>
      h(
        "li",
        h("span.row-icon", { "aria-hidden": "true" }, icon(iconFor(a.id), { size: 28 })),
        switchField({
          label: a.label,
          hint: a.priority === "urgent" ? "Urgent: keeps alerting until someone has seen it" : a.defaultOff ? "Off at first" : undefined,
          checked: hark.alertEnabled(a.id),
          onchange: (on) => {
            hark.setAlertEnabled(a.id, on);
            save({}, `${a.label}: ${on ? "on" : "off"}`);
          },
        }),
      ),
    ),
  );

  // ---- your own sounds
  const customList = h("ul.custom-list");
  const sampleBtn = h("button.btn.secondary", { type: "button" });
  function renderCustoms() {
    mount(
      customList,
      hark.customs.length
        ? hark.customs.map((c) =>
            h(
              "li",
              h("span.row-icon", { "aria-hidden": "true" }, icon("star", { size: 28 })),
              h("div.row-body", h("p.row-title", c.label), h("p.row-meta", `${c.priority === "urgent" ? "Urgent" : c.priority === "info" ? "Quiet" : "Normal"} alert · learned ${c.model.quality === "good" ? "well" : c.model.quality === "ok" ? "fairly well" : "poorly (try teaching it again)"}`)),
              h("button.btn.secondary.small", { type: "button", "aria-label": `Delete ${c.label}`, onclick: () => (hark.deleteSound(c.id), save({}, `${c.label} deleted`)) }, icon("trash", { size: 22 }), h("span", "Delete")),
            ),
          )
        : h("li.empty", "None yet. Every doorbell, microwave and washing machine sounds different: teach HARK yours with 3 short recordings."),
    );
    const hasSample = hark.customs.some((c) => c.sample);
    mount(sampleBtn, hasSample ? "Ring the sample doorbell" : "Try it: learn a sample doorbell");
    sampleBtn.onclick = async () => {
      sampleBtn.disabled = true;
      try {
        if (hasSample) await hark.ringSampleChime();
        else {
          hark.toast("Learning the sample doorbell from 3 rings…");
          await hark.teachSampleChime();
          hark.toast('Learned "Front door"', "ok");
        }
      } finally {
        sampleBtn.disabled = false;
      }
    };
  }

  const vibeStatus = h("p.small", { role: "status" });

  // ---- notifications
  const notifyRow = h("div.notify-row");
  async function renderNotify() {
    const st = await platform.notificationState();
    const text = {
      granted: "Notifications are on. Alerts also appear when HARK is in the background.",
      denied: "Notifications are blocked. To allow them, change the setting for HARK in your browser or phone settings.",
      default: "Allow notifications, so alerts also appear when HARK is in the background.",
      unsupported: "Notifications are not available here. Keep HARK open on the screen.",
    }[st];
    mount(
      notifyRow,
      h("p", text),
      st === "default" ? h("button.btn.secondary", { type: "button", onclick: async () => (await platform.requestNotifications(), renderNotify()) }, icon("bell", { size: 24 }), h("span", "Allow notifications")) : null,
    );
  }

  // ---- text fields that save on demand
  const doorMsg = h("textarea#door-msg", { rows: 3, maxlength: 160 }, s().doorMessage);
  const namesInput = h("input#names", { type: "text", value: s().names.join(", "), placeholder: "Alex, Grandma", autocomplete: "off" });

  // ---- test sounds
  const tests = h(
    "div.test-grid",
    Object.entries(TEST_SOUNDS).map(([id, t]) => h("button.btn.secondary", { type: "button", onclick: () => hark.testSound(id) }, icon("play", { size: 22 }), h("span", t.label))),
  );

  const section = (id, title, ...body) => h("section.card", { "aria-labelledby": id }, h(`h2#${id}`, title), ...body);
  mount(
    root,
    h(
      "div.page.settings",
      h("h1", { tabindex: "-1" }, "Settings"),
      saved,
      h(
        "div.home-grid",
        h(
          "div.col",
          section("set-sounds", "Sounds HARK listens for", h("p", "Turn off any sound you do not want to be alerted about."), soundList),
          section(
            "set-own",
            "Sounds you taught HARK",
            customList,
            h("div.row", h("a.btn.primary", { href: "#/teach" }, icon("plus", { size: 24 }), h("span", "Teach HARK a new sound")), sampleBtn),
          ),
        ),
        h(
          "div.col",
          section(
            "set-alerting",
            "How this device alerts you",
            switchField({ label: "Show alerts on this device", hint: "Turn off for a device that only listens, for example in a nursery", checked: s().showAlerts, onchange: (v) => save({ showAlerts: v }) }),
            platform.canVibrate ? switchField({ label: "Vibrate", hint: "Every sound has its own buzz pattern, so you can tell them apart without looking", checked: s().vibrate, onchange: (v) => save({ vibrate: v }) }) : null,
            platform.canVibrate ? h("div.row", h("button.btn.secondary.small", { type: "button", onclick: () => (vibeStatus.textContent = hark.testVibration() ? "This device should be vibrating now." : "This device did not vibrate. Check that vibration is turned on in its settings.") }, "Test vibration"), vibeStatus) : null,
            !platform.canVibrate && !platform.isNative && /iPhone|iPad|iPod/.test(navigator.userAgent) ? h("p.small", "iPhones and iPads cannot vibrate for a web page. Install the HARK app to get vibration.") : null,
            switchField({ label: "Flash the screen for urgent alerts", hint: "Once a second, never faster", checked: s().flash, onchange: (v) => save({ flash: v }) }),
            switchField({ label: "Play a low beep", hint: "A deep tone that is easier to hear with hearing loss", checked: s().tone, onchange: (v) => save({ tone: v }) }),
            notifyRow,
          ),
          section(
            "set-listening",
            "Listening",
            switchField({ label: "Start listening when HARK opens", checked: s().autoListen, onchange: (v) => save({ autoListen: v }) }),
            radioGroup({
              legend: "How easily should HARK alert you?",
              name: "sensitivity",
              value: s().sensitivity,
              options: [
                { value: "low", label: "Only clear sounds", hint: "Fewer alerts" },
                { value: "normal", label: "Normal" },
                { value: "high", label: "Also quieter or distant sounds", hint: "More alerts, sometimes by mistake" },
              ],
              onchange: (v) => save({ sensitivity: v }),
            }),
          ),
          section(
            "set-text",
            "Text size",
            radioGroup({
              legend: "Size of the text in HARK",
              name: "textsize",
              value: s().textSize,
              options: [
                { value: "normal", label: "Standard" },
                { value: "large", label: "Large" },
                { value: "larger", label: "Extra large" },
              ],
              onchange: (v) => save({ textSize: v }, "Text size changed"),
            }),
          ),
          section(
            "set-door",
            "Visitors at the door",
            switchField({ label: "Show visitors a sign", hint: "When this device hears a knock or the doorbell, it shows the message below in large letters", checked: s().doorSign, onchange: (v) => save({ doorSign: v }) }),
            h("label.field-label", { for: "door-msg" }, "The sign says"),
            doorMsg,
            h("button.btn.secondary", { type: "button", onclick: () => save({ doorMessage: doorMsg.value.trim() || s().doorMessage }, "Sign message saved") }, "Save the sign"),
            switchField({ label: "Read replies out loud", hint: "When you reply to an alert from another device, this device reads your message out loud", checked: s().speakReplies, onchange: (v) => save({ speakReplies: v }) }),
          ),
          section(
            "set-names",
            "When someone says your name",
            switchField({
              label: "Alert me when someone says my name",
              hint: Captions.supported() ? "Uses the browser's speech recognition, which may send speech to the browser maker. Sound alerts never do." : "Not available in this browser.",
              checked: s().captions,
              onchange: (v) => save({ captions: v }),
            }),
            h("label.field-label", { for: "names" }, "Names to listen for (separate with commas)"),
            namesInput,
            h(
              "button.btn.secondary",
              {
                type: "button",
                onclick: () =>
                  save(
                    {
                      names: namesInput.value
                        .split(",")
                        .map((x) => x.trim().slice(0, 24))
                        .filter(Boolean)
                        .slice(0, 8),
                    },
                    "Names saved",
                  ),
              },
              "Save names",
            ),
          ),
          section(
            "set-test",
            "Try a test sound",
            h("p", "Check that HARK works. Test alerts are marked as tests and are shown on all your connected devices."),
            radioGroup({
              legend: "How to play the test sound",
              name: "testmode",
              value: s().testMode,
              options: [
                { value: "feed", label: "Silently, straight into HARK" },
                { value: "air", label: "Out loud through the speaker", hint: "Other devices nearby can hear it too" },
              ],
              onchange: (v) => save({ testMode: v }),
            }),
            tests,
          ),
          section(
            "set-about",
            "About HARK",
            h("p", "HARK listens for important sounds and alerts you on every device you own. Sounds are recognised on each device (Google's YAMNet sound model, plus HARK's own smoke and carbon monoxide alarm rhythm detector). Audio is never recorded or sent anywhere: only the alert itself travels to your other devices, over your home Wi-Fi."),
            h("p", h("b", "Safety: "), "HARK adds to your smoke and carbon monoxide alarms. It does not replace them. Keep certified alarms, including ones with strobe lights or bed shakers."),
            h("p.small", `This device: ${hark.device.name} · home code ${hark.home.code.slice(0, 3)}-${hark.home.code.slice(3)} · ${platform.isNative ? `HARK app (${platform.platformName})` : "web browser"}`),
          ),
        ),
      ),
    ),
  );
  renderCustoms();
  renderNotify();
  const off = hark.on("change", () => {
    if (customList.dataset.n !== String(hark.customs.length)) {
      customList.dataset.n = String(hark.customs.length);
      renderCustoms();
    }
  });
  customList.dataset.n = String(hark.customs.length);
  return () => {
    off();
    clearTimeout(savedTimer);
  };
}
