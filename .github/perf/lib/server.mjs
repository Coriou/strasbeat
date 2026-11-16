// Serves one build the way production does (hashed assets immutable, the
// rest revalidated, gzip), answers /strudel-cc/ from fixtures fetched once
// per run, and routes everything external: the two GitHub manifests are
// fixtures too, any audio file is one tiny WAV, anything else is aborted
// and reported. Both targets therefore see byte-identical inputs.
import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { createHash } from "node:crypto";
export const sleep = (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms)));
const manifests = [
  "tidal-drum-machines.json",
  "tidal-drum-machines-alias.json",
  "piano.json",
  "vcsl.json",
  "uzu-wavetables.json",
  "mridangam.json",
]
  .map((p) => `https://strudel.cc/${p}`)
  .concat(
    ["dirt-samples", "uzu-drumkit"].map(
      (p) =>
        `https://raw.githubusercontent.com/tidalcycles/${p}/main/strudel.json`,
    ),
  );
export function fixtures() {
  const cache = new Map();
  const get = (url) => {
    if (!cache.has(url))
      cache.set(
        url,
        (async () => {
          for (let i = 0; i < 3; i++) {
            try {
              const res = await fetch(url, {
                signal: AbortSignal.timeout(20000),
              });
              if (!res.ok) throw new Error(`HTTP ${res.status}`);
              const body = Buffer.from(await res.arrayBuffer());
              JSON.parse(body.toString());
              return body;
            } catch (e) {
              if (i === 2) throw new Error(`Fixture ${url}: ${e.message}`);
              await sleep(1000 * (i + 1));
            }
          }
        })(),
      );
    return cache.get(url);
  };
  return {
    get,
    async prepare() {
      for (const url of manifests) {
        console.log(`STEP fixture ${url}`);
        await get(url);
      }
    },
    async hashes() {
      return Object.fromEntries(
        await Promise.all(
          [...cache].map(async ([u, p]) => [
            u,
            createHash("sha256")
              .update(await p)
              .digest("hex"),
          ]),
        ),
      );
    },
  };
}
export function wav() {
  const b = Buffer.alloc(44 + 882);
  b.write("RIFF");
  b.writeUInt32LE(b.length - 8, 4);
  b.write("WAVEfmt ", 8);
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(44100, 24);
  b.writeUInt32LE(88200, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write("data", 36);
  b.writeUInt32LE(882, 40);
  return b;
}
const types = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".json": "application/json",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".wasm": "application/wasm",
  ".map": "application/json",
};
export async function serve(dir, fixture, delay = 0) {
  const root = path.resolve(dir),
    log = [],
    errors = [];
  const server = http.createServer(async (req, res) => {
    const start = performance.now();
    let status = 200,
      bytes = 0,
      pathname = "/";
    try {
      pathname = decodeURIComponent(
        new URL(req.url, "http://localhost").pathname,
      );
      const file = path.resolve(
        root,
        `.${pathname === "/" ? "/index.html" : pathname}`,
      );
      if (!file.startsWith(root + path.sep))
        throw new Error("Path outside build");
      const upstream = pathname.startsWith("/strudel-cc/");
      let body = upstream
        ? await fixture.get(`https://strudel.cc/${pathname.slice(12)}`)
        : await fs.readFile(file);
      // By the file that is served: "/" is index.html, and a page sent as
      // application/octet-stream is a download, not a navigation.
      const type =
        types[path.extname(upstream ? pathname : file)] ??
        "application/octet-stream";
      res.setHeader("Content-Type", type);
      res.setHeader(
        "Cache-Control",
        pathname.startsWith("/assets/")
          ? "public, max-age=31536000, immutable"
          : "max-age=0, must-revalidate",
      );
      res.setHeader("Vary", "Accept-Encoding");
      if (
        /text|json|svg|javascript/.test(type) &&
        /\bgzip\b/.test(req.headers["accept-encoding"] ?? "")
      ) {
        body = gzipSync(body);
        res.setHeader("Content-Encoding", "gzip");
      }
      bytes = body.length;
      res.setHeader("Content-Length", bytes);
      await sleep(delay);
      res.end(req.method === "HEAD" ? undefined : body);
    } catch (e) {
      status = e.code === "ENOENT" ? 404 : 500;
      errors.push(`${pathname}: ${e.message}`);
      res.writeHead(status);
      res.end(e.message);
    }
    log.push({
      method: req.method,
      path: pathname,
      status,
      bytes,
      time: performance.now() - start,
      at: Date.now(),
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    origin: `http://127.0.0.1:${server.address().port}`,
    log,
    errors,
    reset() {
      log.length = 0;
    },
    close: () =>
      new Promise((r) => {
        server.close(r);
        server.closeAllConnections();
      }),
  };
}
export async function routeExternal(
  context,
  origin,
  fixture,
  unexpected,
  delay,
) {
  const audio = wav();
  // Routing only external URLs preserves Chromium's HTTP cache for the warm journey.
  await context.route(
    (url) => url.origin !== origin && /^https?:$/.test(url.protocol),
    async (route) => {
      const url = route.request().url();
      try {
        if (manifests.includes(url)) {
          await sleep(delay);
          return await route.fulfill({
            body: await fixture.get(url),
            contentType: "application/json",
            headers: { "access-control-allow-origin": "*" },
          });
        }
        if (/\.(wav|mp3|ogg|flac|aiff|m4a)(?:[?#]|$)/i.test(url)) {
          await sleep(delay);
          return await route.fulfill({
            body: audio,
            contentType: "audio/wav",
            headers: { "access-control-allow-origin": "*" },
          });
        }
        unexpected.push(url);
        await route.abort("blockedbyclient");
      } catch (e) {
        unexpected.push(`${url}: ${e.message}`);
        await route.abort().catch(() => {});
      }
    },
  );
}
