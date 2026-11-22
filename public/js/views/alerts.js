// Alerts: everything HARK heard on this device and on the other devices of the home, newest first.
import { h, mount, dayLabel } from "../ui/dom.js";
import { alertRow, eventsKey } from "../ui/parts.js";

export function render(root, hark) {
  const list = h("div.alert-days");
  const clearBtn = h("button.btn.secondary", { type: "button", onclick: () => confirmClear() }, "Clear the list");
  const confirmBox = h(
    "div.confirm",
    { hidden: true, role: "group", "aria-labelledby": "confirm-q" },
    h("p#confirm-q", "Remove all alerts from this list? (Alerts that still need attention stay.)"),
    h(
      "div.row",
      h("button.btn.danger", { type: "button", onclick: () => (hark.clearHistory(), (confirmBox.hidden = true), clearBtn.focus()) }, "Yes, clear the list"),
      h("button.btn.secondary", { type: "button", onclick: () => ((confirmBox.hidden = true), clearBtn.focus()) }, "No, keep it"),
    ),
  );
  mount(
    root,
    h(
      "div.page",
      h("h1", { tabindex: "-1" }, "Alerts"),
      h("p.lead", "Every alert from this device and from your other devices. When one device hears something, they all show it once."),
      list,
      h("div.page-foot", clearBtn, confirmBox),
    ),
  );

  function confirmClear() {
    confirmBox.hidden = false;
    confirmBox.querySelector("button").focus();
  }

  let lastKey = null;
  function update() {
    const events = hark.alerts.list();
    const key = eventsKey(events);
    if (key === lastKey) return; // unchanged: keep the list (and the keyboard focus in it) as it is
    lastKey = key;
    if (!events.length) {
      mount(list, h("p.empty", "No alerts yet."));
      clearBtn.hidden = true;
      return;
    }
    clearBtn.hidden = false;
    const days = new Map();
    for (const e of events) {
      const d = dayLabel(e.at);
      if (!days.has(d)) days.set(d, []);
      days.get(d).push(e);
    }
    mount(
      list,
      [...days].map(([day, es]) => h("section.card", h("h2", day), h("ul.alert-list", es.map((e) => alertRow(e, hark))))),
    );
  }
  const off = hark.on("change", update);
  update();
  return off;
}
