// Teach HARK a sound: name it, record it 3 times, done. Learned on this device.
import { h, mount, radioGroup } from "../ui/dom.js";
import { icon } from "../ui/icons.js";

export function render(root, hark) {
  const body = h("div.card.teach");
  mount(root, h("div.page.narrow", h("a.link-btn.back", { href: "#/settings" }, icon("chevronLeft", { size: 22 }), "Back to Settings"), h("h1", { tabindex: "-1" }, "Teach HARK a sound"), body));
  let cancelled = false;
  let busy = false;

  function stepName() {
    const name = h("input#teach-name", { type: "text", maxlength: 24, autocomplete: "off", placeholder: "For example: Microwave" });
    const err = h("p.error-box", { hidden: true, role: "alert" });
    let priority = "normal";
    mount(
      body,
      h("p.lead", "Your doorbell, the microwave, the washing machine, the kettle… HARK learns any sound from 3 short recordings."),
      h(
        "form",
        {
          onsubmit: (e) => {
            e.preventDefault();
            const label = name.value.trim();
            if (!label) {
              err.textContent = "Please give the sound a name.";
              err.hidden = false;
              return name.focus();
            }
            stepRecord({ label, priority, recs: [] });
          },
        },
        h("label.field-label", { for: "teach-name" }, "1. What is the sound called?"),
        name,
        err,
        radioGroup({
          legend: "2. When HARK hears it",
          name: "teach-prio",
          value: priority,
          options: [
            { value: "normal", label: "Alert me" },
            { value: "urgent", label: "Alert me urgently", hint: "Keeps alerting until someone has seen it" },
            { value: "info", label: "Just let me know quietly" },
          ],
          onchange: (v) => (priority = v),
        }),
        h("button.btn.primary.wide", { type: "submit" }, "Next: record it"),
      ),
    );
    name.focus();
  }

  function stepRecord(state) {
    const n = state.recs.length;
    const msg = h("p.lead", { "aria-live": "polite" }, h("b", `Recording ${n + 1} of 3. `), `Get the ${state.label.toLowerCase()} ready. Press Record, then make the sound within 4 seconds.`);
    const rec = h("button.btn.primary.huge.wide", { type: "button", onclick: () => record(state, msg, rec) }, icon("mic", { size: 30 }), h("span", "Record"));
    mount(
      body,
      h("h2", state.label),
      h("ol.progress", { "aria-label": `${n} of 3 recordings done` }, [0, 1, 2].map((i) => h(`li${i < n ? ".done" : i === n ? ".now" : ""}`, h("span", i < n ? "Done" : `Recording ${i + 1}`)))),
      msg,
      rec,
      h("button.btn.secondary.wide", { type: "button", onclick: () => ((cancelled = true), (location.hash = "#/settings")) }, "Cancel"),
    );
    rec.focus();
  }

  async function record(state, msg, btn) {
    if (busy) return;
    busy = true;
    btn.disabled = true;
    try {
      const windows = await hark.recordSample(4, (s) => mount(msg, h("b", `Listening… ${s}`), " Make the sound now."));
      if (cancelled) return;
      if (!windows.length) {
        mount(msg, h("b", "I did not hear anything clear. "), "Try again, a little louder or closer to this device.");
        return;
      }
      state.recs.push(windows);
      if (state.recs.length < 3) return stepRecord(state);
      mount(msg, h("b", "Learning your sound…"));
      const item = await hark.trainSound(state, (s) => mount(msg, h("b", `Now please stay quiet for ${s} seconds`), " so HARK learns what the room normally sounds like."));
      if (cancelled) return;
      mount(
        body,
        h("div.status-head", h("span.status-icon.on", { "aria-hidden": "true" }, icon("check", { size: 40 })), h("h2", `HARK learned "${item.label}"`)),
        h("p.lead", item.model.quality === "poor" ? "It may be hard to tell apart from the normal sounds of your room. If you get alerts by mistake, delete it and teach it again in a quieter moment." : "From now on, when HARK hears it, you get an alert on all your devices."),
        h("a.btn.primary.wide", { href: "#/settings" }, "Done"),
      );
      body.querySelector("a").focus();
    } catch (e) {
      mount(msg, h("b", "Recording did not work. "), e.message || String(e));
    } finally {
      busy = false;
      btn.disabled = false;
    }
  }

  stepName();
  return () => {
    cancelled = true;
  };
}
