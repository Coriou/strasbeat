// Sizes of a finished build, no browser needed: the JS a launch must fetch
// (the entry chunk and everything it imports statically), the render-
// blocking CSS, and the lazy chunks for information. Run by ordinary CI.
//
//   node .github/perf/bundle.mjs dist bundle-results.json
import fs from "node:fs/promises";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { pathToFileURL } from "node:url";
export async function bundle(dir) {
  const root = path.resolve(dir),
    files = [];
  async function walk(p) {
    for (const entry of await fs.readdir(p, { withFileTypes: true })) {
      const f = path.join(p, entry.name);
      if (entry.isDirectory()) await walk(f);
      else if (!f.endsWith(".map")) files.push(f);
    }
  }
  await walk(root);
  const html = await fs.readFile(path.join(root, "index.html"), "utf8");
  const entries = [
    ...html.matchAll(/<script\b[^>]*src=["']([^"']+\.js)["'][^>]*>/g),
  ].map((m) => m[1]);
  const css = new Set(
    [...html.matchAll(/<link\b[^>]*href=["']([^"']+\.css)["'][^>]*>/g)].map(
      (m) => path.resolve(root, "." + m[1]),
    ),
  );
  const initial = new Set();
  const resolve = (s, from) =>
    s.startsWith("/")
      ? path.resolve(root, "." + s)
      : path.resolve(path.dirname(from), s);
  async function visit(file) {
    if (initial.has(file)) return;
    if (!file.startsWith(root + path.sep))
      throw new Error(`Import outside build: ${file}`);
    initial.add(file);
    const source = await fs.readFile(file, "utf8");
    // Vite/Rollup emits static imports at statement boundaries; dynamic import(
    // is deliberately excluded. No application parser is imported by this tool.
    for (const m of source.matchAll(
      /(?:^|[;\n])\s*(?:import\s*(?:[^;'"()]*?\s*from\s*)?|export\s*[^;'"()]*?\s*from\s*)["']([^"']+)["']/g,
    )) {
      const dep = resolve(m[1], file);
      if (dep.endsWith(".css")) css.add(dep);
      else await visit(dep);
    }
  }
  if (!entries.length) throw new Error("No entry script in index.html");
  for (const entry of entries)
    await visit(resolve(entry, path.join(root, "index.html")));
  const sizes = async (list) => {
    let raw = 0,
      gzip = 0;
    for (const f of list) {
      const b = await fs.readFile(f);
      raw += b.length;
      gzip += gzipSync(b, { level: 9 }).length;
    }
    return { raw, gzip };
  };
  const js = files.filter((f) => /\.m?js$/.test(f)),
    a = await sizes(initial),
    c = await sizes(css),
    all = await sizes(js);
  const lazy = await Promise.all(
    js
      .filter((f) => !initial.has(f))
      .map(async (f) => ({
        file: path.relative(root, f),
        ...(await sizes([f])),
      })),
  );
  return {
    schemaVersion: 1,
    records: [
      {
        scenario: "bundle",
        variant: "default",
        target: "head",
        pass: "count",
        status: "ok",
        counts: {
          initialJsRaw: a.raw,
          initialJsGzip: a.gzip,
          initialCssRaw: c.raw,
          initialCssGzip: c.gzip,
          totalJsRaw: all.raw,
          fileCount: files.length,
        },
        timings: {},
        info: {
          initial: [...initial].map((f) => path.relative(root, f)),
          largestLazy: lazy.sort((a, b) => b.raw - a.raw).slice(0, 10),
        },
      },
    ],
  };
}
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const r = await bundle(process.argv[2] ?? "dist");
    const out = process.argv[3] ?? "bundle-results.json";
    await fs.writeFile(out, JSON.stringify(r, null, 2) + "\n");
    console.table(r.records[0].counts);
    console.table(r.records[0].info.largestLazy);
  } catch (e) {
    console.error(`FAIL bundle: ${e.message}`);
    process.exitCode = 1;
  }
}
