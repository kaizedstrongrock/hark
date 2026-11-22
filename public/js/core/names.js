// "Someone said your name": spot configured names in caption text. Pure module.

function words(text) {
  return (
    String(text)
      .toLowerCase()
      .replace(/[’‘]/g, "'")
      .match(/[\p{L}\p{N}]+(?:'[\p{L}]+)?/gu) || []
  );
}

/** Levenshtein distance with an early exit above `max`. */
export function editDistance(a, b, max = 2) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let best = cur[0];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      best = Math.min(best, cur[j]);
    }
    if (best > max) return max + 1;
    prev = cur;
  }
  return prev[b.length];
}

/**
 * @param {string} text caption text
 * @param {string[]} names configured names ("Alex", "Mom", "Dr Lee")
 * @returns {string[]} the configured names that occur in the text
 */
export function findNames(text, names) {
  const ws = words(text);
  if (!ws.length) return [];
  const found = [];
  for (const raw of names) {
    const name = String(raw || "").trim();
    if (!name) continue;
    const parts = words(name);
    if (!parts.length) continue;
    let hit = false;
    for (let i = 0; i + parts.length <= ws.length && !hit; i++) {
      hit = parts.every((p, k) => {
        const w = ws[i + k].replace(/'s$/, "");
        if (w === p || w === `${p}s`) return true;
        return p.length >= 5 && editDistance(w, p, 1) <= 1; // tolerate one recognition error in longer names
      });
    }
    if (hit) found.push(name);
  }
  return found;
}
