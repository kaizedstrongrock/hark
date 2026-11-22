#!/usr/bin/env node
// Copy the HARK web app (../public) into www/ for the native projects: only the files the app uses
// (no Windows Zone.Identifier leftovers, no notes), so the companion app is exactly the web app.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, "../../public");
const OUT = path.resolve(HERE, "../www");
const SKIP = /Zone\.Identifier|\.md$|^\.|\.map$/;

fs.rmSync(OUT, { recursive: true, force: true });
let files = 0;
let bytes = 0;
(function copy(dir, rel = "") {
  for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.test(d.name)) continue;
    const from = path.join(dir, d.name);
    const to = path.join(OUT, rel, d.name);
    if (d.isDirectory()) copy(from, path.join(rel, d.name));
    else {
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.copyFileSync(from, to);
      files++;
      bytes += fs.statSync(from).size;
    }
  }
})(SRC);
console.log(`Copied the HARK web app to www/ (${files} files, ${(bytes / 1048576).toFixed(1)} MB)`);
