import { defineConfig, loadEnv, normalizePath } from "vite";
import { serviceWorkerPlugin, buildId } from "./src/sw/plugin.js";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Vercel sets VERCEL_PROJECT_PRODUCTION_URL (without protocol) at build time.
// Propagate it as VITE_SITE_URL so index.html's %VITE_SITE_URL% substitutions
// resolve to the real canonical URL on production builds. The .env.production
// fallback is used for local `pnpm build` runs.
if (process.env.VERCEL_PROJECT_PRODUCTION_URL && !process.env.VITE_SITE_URL) {
  process.env.VITE_SITE_URL = `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`;
}
// Read non-VITE flags too, so an emergency off switch can be committed in
// .env.production as well as configured in the deployment environment.
const swEnv = loadEnv(process.env.NODE_ENV === "development" ? "development" : "production", __dirname, "STRASBEAT_");
const swEnabled = (process.env.STRASBEAT_SW ?? swEnv.STRASBEAT_SW) !== "off";
const PATTERNS_DIR = path.join(__dirname, "patterns");

// Read version strings at config time so they're baked into the bundle
// as literals — no manual sync required when packages are upgraded.
const appPkg = JSON.parse(
  fs.readFileSync(path.join(__dirname, "package.json"), "utf8"),
);
const strudelCorePkg = JSON.parse(
  fs.readFileSync(
    path.join(__dirname, "node_modules/@strudel/core/package.json"),
    "utf8",
  ),
);

function sendJson(res, statusCode, payload) {
  res.statusCode = statusCode;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(payload));
}

// Reason to refuse a save request, or null. The dev server listens on
// localhost, where any web page open in the same browser can reach it: a
// cross-site `fetch(..., { mode: "no-cors" })` with a text/plain body needs no
// preflight and would otherwise overwrite pattern files on disk. Requiring
// JSON forces a preflight for cross-origin callers (which fails — no CORS
// headers are ever sent), and the Origin / Sec-Fetch-Site checks reject
// anything not issued by the app's own page.
//
// Those checks compare the request with its own Host header, so on their own
// they pass a DNS-rebinding page: `evil.example:5173` re-pointed at 127.0.0.1
// is same-origin with itself. (Vite's allowedHosts check does not cover this
// middleware — hooks registered in configureServer run ahead of it.) The Host
// therefore has to be a name rebinding cannot produce: localhost, or an IP
// address literal (the dev server reached over the LAN).
export function rejectSaveRequest(headers) {
  if (!isLocalHost(headers.host)) {
    return { status: 403, error: "save refused: unexpected Host header" };
  }
  const origin = headers.origin;
  if (origin) {
    let originHost = null;
    try {
      originHost = new URL(origin).host;
    } catch {
      // "null" and other opaque origins fall through as a mismatch.
    }
    if (originHost !== headers.host) {
      return { status: 403, error: "cross-origin save refused" };
    }
  }
  const site = headers["sec-fetch-site"];
  if (site && site !== "same-origin" && site !== "none") {
    return { status: 403, error: "cross-origin save refused" };
  }
  if (!/^application\/json\b/i.test(headers["content-type"] ?? "")) {
    return { status: 415, error: "content-type must be application/json" };
  }
  return null;
}

function isLocalHost(hostHeader) {
  let hostname;
  try {
    hostname = new URL(`http://${hostHeader}`).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (hostname === "localhost" || hostname.endsWith(".localhost")) return true;
  // URL keeps the brackets on an IPv6 literal.
  return net.isIP(hostname.replace(/^\[|\]$/g, "")) !== 0;
}

// Vite middleware: write the editor's current code to patterns/<name>.js
// so the dev workflow is: iterate in the browser → save → commit.
function patternSavePlugin() {
  return {
    name: "strasbeat:pattern-save",
    configureServer(server) {
      server.middlewares.use("/api/save", async (req, res, next) => {
        if (req.method !== "POST") return next();
        const rejection = rejectSaveRequest(req.headers);
        if (rejection) {
          return sendJson(res, rejection.status, {
            ok: false,
            error: rejection.error,
          });
        }
        // Cap request body at 1MB to prevent accidental memory exhaustion.
        // Bytes are collected and decoded once: decoding chunk by chunk
        // would turn a multi-byte character split across two chunks into
        // U+FFFD in the saved file.
        const MAX_BODY = 1024 * 1024;
        const chunks = [];
        let size = 0;
        for await (const chunk of req) {
          size += chunk.length;
          if (size > MAX_BODY) {
            return sendJson(res, 413, { ok: false, error: "payload too large" });
          }
          chunks.push(chunk);
        }
        const body = Buffer.concat(chunks).toString("utf8");
        let payload;
        try {
          payload = JSON.parse(body);
        } catch {
          return sendJson(res, 400, { ok: false, error: "invalid json" });
        }
        const { name, code, overwrite } = payload ?? {};
        if (typeof name !== "string" || !/^[a-z0-9_-]+$/i.test(name)) {
          return sendJson(res, 400, {
            ok: false,
            error: "name must match /^[a-z0-9_-]+$/i",
          });
        }
        if (typeof code !== "string") {
          return sendJson(res, 400, { ok: false, error: "code must be a string" });
        }
        const escaped = code
          .replace(/\\/g, "\\\\")
          .replace(/`/g, "\\`")
          .replace(/\$\{/g, "\\${");
        const file = `export default \`${escaped}\`;\n`;
        const target = path.join(PATTERNS_DIR, `${name}.js`);
        // Replacing a file that is already there has to be asked for: a typed
        // name that happens to match another pattern must not silently destroy
        // it (and any uncommitted work in it).
        if (overwrite !== true && fs.existsSync(target)) {
          return sendJson(res, 409, {
            ok: false,
            error: `patterns/${name}.js already exists`,
          });
        }
        try {
          fs.mkdirSync(PATTERNS_DIR, { recursive: true });
          fs.writeFileSync(target, file, "utf8");
        } catch (err) {
          console.error("[strasbeat/api/save] write failed:", err);
          return sendJson(res, 500, {
            ok: false,
            error: `write failed: ${err.message}`,
          });
        }
        sendJson(res, 200, {
          ok: true,
          path: path.relative(__dirname, target),
        });
      });
    },
  };
}

// Inject the self-hosted Umami <script> into index.html ONLY when both env
// vars are set. When either is blank (default in .env.production, always
// in dev unless a local override exists) the tag is omitted entirely — no
// network request, no console noise, no way for analytics to break the
// app. The `async` + `defer` attributes keep the fetch off the critical
// path regardless.
function umamiPlugin() {
  let src = "";
  let id = "";
  return {
    name: "strasbeat:umami",
    config(_, { mode }) {
      const env = loadEnv(mode, __dirname, "VITE_");
      src = env.VITE_UMAMI_SRC || "";
      id = env.VITE_UMAMI_WEBSITE_ID || "";
    },
    transformIndexHtml() {
      if (!src || !id) return;
      return [
        {
          tag: "script",
          attrs: {
            async: true,
            defer: true,
            "data-website-id": id,
            src,
          },
          injectTo: "head",
        },
      ];
    },
  };
}

// `@strudel/codemirror` is published both as a prebuilt bundle (its `main`)
// and as the source modules that bundle was made from. The prebuilt file
// inlines upstream's whole documentation dump (`doc.json`, ~540 kB) for an
// autocomplete and a Ctrl+hover tooltip that strasbeat replaces with its own
// (src/editor/completions/, src/editor/hover-docs.js), and it statically
// imports the Vim and Emacs keymaps (~140 kB) whether or not they are in
// use. Neither can be tree-shaken out of a prebuilt file, so the app is
// built from the package's source modules instead (the `resolve.alias`
// below), with two of their imports redirected here:
//
//   - `../../doc.json` (a path that only exists inside upstream's monorepo)
//     becomes an empty docs list. Its two consumers: `autocomplete.mjs`,
//     whose completion source is swapped out of the editor by
//     `installCompletions` and never put back (the settings panel has no
//     toggle for it), and `tooltip.mjs`, the Ctrl+hover tooltip, which then
//     finds no entry and shows nothing — strasbeat's own hover docs cover
//     the same identifiers.
//   - `@replit/codemirror-vim` / `-emacs` become src/editor/lazy-keymaps.js,
//     which fetches the real package the first time that keymap is used.
//     Only imports made from inside `@strudel/codemirror` are redirected;
//     the shim's own import of the real package passes through.
//
// Every import of the package has to land on the same copy (it holds the
// slider value store, the settings atom and the editor compartments), which
// is why this is an alias for the bare specifier rather than a different
// import path in some files. (A deep import such as
// `@strudel/codemirror/slider.mjs` is one of the source modules already, so
// it would be the very module the aliased entry re-exports.)
//
// All of this leans on how one release of the package is written. If a later
// release moves those imports, the redirects would simply stop matching and
// the build would succeed with the 540 kB and the two keymaps back in the
// entry chunk. So a production build fails instead: when a redirect never
// fired, and when anything it was meant to keep out is found in a chunk the
// page loads up front. (src/strudel-codemirror-shape.test.js checks the
// package's sources for the same assumptions without building.)
export function slimStrudelCodemirrorPlugin() {
  const EMPTY_DOCS = "\0strasbeat:upstream-doc-json";
  // Normalised so this is the same module id as the app's own import of the
  // shim — two copies would each have their own loaded-keymap state.
  const lazyKeymaps = normalizePath(
    path.join(__dirname, "src/editor/lazy-keymaps.js"),
  );
  const fromStrudelCodemirror = (importer) =>
    typeof importer === "string" &&
    /[\\/]@strudel[\\/]codemirror[\\/]/.test(importer);
  const redirected = { "doc.json": 0, vim: 0, emacs: 0 };
  let isBuild = false;
  return {
    name: "strasbeat:slim-strudel-codemirror",
    enforce: "pre",
    config(_, { command }) {
      isBuild = command === "build";
    },
    buildStart() {
      for (const key of Object.keys(redirected)) redirected[key] = 0;
    },
    resolveId(source, importer) {
      if (!fromStrudelCodemirror(importer)) return null;
      if (source === "../../doc.json") {
        redirected["doc.json"]++;
        return EMPTY_DOCS;
      }
      if (source === "@replit/codemirror-vim") {
        redirected.vim++;
        return lazyKeymaps;
      }
      if (source === "@replit/codemirror-emacs") {
        redirected.emacs++;
        return lazyKeymaps;
      }
      return null;
    },
    load(id) {
      if (id === EMPTY_DOCS) return "export default { docs: [] };";
      return null;
    },
    buildEnd(error) {
      if (!isBuild || error) return;
      const missed = Object.keys(redirected).filter((k) => redirected[k] === 0);
      if (missed.length > 0) {
        this.error(
          `@strudel/codemirror no longer imports ${missed.join(", ")} the way ` +
            `slimStrudelCodemirrorPlugin expects (vite.config.js) — the ` +
            `installed version has changed shape. Update the redirects.`,
        );
      }
    },
    generateBundle(_options, bundle) {
      if (!isBuild) return;
      const eager = eagerModuleIds(bundle);
      const leaked = eager.filter(isKeptOutOfEntry);
      if (leaked.length > 0) {
        this.error(
          `these modules are meant to load on demand (or not at all) but ` +
            `are in the chunks the page loads up front: ${leaked.join(", ")} ` +
            `— see slimStrudelCodemirrorPlugin in vite.config.js.`,
        );
      }
    },
  };
}

// What the plugin above exists to keep out of the first load: the two modal
// keymap packages and upstream's documentation dump.
export function isKeptOutOfEntry(moduleId) {
  return (
    /[\\/]@replit[\\/]codemirror-(vim|emacs)[\\/]/.test(moduleId) ||
    /[\\/]doc\.json(\?|$)/.test(moduleId)
  );
}

// Ids of every module in the entry chunks and the chunks they import
// statically — what the browser has to fetch before the app runs.
export function eagerModuleIds(bundle) {
  const seen = new Set();
  const queue = Object.values(bundle)
    .filter((chunk) => chunk.type === "chunk" && chunk.isEntry)
    .map((chunk) => chunk.fileName);
  const ids = [];
  while (queue.length > 0) {
    const fileName = queue.pop();
    if (seen.has(fileName)) continue;
    seen.add(fileName);
    const chunk = bundle[fileName];
    if (!chunk || chunk.type !== "chunk") continue;
    ids.push(...Object.keys(chunk.modules ?? {}));
    queue.push(...(chunk.imports ?? []));
  }
  return ids;
}

// escodegen (the code generator behind Strudel's transpiler) `require`s the
// `source-map` package, ~30 kB, for one optional feature: emitting a source
// map when `generate()` is called with `sourceMap`. Strudel's transpiler
// never asks for one, so the production bundle gets a stand-in that fails
// loudly if that ever changes. Build only — the dev pre-bundler keeps the
// real package, which is equally unused there.
function stubSourceMapPlugin() {
  const STUB = "\0strasbeat:source-map-stub";
  return {
    name: "strasbeat:stub-source-map",
    apply: "build",
    enforce: "pre",
    resolveId(source, importer) {
      if (source !== "source-map") return null;
      if (!/[\\/]escodegen[\\/]/.test(importer ?? "")) return null;
      return STUB;
    },
    load(id) {
      if (id !== STUB) return null;
      return `export class SourceNode {
  constructor() {
    throw new Error(
      "escodegen source maps are not available: the source-map package is stubbed out of this build (see vite.config.js)",
    );
  }
}`;
    },
  };
}

// Preload the two font files the first paint uses — the UI face and the
// editor's monospace face, latin subset. Without the hint they are only
// discovered once the stylesheet has been parsed, one round-trip later, and
// the code visibly re-flows when the monospace face swaps in. The files are
// content-hashed, so the tags are generated from the build's asset list
// (production build only; the dev server serves them from node_modules). The
// other unicode-range subsets stay on-demand.
const PRELOADED_FONTS =
  /^assets\/geist(-mono)?-latin-wght-normal-[\w-]+\.woff2$/;
function fontPreloadPlugin() {
  let base = "/";
  return {
    name: "strasbeat:font-preload",
    apply: "build",
    configResolved(config) {
      base = config.base;
    },
    transformIndexHtml: {
      order: "post",
      handler(_html, ctx) {
        const fonts = Object.keys(ctx.bundle ?? {})
          .filter((fileName) => PRELOADED_FONTS.test(fileName))
          .sort();
        if (fonts.length !== 2) {
          // The font packages renamed their files, or a subset was added.
          // The page still works; it just loses the preload.
          console.warn(
            `[strasbeat:font-preload] expected 2 latin font files to preload, found ${fonts.length}: ${fonts.join(", ")}`,
          );
        }
        return fonts.map((fileName) => ({
          tag: "link",
          attrs: {
            rel: "preload",
            as: "font",
            type: "font/woff2",
            href: base + fileName,
            // Fonts are always fetched in CORS mode; without this the
            // preloaded response is not reused and the file downloads twice.
            crossorigin: "",
          },
          injectTo: "head",
        }));
      },
    },
  };
}

export default defineConfig({
  plugins: [
    slimStrudelCodemirrorPlugin(),
    stubSourceMapPlugin(),
    patternSavePlugin(),
    umamiPlugin(),
    fontPreloadPlugin(),
    serviceWorkerPlugin({ enabled: swEnabled }),
  ],
  resolve: {
    alias: [
      // Build from the package's source modules, not its prebuilt bundle —
      // see slimStrudelCodemirrorPlugin above. Exact match only, so deep
      // imports (`@strudel/codemirror/slider.mjs`) are left alone.
      {
        find: /^@strudel\/codemirror$/,
        replacement: "@strudel/codemirror/index.mjs",
      },
    ],
  },
  define: {
    __BUILD_ID__: JSON.stringify(buildId()),
    __SW_ENABLED__: JSON.stringify(swEnabled),
    __APP_VERSION__: JSON.stringify(appPkg.version),
    __STRUDEL_VERSION__: JSON.stringify(strudelCorePkg.version),
  },
  // Bumped from Vite's default (es2020) so top-level await is emitted
  // as-is. es2022 is the lowest target that ships TLA natively; the
  // share-link flow relies on it (src/main.js awaits readSharedFromHash).
  // The effective browser floor is already Safari 16.4+ / Chrome 80+
  // because of CompressionStream, so this does not regress support.
  build: { target: "es2022" },
  // Don't let Vite's dep scanner wander into strudel-source/, and skip
  // *.test.js — those run under `node --test` (see scripts/test-loader.mjs)
  // and may import devDeps installed only transitively (e.g.
  // @codemirror/lang-javascript via @strudel/codemirror).
  optimizeDeps: {
    entries: [
      "index.html",
      "src/**/*.{js,mjs,ts}",
      "!src/**/*.test.{js,mjs,ts}",
      "patterns/*.js",
    ],
    // Serve `@strudel/codemirror`'s source modules through the normal plugin
    // pipeline in dev as well, so the redirects in
    // slimStrudelCodemirrorPlugin apply there too (the dependency
    // pre-bundler does not run Vite plugins) and dev and production run the
    // same code. Its own dependencies are still pre-bundled.
    exclude: ["@strudel/codemirror"],
    // …including the ones only it imports, which the scanner cannot see
    // behind an excluded package. This list is REQUIRED, not a warm-up: a
    // bare import made from a file inside node_modules is only resolved to
    // a pre-bundled dependency that is already known to the optimizer, and
    // is otherwise served raw. Without these entries dev would load each of
    // them unbundled, together with what they import (@lezer/*) — a second
    // copy next to the one pre-bundled into @codemirror/language. When
    // upstream's source gains a dependency that strasbeat's own code does
    // not import, add it here.
    include: [
      "@strudel/codemirror > @codemirror/lang-javascript",
      "@strudel/codemirror > @lezer/highlight",
      "@strudel/codemirror > @nanostores/persistent",
      "@strudel/codemirror > @replit/codemirror-vscode-keymap",
    ],
  },
  server: {
    port: 5173,
    open: false,
    fs: {
      // serve files only from this project, not the cloned strudel-source
      allow: [__dirname],
      deny: ["strudel-source/**"],
    },
    // strudel.cc serves sample manifests without CORS headers, so we can't
    // fetch them directly from a localhost origin — proxy them instead.
    proxy: {
      "/strudel-cc": {
        target: "https://strudel.cc",
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/strudel-cc/, ""),
      },
    },
  },
});
