// Turns positions in the built files back into source files, lines and
// module groups through the build's hidden source maps, for call counts
// (V8 precise coverage) and CPU profiles.
import fs from "node:fs";
import path from "node:path";
import { TraceMap, originalPositionFor } from "@jridgewell/trace-mapping";
export const groups = [
  "app:src/ui",
  "app:src/editor",
  "app:src (other)",
  "@strudel/core",
  "@strudel/draw",
  "@strudel/codemirror",
  "@strudel/mini",
  "@strudel/tonal",
  "superdough",
  "fraction.js",
  "@codemirror/view",
  "@codemirror/state",
  "@codemirror/* (other)",
  "@lezer/*",
  "other",
];
export function group(source = "") {
  if (source.startsWith("src/ui/")) return groups[0];
  if (source.startsWith("src/editor/")) return groups[1];
  if (source.startsWith("src/")) return groups[2];
  const pkg = source.startsWith("@")
    ? source.split("/").slice(0, 2).join("/")
    : source.split("/")[0];
  if (groups.includes(pkg)) return pkg;
  if (pkg.startsWith("@codemirror/")) return "@codemirror/* (other)";
  if (pkg.startsWith("@lezer/")) return "@lezer/*";
  return "other";
}
export function symbolicator(dir) {
  const cache = new Map(),
    locations = new Map();
  function load(url) {
    if (!cache.has(url)) {
      let f = null;
      try {
        const file = path.resolve(dir, "." + new URL(url).pathname);
        if (!file.startsWith(path.resolve(dir) + path.sep)) return null;
        const text = fs.readFileSync(file, "utf8"),
          starts = [0];
        for (let i = 0; i < text.length; i++)
          if (text[i] === "\n") starts.push(i + 1);
        f = {
          text,
          starts,
          map: new TraceMap(fs.readFileSync(file + ".map", "utf8")),
        };
      } catch {
        /* Browser builtins and evaluated pattern code have no build map. */
      }
      cache.set(url, f);
    }
    return cache.get(url);
  }
  function lc(url, line, column) {
    const key = `${url}:${line}:${column}`;
    if (locations.has(key)) return locations.get(key);
    const f = load(url),
      pos =
        f &&
        originalPositionFor(f.map, {
          line: line + 1,
          column: Math.max(0, column),
        });
    const source =
      pos?.source
        ?.replace(/^(\.\.\/)+/, "")
        .replace(/^node_modules\/\.pnpm\/[^/]+\/node_modules\//, "")
        .replace(/^node_modules\//, "") ?? url;
    const index = pos?.source ? f.map.sources.indexOf(pos.source) : -1;
    const snippet = (
      f?.map.sourcesContent?.[index]?.split("\n")[pos.line - 1] ?? ""
    )
      .trim()
      .slice(0, 160);
    const r = {
      file: source || "(runtime)",
      line: pos?.line ?? line + 1,
      snippet,
      group: group(source),
    };
    locations.set(key, r);
    return r;
  }
  function offset(url, offset) {
    const f = load(url);
    if (!f) return lc(url, 0, 0);
    let lo = 0,
      hi = f.starts.length - 1;
    while (lo < hi) {
      const m = (lo + hi + 1) >> 1;
      if (f.starts[m] <= offset) lo = m;
      else hi = m - 1;
    }
    return lc(url, lo, offset - f.starts[lo]);
  }
  return { lc, offset, load };
}
export function census(result, symbols) {
  const byGroup = Object.fromEntries(groups.map((g) => [g, 0])),
    functions = [];
  let calls = 0,
    unusedBytes = 0;
  for (const script of result) {
    // Injected measurement functions are excluded; evaluated pattern code remains included.
    if (script.url.includes("__perf-instrument")) continue;
    const unused = [],
      used = [];
    for (const fn of script.functions) {
      const range = fn.ranges[0];
      if (!range) continue;
      const count = range.count;
      const loc = symbols.offset(script.url, range.startOffset);
      calls += count;
      byGroup[loc.group] += count;
      functions.push({ name: fn.functionName || "(anonymous)", ...loc, count });
      (count ? used : unused).push([range.startOffset, range.endOffset]);
    }
    // Nested uncalled functions must not be counted twice. Offsets are UTF-16,
    // so measure UTF-8 bytes from the generated source, not offset differences.
    const source = symbols.load(script.url)?.text;
    if (source) {
      unused.sort((a, b) => a[0] - b[0]);
      let end = 0;
      for (const [a, b] of unused) {
        if (b > Math.max(a, end))
          unusedBytes += Buffer.byteLength(source.slice(Math.max(a, end), b));
        end = Math.max(end, b);
      }
    }
  }
  return {
    calls,
    groups: byGroup,
    unusedBytes,
    top: functions.sort((a, b) => b.count - a.count).slice(0, 25),
  };
}
export function profileTable(profile, symbols) {
  const nodes = new Map(profile.nodes.map((n) => [n.id, n])),
    self = new Map();
  for (let i = 0; i < (profile.samples?.length ?? 0); i++) {
    const id = profile.samples[i];
    self.set(id, (self.get(id) ?? 0) + (profile.timeDeltas[i] ?? 0) / 1000);
  }
  const rows = [],
    byGroup = {},
    totalMs = [...self.values()].reduce((a, b) => a + b, 0);
  for (const [id, ms] of self) {
    const f = nodes.get(id).callFrame,
      loc = symbols.lc(f.url, f.lineNumber, f.columnNumber);
    rows.push({
      name: f.functionName,
      ...loc,
      ms,
      percent: totalMs ? (ms / totalMs) * 100 : 0,
    });
    byGroup[loc.group] = (byGroup[loc.group] ?? 0) + ms;
  }
  return {
    totalMs,
    groups: byGroup,
    top: rows.sort((a, b) => b.ms - a.ms).slice(0, 40),
  };
}
