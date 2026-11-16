import { defineConfig, loadEnv } from "vite";
import fs from "node:fs";
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
export function rejectSaveRequest(headers) {
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
        const MAX_BODY = 1024 * 1024;
        let body = "";
        for await (const chunk of req) {
          body += chunk;
          if (body.length > MAX_BODY) {
            return sendJson(res, 413, { ok: false, error: "payload too large" });
          }
        }
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

export default defineConfig({
  plugins: [patternSavePlugin(), umamiPlugin()],
  define: {
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
