import { defineConfig } from "vite";
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
        let body = "";
        for await (const chunk of req) body += chunk;
        let payload;
        try {
          payload = JSON.parse(body);
        } catch {
          res.statusCode = 400;
          return res.end("invalid json");
        }
        const { name, code } = payload;
        if (typeof name !== "string" || !/^[a-z0-9_-]+$/i.test(name)) {
          res.statusCode = 400;
          return res.end("name must match /^[a-z0-9_-]+$/i");
        }
        if (typeof code !== "string") {
          res.statusCode = 400;
          return res.end("code must be a string");
        }
        const escaped = code
          .replace(/\\/g, "\\\\")
          .replace(/`/g, "\\`")
          .replace(/\$\{/g, "\\${");
        const file = `export default \`${escaped}\`;\n`;
        const target = path.join(PATTERNS_DIR, `${name}.js`);
        fs.mkdirSync(PATTERNS_DIR, { recursive: true });
        fs.writeFileSync(target, file, "utf8");
        res.setHeader("content-type", "application/json");
        res.end(
          JSON.stringify({ ok: true, path: path.relative(__dirname, target) }),
        );
      });
    },
  };
}

export default defineConfig({
  plugins: [patternSavePlugin()],
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
