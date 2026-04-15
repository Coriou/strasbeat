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

// Vite middleware: write the editor's current code to patterns/<name>.js
// so the dev workflow is: iterate in the browser → save → commit.
function patternSavePlugin() {
  return {
    name: "strasbeat:pattern-save",
    configureServer(server) {
      server.middlewares.use("/api/save", async (req, res, next) => {
        if (req.method !== "POST") return next();
        // Cap request body at 1MB to prevent accidental memory exhaustion.
        const MAX_BODY = 1024 * 1024;
        let body = "";
        for await (const chunk of req) {
          body += chunk;
          if (body.length > MAX_BODY) {
            res.statusCode = 413;
            return res.end(
              JSON.stringify({ ok: false, error: "payload too large" }),
            );
          }
        }
        let payload;
        try {
          payload = JSON.parse(body);
        } catch {
          res.statusCode = 400;
          return res.end(JSON.stringify({ ok: false, error: "invalid json" }));
        }
        const { name, code } = payload;
        if (typeof name !== "string" || !/^[a-z0-9_-]+$/i.test(name)) {
          res.statusCode = 400;
          return res.end(
            JSON.stringify({
              ok: false,
              error: "name must match /^[a-z0-9_-]+$/i",
            }),
          );
        }
        if (typeof code !== "string") {
          res.statusCode = 400;
          return res.end(
            JSON.stringify({ ok: false, error: "code must be a string" }),
          );
        }
        const escaped = code
          .replace(/\\/g, "\\\\")
          .replace(/`/g, "\\`")
          .replace(/\$\{/g, "\\${");
        const file = `export default \`${escaped}\`;\n`;
        const target = path.join(PATTERNS_DIR, `${name}.js`);
        try {
          fs.mkdirSync(PATTERNS_DIR, { recursive: true });
          fs.writeFileSync(target, file, "utf8");
        } catch (err) {
          console.error("[strasbeat/api/save] write failed:", err);
          res.statusCode = 500;
          return res.end(
            JSON.stringify({
              ok: false,
              error: `write failed: ${err.message}`,
            }),
          );
        }
        res.setHeader("content-type", "application/json");
        res.end(
          JSON.stringify({ ok: true, path: path.relative(__dirname, target) }),
        );
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
  // Don't let Vite's dep scanner wander into strudel-source/.
  optimizeDeps: {
    entries: ["index.html", "src/**/*.{js,mjs,ts}", "patterns/*.js"],
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
