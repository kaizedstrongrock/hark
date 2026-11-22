// The message board: a reply from the person's phone ("I'm coming!") or the visitor sign, shown in
// very large letters on the device that heard the door. Tap anywhere (or press Close) to close it.
import { h } from "./dom.js";
import { openModal, closeModal } from "./modal.js";

export function mountBoard(parent, hark) {
  const text = h("p.board-text");
  const sub = h("p.board-sub");
  const close = h("button.btn.secondary.board-close", { type: "button", onclick: (e) => (e.stopPropagation(), hark.hideBoard()) }, "Close");
  const board = h("div.board", { hidden: true, role: "dialog", "aria-modal": "true", "aria-label": "Message", onclick: () => hark.hideBoard() }, h("div.board-inner", text, sub, close));
  parent.append(board);
  const live = h("div.sr-only", { role: "status", "aria-live": "assertive" });
  parent.append(live);
  let returnFocus = null;
  hark.on("board", (b) => {
    if (!b) {
      if (!board.hidden) {
        board.hidden = true;
        closeModal(board);
        returnFocus?.focus?.();
        returnFocus = null;
      }
      return;
    }
    if (board.hidden) returnFocus = document.activeElement;
    board.className = `board ${b.kind}`;
    text.textContent = b.text;
    sub.textContent = b.sub || "";
    board.hidden = false;
    openModal(board);
    live.textContent = `${b.text}. ${b.sub || ""}`;
    close.focus();
  });
  board.addEventListener("keydown", (e) => e.key === "Escape" && hark.hideBoard());
}
