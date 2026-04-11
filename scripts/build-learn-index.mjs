#!/usr/bin/env node
// scripts/build-learn-index.mjs
//
// Reads JSON source files from src/learn/content/ and produces a single
// src/learn/index.json consumed by the Learn panel at runtime.
//
// Usage: node scripts/build-learn-index.mjs
// Alias: pnpm gen:learn

import { readFileSync, writeFileSync, readdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const contentDir = join(__dirname, "..", "src", "learn", "content");
const outFile = join(__dirname, "..", "src", "learn", "index.json");

const entries = [];
const seenIds = new Set();

for (const file of readdirSync(contentDir).sort()) {
  if (!file.endsWith(".json")) continue;
  const raw = readFileSync(join(contentDir, file), "utf-8");
  let items;
  try {
    items = JSON.parse(raw);
  } catch (err) {
    console.error(`[build-learn-index] failed to parse ${file}:`, err.message);
    process.exit(1);
  }
  if (!Array.isArray(items)) {
    console.error(`[build-learn-index] ${file}: expected an array`);
    process.exit(1);
  }
  for (const item of items) {
    if (!item.id || !item.type || !item.title || !item.code) {
      console.error(
        `[build-learn-index] ${file}: entry missing required fields (id, type, title, code):`,
        JSON.stringify(item).slice(0, 120),
      );
      process.exit(1);
    }
    if (seenIds.has(item.id)) {
      console.error(`[build-learn-index] duplicate id "${item.id}" in ${file}`);
      process.exit(1);
    }
    seenIds.add(item.id);
    entries.push(item);
  }
}

// Sort: workshops by chapter/order, recipes by title, examples by title
entries.sort((a, b) => {
  const typeOrder = { workshop: 0, recipe: 1, example: 2 };
  const ta = typeOrder[a.type] ?? 9;
  const tb = typeOrder[b.type] ?? 9;
  if (ta !== tb) return ta - tb;
  if (a.type === "workshop") {
    return (
      (a.chapter ?? 0) - (b.chapter ?? 0) || (a.order ?? 0) - (b.order ?? 0)
    );
  }
  return a.title.localeCompare(b.title);
});

writeFileSync(outFile, JSON.stringify(entries, null, 2) + "\n");
console.log(
  `[build-learn-index] wrote ${entries.length} entries to src/learn/index.json`,
);
