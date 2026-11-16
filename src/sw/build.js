// What the service worker precaches, decided at build time from the bundle.
// Pure (node only), so the rules and their guards are unit-tested; plugin.js
// feeds it the real bundle and writes the result into /sw.js.
import { createHash } from "node:crypto";

export const PUBLIC_SHELL = [
  "manifest.webmanifest",
  "favicon.svg",
  "favicon.ico",
  "favicon-32x32.png",
  "favicon-192x192.png",
  "favicon-512x512.png",
  "apple-touch-icon.png",
];
// Ceilings, in raw bytes. The precache is 3.5 MiB today (32 files, the entry
// chunk 1.8 MiB of it); these leave room to grow without letting a stray
// multi-megabyte chunk into every install unnoticed.
export const MAX_PRECACHE_BYTES = 5 * 1024 * 1024;
export const MAX_REQUIRED_ASSET_BYTES = 3 * 1024 * 1024;
export const OPT_IN_THRESHOLD = 512 * 1024;
const hash = (value) =>
  createHash("sha256").update(value).digest("hex").slice(0, 20);
// What a page can ask for under /assets/. Source maps are written next to
// the chunks by `vite build --sourcemap` (the performance rig builds that
// way) but no page loads them, so they stay out of the precache and of the
// build identifier.
export const isShippedAsset = (name) =>
  name.startsWith("assets/") && !name.endsWith(".map");
const bytes = (item) =>
  Buffer.byteLength(item.type === "chunk" ? item.code : item.source);

// The identifier a running app reports (`window.strasbeat.buildId`, Settings →
// About), and what the browser tests tell builds apart by.
//
// It is derived from the names of the build's hashed files, not from the
// commit: a commit that changes no shipped byte must produce a byte-identical
// site, or every documentation push would hand each installed app a new
// service worker, a fresh download of the entry chunk and an "update ready"
// notice. For the same reason it travels in index.html (a <meta> tag) and
// never inside a hashed script.
export function contentBuildId(fileNames) {
  const names = fileNames.filter(isShippedAsset).sort();
  return createHash("sha256")
    .update(names.join("\n"))
    .digest("hex")
    .slice(0, 10);
}

function closure(bundle, roots, stop = new Set()) {
  const found = new Set();
  function visit(name) {
    if (found.has(name) || stop.has(name)) return;
    found.add(name);
    for (const dep of [
      ...(bundle[name]?.imports ?? []),
      ...(bundle[name]?.dynamicImports ?? []),
    ])
      visit(dep);
  }
  roots.forEach(visit);
  return found;
}

export function makePrecache(
  bundle,
  publicFiles,
  { ceiling = MAX_PRECACHE_BYTES } = {},
) {
  const chunks = Object.values(bundle).filter((item) => item.type === "chunk");
  const optIn = chunks.filter((item) =>
    /\/@strudel\/(csound|xen)\//.test(item.facadeModuleId ?? ""),
  );
  const roots = new Set(optIn.map((item) => item.fileName));
  const required = closure(
    bundle,
    chunks.filter((item) => item.isEntry).map((item) => item.fileName),
    roots,
  );
  const optional = closure(bundle, [...roots], required);
  // Exclude only large files used exclusively by the opt-in csound/xen
  // graphs. A large entry/shared chunk must fail the budget, never disappear.
  const excluded = new Set(
    [...optional].filter(
      (name) =>
        !required.has(name) &&
        bundle[name] &&
        bytes(bundle[name]) > OPT_IN_THRESHOLD,
    ),
  );
  const allAssets = Object.keys(bundle).filter(isShippedAsset).sort();
  const files = [
    "index.html",
    ...allAssets.filter((name) => !excluded.has(name)),
    ...PUBLIC_SHELL,
  ];
  let total = 0;
  const precache = files.sort().map((name) => {
    const item = bundle[name] ?? publicFiles[name];
    if (!item) throw new Error(`Service worker: missing ${name}`);
    if (name.startsWith("assets/") && bytes(item) > MAX_REQUIRED_ASSET_BYTES) {
      throw new Error(
        `Service worker: required asset ${name} exceeds the 3 MiB per-file ceiling`,
      );
    }
    total += bytes(item);
    return {
      url: `/${name}`,
      revision: name.startsWith("assets/") ? name : hash(item.source),
    };
  });
  if (
    !precache.length ||
    !chunks.some(
      (item) =>
        item.isEntry && precache.some((p) => p.url === `/${item.fileName}`),
    )
  ) {
    throw new Error("Service worker: precache lacks the entry script");
  }
  if (total > ceiling)
    throw new Error(
      `Service worker: precache ${total} bytes exceeds ${ceiling} byte ceiling`,
    );
  return {
    precache,
    allAssets: allAssets.map((name) => `/${name}`),
    version: hash(JSON.stringify(precache)),
    total,
    excluded: [...excluded],
  };
}
