// Browser smoke test: boots the production build in headless Chromium and
// walks the main flows — boot, play/stop, evaluate outcomes, the panels,
// completions, the palette, Hydra and shader visuals, a stored Vim profile,
// a broken working copy, and three viewport widths.
//
// Run by .github/workflows/smoke.yml on `ci/smoke-*` branches (and by hand
// from the Actions tab), against `vite preview`. It is not part of
// `pnpm test`: it needs a browser, and browsers are not run locally.
//
// Prints PASS/FAIL per check and a JSON summary, writes screenshots and
// report.json to ./out (uploaded as the run's artifact), and exits 1 if any
// check fails. SMOKE_URL overrides the address of the running preview.
import { chromium } from "playwright";
import fs from "node:fs";

const BASE = process.env.SMOKE_URL || "http://localhost:4173";
fs.mkdirSync("out", { recursive: true });
const checks = [];
const info = {};
const check = (name, ok, detail = "") => {
  checks.push({ name, ok: !!ok, detail: String(detail).slice(0, 400) });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + String(detail).slice(0, 300) : ""}`);
};
const step = async (name, fn) => {
  try {
    await fn();
  } catch (err) {
    check(`${name} (threw)`, false, err?.stack || err);
  }
};

const browser = await chromium.launch({
  args: [
    "--autoplay-policy=no-user-gesture-required",
    "--use-gl=angle",
    "--use-angle=swiftshader",
    "--enable-unsafe-swiftshader",
  ],
});

async function open(viewport, { storage } = {}) {
  const context = await browser.newContext({ viewport });
  const page = await context.newPage();
  const problems = [];
  const warnings = [];
  page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() === "error") problems.push(`console.error: ${m.text()}`);
    if (m.type() === "warning") warnings.push(m.text().slice(0, 200));
  });
  page.on("requestfailed", (r) => problems.push(`requestfailed: ${r.url()}`));
  await page.addInitScript((storage) => {
    for (const [k, v] of Object.entries(storage || {})) localStorage.setItem(k, v);
    const raf = window.requestAnimationFrame.bind(window);
    window.__raf = 0;
    window.requestAnimationFrame = (cb) => raf((t) => { window.__raf++; cb(t); });
    window.__long = [];
    try {
      new PerformanceObserver((l) => {
        for (const e of l.getEntries()) window.__long.push(Math.round(e.duration));
      }).observe({ entryTypes: ["longtask"] });
    } catch {}
  }, storage);
  const t0 = Date.now();
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".cm-content", { timeout: 60000 });
  const tEditor = Date.now() - t0;
  await page.waitForSelector(".shell.is-ready", { timeout: 90000 });
  const tReady = Date.now() - t0;
  return { context, page, problems, warnings, tEditor, tReady };
}
// Runs a step that is MEANT to produce errors. Only problems raised while it
// runs, and only those matching `allowed`, are forgiven; anything else stays
// in the list and fails the session's "no page errors" check.
const expectErrors = async (page, problems, allowed, fn) => {
  const before = problems.length;
  await fn();
  await page.waitForTimeout(300);
  const raised = problems.splice(before);
  const forgiven = raised.filter((p) => allowed.test(p));
  problems.push(...raised.filter((p) => !allowed.test(p)));
  return forgiven;
};
const rafRate = async (page, ms) => {
  const a = await page.evaluate(() => window.__raf);
  await page.waitForTimeout(ms);
  const b = await page.evaluate(() => window.__raf);
  return Math.round(((b - a) / ms) * 1000);
};
const transportState = (page) =>
  page.evaluate(() => document.getElementById("transport")?.dataset.transportState ?? "?");
const waitState = async (page, pred, ms = 15000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (pred(await transportState(page))) return true;
    await page.waitForTimeout(100);
  }
  return false;
};
const stop = async (page) => {
  await page.evaluate(() => window.editor.stop());
  await waitState(page, (s) => s === "idle", 8000);
};
// Click play and wait for the scheduler itself (the transport leaves "idle"
// as soon as the evaluate begins, before anything sounds).
const schedulerStarted = (page) =>
  page.evaluate(() => !!window.editor.repl.scheduler.started);
let lastPlayMs = null;
const play = async (page, ms = 15000) => {
  const t0 = Date.now();
  await page.click("#play");
  const end = t0 + ms;
  while (Date.now() < end) {
    if (await schedulerStarted(page)) {
      lastPlayMs = Date.now() - t0;
      return true;
    }
    await page.waitForTimeout(25);
  }
  lastPlayMs = null;
  return false;
};

// ── Desktop ────────────────────────────────────────────────────────────────
const d = await open({ width: 1440, height: 900 });
const { page } = d;
info.load = { editorMs: d.tEditor, readyMs: d.tReady };

await step("boot", async () => {
  check("boot reaches ready", true, `editor ${d.tEditor} ms, ready ${d.tReady} ms`);
  const status = await page.textContent("#status");
  check("boot status has no load warnings", !/warning|failed/i.test(status || ""), status);
  const res = await page.evaluate(() => {
    const js = performance.getEntriesByType("resource").filter((r) => /\.js(\?|$)/.test(r.name));
    return {
      scripts: js.map((r) => [r.name.split("/").pop(), r.transferSize, r.decodedBodySize, Math.round(r.startTime)]),
      long: window.__long,
      fcp: Math.round(performance.getEntriesByName("first-contentful-paint")[0]?.startTime ?? -1),
    };
  });
  info.resources = res;
  await page.screenshot({ path: "out/01-desktop-idle.png" });
  check("landmarks: main, tree, tablist present",
    await page.evaluate(() => !!document.querySelector("main") && !!document.querySelector('[role="tree"]') && !!document.querySelector('[role="tablist"]')));
});

await step("sounds", async () => {
  const s = await page.evaluate(() => ({
    count: window.strasbeat.countSounds(),
    tr909: window.strasbeat.hasSound("tr909_bd"),
    piano: window.strasbeat.hasSound("piano"),
    gm: window.strasbeat.hasSound("gm_piano"),
    bd: window.strasbeat.hasSound("bd"),
    wt: window.strasbeat.findSounds("wt_").length,
  }));
  info.sounds = s;
  check("default sounds registered (bd, gm_piano)", s.bd && s.gm, JSON.stringify(s));
  check("bank alias tr909_bd resolves", s.tr909);
  check("piano sample map registered", s.piano);
});

await step("idle", async () => {
  const r = await rafRate(page, 3000);
  info.idleRaf = r;
  check("idle: no animation loop running", r <= 3, `${r} rAF/s`);
});

await step("play / stop", async () => {
  const started = await play(page);
  info.firstPlayMs = lastPlayMs;
  check("play button starts the scheduler", started, `${lastPlayMs} ms, ${await transportState(page)}`);
  // The first play of a session waits for nothing but audio init.
  check("first play starts promptly", started && lastPlayMs < 1500, `${lastPlayMs} ms`);
  await page.waitForTimeout(2500);
  info.playingRaf = await rafRate(page, 2000);
  await page.screenshot({ path: "out/02-desktop-playing.png" });
  const cyc = await page.textContent("#cycle-readout");
  check("cycle readout advances while playing", /\d/.test(cyc || ""), cyc);
  await stop(page);
  check("stop returns transport to idle", (await transportState(page)) === "idle");
  const r = await rafRate(page, 3000);
  info.afterStopRaf = r;
  check("after stop: loops wind down", r <= 3, `${r} rAF/s`);
});

await step("evaluate outcome", async () => {
  const original = await page.evaluate(() => window.editor.code);
  const ok = await page.evaluate(() => window.editor.evaluate(false));
  check("evaluate(false) resolves ok", ok?.status === "ok", JSON.stringify(ok));
  let bad;
  // `s("bd` is an unterminated string starting at line 1, column 2; the
  // transpiler logs exactly this error for it.
  const forgiven = await expectErrors(page, d.problems, /^console\.error: SyntaxError: Unterminated string constant \(1:2\)/, async () => {
    await page.evaluate(() => window.editor.setCode('s("bd'));
    bad = await page.evaluate(() => window.editor.evaluate(false));
  });
  info.deliberateSyntaxErrorLogs = forgiven.length;
  check("broken code resolves to an error outcome", bad?.status === "error", JSON.stringify(bad));
  const badge = await page.evaluate(() => document.getElementById("transport")?.outerHTML.includes("error"));
  check("error surfaces in the transport", badge);
  await page.screenshot({ path: "out/03-error-state.png" });
  await page.evaluate((c) => window.editor.setCode(c), original);
  await page.evaluate(() => window.editor.evaluate(false));
});

await step("unknown sound warning", async () => {
  const original = await page.evaluate(() => window.editor.code);
  await page.evaluate(() => window.editor.setCode('s("definitely_not_a_sound*4")'));
  await play(page);
  await page.waitForTimeout(1500);
  const status = await page.textContent("#status");
  check("unknown sound is reported in the status line", /definitely_not_a_sound|unknown|not found|silent/i.test(status || ""), status);
  await stop(page);
  await page.evaluate((c) => window.editor.setCode(c), original);
});

await step("panels", async () => {
  const ids = await page.$$eval(".right-rail__tab", (els) => els.map((e) => e.dataset.panelId));
  info.panels = {};
  for (const id of ids) {
    // Clicking the tab that is already active collapses the rail, so only
    // click the ones that are not.
    const tab = page.locator(`.right-rail__tab[data-panel-id="${id}"]`);
    if ((await tab.getAttribute("aria-selected")) !== "true") await tab.click();
    await page.waitForTimeout(1800);
    const text = (await page.innerText("#right-rail-panel")).trim();
    info.panels[id] = text.length;
    check(`panel "${id}" renders`, text.length > 20 && !/failed to load|couldn.t load/i.test(text), text.slice(0, 80).replace(/\n/g, " "));
    await page.screenshot({ path: `out/04-panel-${id}.png` });
  }
});

await step("autocomplete + docs", async () => {
  await page.click(".cm-content");
  await page.keyboard.press("Control+End");
  await page.keyboard.type('\nnote("c e g").fas', { delay: 30 });
  const popup = await page.waitForSelector(".cm-tooltip-autocomplete", { timeout: 5000 }).catch(() => null);
  const text = popup ? await popup.innerText() : "";
  check("function completion offers fast()", /fast/.test(text), text.slice(0, 120).replace(/\n/g, " "));
  await page.keyboard.press("Escape");
  await page.keyboard.type("t(", { delay: 30 });
  await page.waitForTimeout(600);
  const hint = await page.evaluate(() => [...document.querySelectorAll(".cm-tooltip")].map((t) => t.innerText).join(" | "));
  check("signature hint appears inside a call", /fast|factor/i.test(hint), hint.slice(0, 160));
  await page.screenshot({ path: "out/05-signature-hint.png" });
  for (let i = 0; i < 20; i++) await page.keyboard.press("Backspace");
});

await step("typing latency", async () => {
  await page.click(".cm-content");
  await page.keyboard.press("Control+End");
  const lat = await page.evaluate(async () => {
    const out = [];
    const onKey = () => {
      const t = performance.now();
      requestAnimationFrame(() => requestAnimationFrame(() => out.push(performance.now() - t)));
    };
    window.addEventListener("keydown", onKey, true);
    window.__latStop = () => { window.removeEventListener("keydown", onKey, true); return out; };
  });
  const text = '\n$: s("bd*2 sd hh*4").bank("tr909").gain(0.8).room(0.2)\n$: note("c2 eb2 g2 bb2").s("sawtooth").lpf(800)';
  await page.keyboard.type(text, { delay: 50 });
  await page.waitForTimeout(300);
  const arr = (await page.evaluate(() => window.__latStop())).sort((a, b) => a - b);
  const q = (p) => Math.round(arr[Math.floor((arr.length - 1) * p)] * 10) / 10;
  info.typing = { n: arr.length, p50: q(0.5), p95: q(0.95), max: q(1) };
  check("typing: keydown → second frame p95 under 80 ms", q(0.95) < 80, JSON.stringify(info.typing));
  for (let i = 0; i < text.length; i++) await page.keyboard.press("Backspace");
});

await step("command palette", async () => {
  await page.keyboard.press("Control+Shift+P");
  await page.waitForTimeout(400);
  const open1 = await page.evaluate(() => !!document.querySelector(".palette-overlay .palette__input"));
  check("palette opens on Ctrl+Shift+P", open1);
  await page.keyboard.press("Tab");
  await page.keyboard.press("Tab");
  await page.keyboard.press("Escape");
  await page.waitForTimeout(500);
  const stillFocused = await page.evaluate(() => document.activeElement?.className ?? "");
  const open2 = await page.evaluate(() => !!document.querySelector(".palette-overlay"));
  info.paletteFocusAfterEscape = stillFocused;
  check("palette closes on Escape after Tab", !open2);
});

await step("stop then play does not double the layers", async () => {
  // The first evaluate is still awaiting inside the repl when stop and the
  // second play arrive; evaluated side by side they would share the repl's
  // `$:` table and every layer would play twice (4 onsets instead of 2).
  const original = await page.evaluate(() => window.editor.code);
  await page.evaluate(() =>
    window.editor.setCode('await new Promise((r) => setTimeout(r, 600))\n$: s("bd")\n$: s("hh")'));
  await page.click("#play");
  await page.waitForTimeout(150);
  await page.evaluate(() => window.editor.stop());
  const outcome = await page.evaluate(() => window.editor.evaluate());
  const onsets = await page.evaluate(() =>
    window.editor.repl.state.pattern.queryArc(0, 1).filter((h) => h.hasOnset()).length);
  check("play after a stop mid-evaluate: each layer once", outcome?.status === "ok" && onsets === 2, `${JSON.stringify(outcome)}, ${onsets} onsets`);
  await stop(page);
  await page.evaluate((c) => window.editor.setCode(c), original);
});

const visual = async (name, patternKey, canvasSel) => {
  await step(name, async () => {
    const code = await page.evaluate((k) => window.patterns[k], patternKey);
    check(`${name}: demo pattern exists`, typeof code === "string");
    await page.evaluate((c) => window.editor.setCode(c), code);
    const started = await play(page);
    await page.waitForTimeout(4000);
    const st = await page.evaluate((sel) => {
      const cv = document.querySelector(sel);
      const modes = [...document.querySelectorAll(".bottom-panel__mode-btn")].filter((b) => !b.hidden && b.offsetParent).map((b) => b.dataset.mode);
      return { started: !!window.editor.repl.scheduler.started, canvas: !!cv, modes, status: document.getElementById("status")?.textContent };
    }, canvasSel);
    check(`${name}: plays with a visuals canvas and a Visuals mode`, started && st.started && st.canvas && st.modes.includes("visuals"), JSON.stringify(st));
    if (st.modes.includes("visuals")) {
      await page.click('.bottom-panel__mode-btn[data-mode="visuals"]');
      await page.waitForTimeout(800);
      const box = await page.evaluate(() => { const r = document.getElementById("roll-pane").getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; });
      const a = await page.screenshot({ clip: box });
      await page.waitForTimeout(900);
      const b = await page.screenshot({ clip: box, path: `out/06-${name}-panel.png` });
      check(`${name}: panel pixels change between frames`, Buffer.compare(a, b) !== 0);
      const rail = await page.evaluate(() => { const r = document.getElementById("left-rail").getBoundingClientRect(); return { x: r.x, y: r.y, width: Math.max(1, r.width), height: Math.min(400, r.height) }; });
      const r1 = await page.screenshot({ clip: rail });
      await page.waitForTimeout(900);
      const r2 = await page.screenshot({ clip: rail });
      check(`${name}: left rail is not painted over`, Buffer.compare(r1, r2) === 0);
    }
    await page.screenshot({ path: `out/06-${name}-full.png` });
    await stop(page);
    await page.waitForTimeout(800);
    const after = await page.evaluate((sel) => ({ canvas: !!document.querySelector(sel) }), canvasSel);
    const r = await rafRate(page, 2500);
    check(`${name}: editor.stop() tears visuals down`, !after.canvas && r <= 3, `canvas ${after.canvas}, ${r} rAF/s`);
    await page.evaluate(() => window.editor.setCode('s("bd*2, hh*4")'));
    await play(page);
    await page.waitForTimeout(1200);
    check(`${name}: a non-visual pattern afterwards has no canvas`, !(await page.evaluate((sel) => !!document.querySelector(sel), canvasSel)));
    await stop(page);
  });
};
await visual("hydra", "04-hydra-demo", "#hydra-canvas");
await visual("shader", "05-shader-demo", "#strasbeat-shader-canvas");

await step("painters", async () => {
  await page.evaluate(() => window.editor.setCode('s("bd*2, hh*4").punchcard()'));
  const started = await play(page);
  await page.waitForTimeout(2500);
  await page.screenshot({ path: "out/07-punchcard.png" });
  check("punchcard pattern plays", started);
  await stop(page);
});

check("desktop session: no unexpected page errors", d.problems.length === 0,
  [...new Set(d.problems)].slice(0, 12).join(" || "));
info.desktopProblems = [...new Set(d.problems)];
info.desktopWarnings = [...new Set(d.warnings)].slice(0, 30);
await d.context.close();

// ── Vim profile stored at boot ─────────────────────────────────────────────
await step("vim keymap at boot", async () => {
  const v = await open({ width: 1280, height: 800 }, { storage: { "strasbeat:keymap-profile": "vim" } });
  await v.page.waitForTimeout(3000);
  const st = await v.page.evaluate(() => ({ fat: !!document.querySelector(".cm-fat-cursor, .cm-vimMode"), chip: document.querySelector('[class*="keymap-chip"]')?.innerText }));
  check("stored Vim profile is active after boot", st.fat, JSON.stringify(st));
  await v.page.click(".cm-content");
  await v.page.keyboard.type("ihello", { delay: 40 });
  await v.page.keyboard.press("Escape");
  const has = await v.page.evaluate(() => window.editor.code.includes("hello"));
  check("vim insert mode types text", has);
  await v.page.screenshot({ path: "out/08-vim.png" });
  check("vim session: no unexpected page errors", v.problems.length === 0, [...new Set(v.problems)].slice(0, 8).join(" || "));
  await v.context.close();
});

// ── A stored working copy that does not transpile ──────────────────────────
await step("broken working copy", async () => {
  // What autosave leaves when an edit session on a Demo ends mid-expression.
  const broken = '// my edits\n$: s("bd*2").gain(';
  const h = await open({ width: 1280, height: 800 }, {
    storage: {
      "strasbeat:pattern:01-hello": JSON.stringify({ code: broken, modified: "2026-01-01T00:00:00.000Z", isUserPattern: false }),
      "strasbeat:pattern-index": JSON.stringify({ lastOpen: "01-hello", userPatterns: [] }),
    },
  });
  const st = await h.page.evaluate(() => ({
    code: window.editor.code,
    original: window.patterns["01-hello"],
    recovered: JSON.parse(localStorage.getItem("strasbeat:pattern:01-hello-recovered") || "null"),
    listed: JSON.parse(localStorage.getItem("strasbeat:pattern-index") || "{}").userPatterns,
    inRail: [...document.querySelectorAll('[role="treeitem"]')].some((n) => /hello.recovered/i.test(`${n.dataset.name ?? ""} ${n.textContent ?? ""}`)),
  }));
  check("broken working copy: the pattern opens on its original", st.code === st.original);
  check("broken working copy: the edits are kept as a listed pattern",
    st.recovered?.code === broken && (st.listed ?? []).includes("01-hello-recovered") && st.inRail,
    JSON.stringify({ recovered: !!st.recovered, listed: st.listed, inRail: st.inRail }));
  check("broken working copy: no unexpected page errors", h.problems.length === 0, [...new Set(h.problems)].slice(0, 6).join(" || "));
  await h.context.close();
});

// ── Narrow viewports ───────────────────────────────────────────────────────
for (const [w, h, min] of [[390, 844, 300], [768, 1024, 560], [1024, 700, 360]]) {
  await step(`viewport ${w}`, async () => {
    const n = await open({ width: w, height: h });
    const m = await n.page.evaluate(() => {
      const r = document.querySelector(".cm-editor").getBoundingClientRect();
      const p = document.getElementById("play").getBoundingClientRect();
      return { editorW: Math.round(r.width), editorH: Math.round(r.height), playVisible: p.width > 0 && p.right <= innerWidth && p.bottom <= innerHeight, scrollX: document.documentElement.scrollWidth > innerWidth };
    });
    check(`${w}px: editor at least ${min}px wide, play visible, no horizontal scroll`, m.editorW >= min && m.playVisible && !m.scrollX, JSON.stringify(m));
    await n.page.screenshot({ path: `out/09-viewport-${w}.png` });
    if (w < 900) {
      await n.page.click("#pattern-menu").catch(() => {});
      await n.page.waitForTimeout(500);
      await n.page.screenshot({ path: `out/09-viewport-${w}-library.png` });
    }
    check(`${w}px: no unexpected page errors`, n.problems.length === 0, [...new Set(n.problems)].slice(0, 6).join(" || "));
    await n.context.close();
  });
}

await browser.close();
const failed = checks.filter((c) => !c.ok);
fs.writeFileSync("out/report.json", JSON.stringify({ info, checks }, null, 2));
console.log("\nINFO " + JSON.stringify(info));
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
process.exit(failed.length ? 1 : 0);
