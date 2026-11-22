// Full-screen layers (the alert, the message board). While one is open, everything behind it is inert:
// it cannot be focused, clicked or read by a screen reader, so the alert really has the person's attention.
const stack = [];

function apply() {
  const top = stack[stack.length - 1] || null;
  for (const el of document.body.children) {
    if (el.classList.contains("toasts") || el.classList.contains("sr-only")) continue; // keep announcements audible
    if (top && el !== top) el.setAttribute("inert", "");
    else el.removeAttribute("inert");
  }
}

export function openModal(el) {
  const i = stack.indexOf(el);
  if (i >= 0) stack.splice(i, 1);
  stack.push(el);
  apply();
}

export function closeModal(el) {
  const i = stack.indexOf(el);
  if (i >= 0) stack.splice(i, 1);
  apply();
}
