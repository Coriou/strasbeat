// Runner-only service-worker lifecycle checks. Owns a switchable static
// server; no Vite server, routing interception or browser HTTP cache can
// substitute for the worker in these checks. See smoke.yml for the builds.
import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";

const workspace = process.env.GITHUB_WORKSPACE || process.cwd();
const roots = ["dist", "dist-sw-2", "dist-sw-off"].map((name) =>
  path.join(workspace, name),
);
let root = roots[0];
let refusing = false;
let phase = "setup";
const traffic = [];
const problems = [];
const checks = [];
const log = (name, ok, detail = "") => {
  checks.push({ name, ok, detail: String(detail) });
  console.log(
    `${ok ? "PASS" : "FAIL"}  SW ${name}${detail ? ` — ${detail}` : ""}`,
  );
};
fs.mkdirSync("out", { recursive: true });
const mime = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".webmanifest": "application/manifest+json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".wasm": "application/wasm",
};
const server = http.createServer(async (req, res) => {
  traffic.push({ phase, url: req.url });
  if (refusing) {
    req.socket.destroy();
    return;
  }
  const url = new URL(req.url, "http://localhost");
  res.setHeader(
    "Cache-Control",
    url.pathname === "/sw.js"
      ? "no-cache"
      : url.pathname.startsWith("/assets/")
        ? "public, max-age=31536000, immutable"
        : "max-age=0",
  );
  try {
    if (url.pathname.startsWith("/strudel-cc/")) {
      const upstream = await fetch(
        `https://strudel.cc/${url.pathname.slice(12)}${url.search}`,
        { signal: AbortSignal.timeout(20000) },
      );
      res.writeHead(upstream.status, {
        "content-type":
          upstream.headers.get("content-type") || "application/json",
      });
      res.end(Buffer.from(await upstream.arrayBuffer()));
      return;
    }
    const file = path.resolve(
      root,
      `.${decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname)}`,
    );
    if (!file.startsWith(root + path.sep)) {
      res.writeHead(403).end();
      return;
    }
    res.setHeader(
      "Content-Type",
      mime[path.extname(file)] || "application/octet-stream",
    );
    res.end(await fs.promises.readFile(file));
  } catch (err) {
    res.writeHead(err.code === "ENOENT" ? 404 : 502);
    res.end(String(err));
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const BASE = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({
  args: [
    "--autoplay-policy=no-user-gesture-required",
    "--use-gl=angle",
    "--use-angle=swiftshader",
    "--enable-unsafe-swiftshader",
  ],
});
const contexts = [];
let page;
let context;
async function poll(fn, message, timeout = 90000) {
  const deadline = Date.now() + timeout;
  let last;
  do {
    try {
      if (await fn()) return;
    } catch (err) {
      last = err;
    }
    await delay(200);
  } while (Date.now() < deadline);
  throw new Error(`${message}${last ? `: ${last.message}` : ""}`);
}
async function session() {
  const ctx = await browser.newContext({
    viewport: { width: 1280, height: 800 },
  });
  contexts.push(ctx);
  await ctx.addInitScript(() => {
    // A context-level init script also runs in a new page's initial
    // about:blank, where touching localStorage throws.
    if (!/^https?:$/.test(location.protocol)) return;
    localStorage.setItem("strasbeat:drum-kit-nudge", "seen");
    window.__swSmokeReady = false;
    const observer = new MutationObserver(() => {
      if (document.getElementById("status")?.textContent === "Ready to play")
        window.__swSmokeReady = true;
    });
    observer.observe(document, {
      childList: true,
      subtree: true,
      characterData: true,
    });
  });
  ctx.on("page", (p) => {
    p.on("pageerror", (err) =>
      problems.push({ phase, kind: "pageerror", text: err.message }),
    );
    p.on("console", (msg) => {
      if (msg.type() === "error")
        problems.push({ phase, kind: "console.error", text: msg.text() });
    });
  });
  return ctx;
}
async function open(ctx, suffix = "/") {
  const p = await ctx.newPage();
  // Disable the ordinary HTTP cache without disabling service workers.
  const cdp = await ctx.newCDPSession(p);
  await cdp.send("Network.enable");
  await cdp.send("Network.setCacheDisabled", { cacheDisabled: true });
  await p.goto(BASE + suffix, { waitUntil: "domcontentloaded" });
  await ready(p);
  return p;
}
async function ready(p) {
  await p.waitForSelector(".cm-content", { timeout: 60000 });
  await p.waitForFunction(
    () => window.__swSmokeReady && window.strasbeat?.buildId,
    {},
    { timeout: 90000 },
  );
}
async function controlled(p) {
  await p.waitForFunction(
    () => !!navigator.serviceWorker.controller,
    {},
    { timeout: 90000 },
  );
}
const cacheNames = (p) => p.evaluate(() => caches.keys());
const buildId = (p) => p.evaluate(() => window.strasbeat.buildId);
async function checkUpdate(p) {
  await p.evaluate(async () => {
    const reg = await navigator.serviceWorker.getRegistration();
    if (!reg) throw new Error("no registration");
    await reg.update();
  });
}
async function waiting(p) {
  await p.waitForFunction(
    async () => !!(await navigator.serviceWorker.getRegistration())?.waiting,
    {},
    { timeout: 90000 },
  );
}
async function panel(p, id) {
  const tab = p.locator(`.right-rail__tab[data-panel-id="${id}"]`);
  if ((await tab.getAttribute("aria-selected")) !== "true") await tab.click();
  await p.waitForFunction(() => {
    const text = document.getElementById("right-rail-panel")?.textContent || "";
    return (
      text.trim().length > 30 && !/failed to load|couldn't load/i.test(text)
    );
  });
}
function assertNoShellTraffic(start) {
  const requests = traffic
    .slice(start)
    .filter(({ url }) =>
      /^\/(?:\?|$)|^\/index\.html(?:\?|$)|^\/assets\//.test(url),
    );
  assert.deepEqual(
    requests,
    [],
    `shell reached server: ${JSON.stringify(requests)}`,
  );
}
async function step(name, fn) {
  phase = name;
  try {
    await fn();
    log(name, true);
  } catch (err) {
    log(name, false, err.stack || err);
    if (page && !page.isClosed())
      await page
        .screenshot({ path: `out/sw-${checks.length}-failure.png` })
        .catch(() => {});
    // Later lifecycle phases depend on this one. Do not print false passes.
    throw err;
  }
}
try {
  context = await session();
  let initialCache;
  let secondCache;
  await step(
    "first visit: ready, controlled, complete non-opaque shell, opt-in exclusions",
    async () => {
      page = await open(context);
      await controlled(page);
      assert.equal(await buildId(page), "sw-build-1");
      const snapshot = await page.evaluate(async () => {
        const names = await caches.keys();
        const name = names.find((key) => key.startsWith("strasbeat-precache-"));
        const cache = await caches.open(name);
        const keys = await cache.keys();
        return {
          name,
          paths: keys.map((r) => new URL(r.url).pathname),
          types: await Promise.all(
            keys.map(async (r) => (await cache.match(r)).type),
          ),
          entry: new URL(document.querySelector('script[type="module"]').src)
            .pathname,
          manifests: (
            await (await caches.open("strasbeat-manifests-v1")).keys()
          ).length,
        };
      });
      initialCache = snapshot.name;
      assert.ok(snapshot.paths.includes("/index.html"));
      assert.ok(snapshot.paths.includes(snapshot.entry));
      assert.ok(!snapshot.types.includes("opaque"));
      assert.ok(!snapshot.paths.includes("/sw.js"));
      assert.equal(snapshot.manifests, 8);
      const manifest = JSON.parse(
        fs.readFileSync(path.join(roots[0], ".vite/manifest.json")),
      );
      for (const pkg of ["csound", "xen"]) {
        const entry = Object.keys(manifest).find((key) =>
          key.includes(`@strudel/${pkg}/`),
        );
        assert.ok(entry, `manifest has ${pkg} root`);
        const seen = new Set();
        const visit = (key) => {
          if (seen.has(key)) return;
          seen.add(key);
          for (const dep of [
            ...(manifest[key]?.imports || []),
            ...(manifest[key]?.dynamicImports || []),
          ]) {
            if (!manifest[dep]?.isEntry) visit(dep);
          }
        };
        visit(entry);
        const big = [...seen]
          .map((key) => manifest[key]?.file)
          .filter(Boolean)
          .filter(
            (file) =>
              fs.statSync(path.join(root, file)).size > 512 * 1024 &&
              !snapshot.paths.includes(`/${file}`),
          );
        assert.ok(
          big.length,
          `${pkg}: at least one large chunk absent from precache`,
        );
        log(`${pkg} exclusions`, true, big.join(", "));
      }
      assert.equal(await page.locator(".app-update-notice").count(), 0);
    },
  );
  await step(
    "second online launch: ready with zero shell/asset server requests",
    async () => {
      await page.close();
      const start = traffic.length;
      page = await open(context);
      await controlled(page);
      assertNoShellTraffic(start);
      await poll(
        () => traffic.slice(start).some(({ url }) => url === "/sw.js"),
        "launch checks sw.js on the network",
      );
    },
  );
  await step(
    "offline launch: cached manifests, editor, synth scheduler and lazy panel",
    async () => {
      await page.close();
      refusing = true;
      await context.setOffline(true);
      const start = traffic.length;
      page = await open(context);
      await controlled(page);
      await page.evaluate(() =>
        window.editor.setCode('note("c e g").s("sawtooth")'),
      );
      await page.click("#play");
      await page.waitForFunction(
        () => !!window.editor.repl.scheduler.started,
        {},
        { timeout: 20000 },
      );
      await panel(page, "learn");
      await page.evaluate(() => window.editor.stop());
      // The browser still asks the (refusing) server for /sw.js: that is the
      // update check, made outside the page and the worker. Nothing the app
      // itself needs may have gone to the network.
      assert.deepEqual(
        traffic
          .slice(start)
          .map(({ url }) => url)
          .filter((url) => url !== "/sw.js"),
        [],
        "only the sw.js update check reaches the refusing server",
      );
      await page.screenshot({ path: "out/sw-offline.png" });
      await context.setOffline(false);
      refusing = false;
    },
  );
  await step(
    "waiting update preserves old lazy assets; click reloads once into build 2",
    async () => {
      const otherWindow = await open(context);
      await controlled(otherWindow);
      root = roots[1];
      await checkUpdate(page);
      await waiting(page);
      await page
        .getByText("A new version of strasbeat is ready.", { exact: true })
        .waitFor();
      assert.equal(await buildId(page), "sw-build-1");
      const manifest = JSON.parse(
        fs.readFileSync(path.join(roots[0], ".vite/manifest.json")),
      );
      const oldPanel =
        manifest[
          Object.keys(manifest).find((key) =>
            key.endsWith("ui/reference-panel.js"),
          )
        ].file;
      const start = traffic.length;
      assert.equal(
        await page.evaluate(
          async (file) => (await fetch(`/${file}`, { cache: "no-store" })).ok,
          oldPanel,
        ),
        true,
      );
      await panel(page, "reference");
      assertNoShellTraffic(start);
      let navigations = 0;
      const count = (frame) => {
        if (frame === page.mainFrame()) navigations++;
      };
      page.on("framenavigated", count);
      await page
        .getByRole("button", { name: "Reload to update", exact: true })
        .click();
      await page.waitForFunction(
        () => window.strasbeat?.buildId === "sw-build-2",
        {},
        { timeout: 90000 },
      );
      await ready(page);
      await controlled(page);
      await delay(2000);
      page.off("framenavigated", count);
      assert.equal(navigations, 1);
      const names = await cacheNames(page);
      assert.ok(!names.includes(initialCache));
      secondCache = names.find((name) =>
        name.startsWith("strasbeat-precache-"),
      );
      assert.ok(secondCache && secondCache !== initialCache);
      assert.equal(
        await buildId(otherWindow),
        "sw-build-1",
        "another running window never auto-reloads",
      );
      const retiredStart = traffic.length;
      assert.equal(
        await otherWindow.evaluate(
          async (file) => (await fetch(`/${file}`, { cache: "no-store" })).ok,
          oldPanel,
        ),
        true,
      );
      assertNoShellTraffic(retiredStart);
      await panel(otherWindow, "reference");
      await otherWindow.close();
      log(
        "other build-1 window retains lazy chunks after explicit activation",
        true,
      );
    },
  );
  await step(
    "no pinning: without clicking, the following launch gets the waiting deploy",
    async () => {
      root = roots[0];
      await page.reload({ waitUntil: "domcontentloaded" });
      await ready(page);
      assert.equal(
        await buildId(page),
        "sw-build-2",
        "first launch still uses the controlled shell",
      );
      // The page's launch check must discover this deploy itself.
      await waiting(page);
      for (const p of context.pages()) await p.close();
      await poll(async () => {
        for (const worker of context.serviceWorkers()) {
          try {
            if (
              await worker.evaluate(
                async (old) => !(await caches.keys()).includes(old),
                secondCache,
              )
            )
              return true;
          } catch {
            /* The retiring worker's execution context can disappear. */
          }
        }
        return false;
      }, "waiting worker activates after the final client closes");
      page = await open(context);
      await controlled(page);
      assert.equal(await buildId(page), "sw-build-1");
    },
  );
  await step(
    "deployable kill switch: unregisters, clears caches, reloads from network",
    async () => {
      root = roots[2];
      const start = traffic.length;
      // The emergency navigation can destroy the evaluate context mid-update.
      await checkUpdate(page).catch((err) => {
        if (!/Execution context was destroyed/.test(err.message)) throw err;
      });
      await page.waitForFunction(
        () => window.strasbeat?.buildId === "sw-off",
        {},
        { timeout: 90000 },
      );
      await ready(page);
      await page.waitForFunction(
        async () =>
          !(await navigator.serviceWorker.getRegistrations()).length &&
          !(await caches.keys()).some((name) => name.startsWith("strasbeat-")),
      );
      assert.ok(
        traffic
          .slice(start)
          .some(({ url }) => url === "/" || url === "/index.html"),
        "emergency reload uses network shell",
      );
    },
  );
  await step(
    "browser flag: off persists across launches; on registers",
    async () => {
      // The page of the previous phase belongs to another "deploy": left
      // open, it would warm its lazy panels at idle and get 404s for them
      // from the build served next.
      await page.close();
      root = roots[0];
      const ctx = await session();
      page = await open(ctx, "/?sb-sw=off");
      await delay(6000);
      assert.equal(
        await page.evaluate(
          async () => (await navigator.serviceWorker.getRegistrations()).length,
        ),
        0,
      );
      await page.close();
      page = await open(ctx);
      await delay(6000);
      assert.equal(
        await page.evaluate(
          async () => (await navigator.serviceWorker.getRegistrations()).length,
        ),
        0,
      );
      await page.close();
      page = await open(ctx, "/?sb-sw=on");
      await controlled(page);
      assert.equal(
        await page.evaluate(
          async () => (await navigator.serviceWorker.getRegistrations()).length,
        ),
        1,
      );
      // Also test opting out after installation, not only a fresh browser.
      await page.goto(BASE + "/?sb-sw=off");
      await poll(
        async () =>
          page.evaluate(
            async () =>
              !(await navigator.serviceWorker.getRegistrations()).length &&
              !(await caches.keys()).some((name) =>
                name.startsWith("strasbeat-"),
              ),
          ),
        "installed browser opts out cleanly",
      );
    },
  );
} catch (err) {
  if (!checks.some((check) => !check.ok)) log("setup", false, err.stack || err);
} finally {
  log(
    "no page errors or unexpected console.error in any phase",
    problems.length === 0,
    JSON.stringify(problems),
  );
  fs.writeFileSync(
    "out/sw-report.json",
    JSON.stringify({ checks, problems, traffic }, null, 2),
  );
  await Promise.all(contexts.map((ctx) => ctx.close()));
  await browser.close();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}
process.exitCode = checks.some((check) => !check.ok) ? 1 : 0;
