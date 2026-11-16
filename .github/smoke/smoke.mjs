// Browser smoke test: boots the production build in headless Chromium and
// walks the main flows — boot, play/stop, evaluate outcomes, the panels,
// completions, the palette, Hydra and shader visuals, a stored Vim profile,
// the default-drum-kit nudge and switch, a broken working copy, and three
// viewport widths.
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
import { checkFormatting } from "./format.mjs";

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

// Every session but the drum-kit one starts with that one-time card already
// seen, so it does not turn up in the middle of an unrelated check.
const KIT_NUDGE_SEEN = { "strasbeat:drum-kit-nudge": "seen" };
async function open(viewport, { storage = KIT_NUDGE_SEEN } = {}) {
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
    // Seeded once per context: a reload must see what the page itself stored.
    if (!localStorage.getItem("smoke:seeded")) {
      for (const [k, v] of Object.entries(storage || {})) localStorage.setItem(k, v);
      localStorage.setItem("smoke:seeded", "1");
    }
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

// Regression checks for the owned playback loop. Performance acceptance is
// measured by the separate 120 Hz rig; this checks the browser integration.
await step("playback frame loop", async () => {
  const original = await page.evaluate(() => window.editor.code);
  try {
    const result = await page.evaluate(async () => {
      const editor = window.editor;
      editor.setCode('setcps(0.5)\nnote("c4").s("sine").slow(8)');
      const outcome = await editor.evaluate();
      if (outcome.status !== "ok") throw new Error(JSON.stringify(outcome));
      const drawer = editor.drawer;
      if (!drawer.window) throw new Error("owned frame loop was not installed");
      let highlights = 0;
      let queries = 0;
      const highlight = editor.highlight;
      const query = drawer.window.query;
      editor.highlight = function (...args) {
        highlights++;
        return highlight.apply(this, args);
      };
      drawer.window.query = function (...args) {
        queries++;
        return query.apply(this, args);
      };
      try {
        await new Promise((resolve) => setTimeout(resolve, 2000));
        return { highlights, queries, haps: drawer.visibleHaps.length };
      } finally {
        editor.highlight = highlight;
        drawer.window.query = query;
      }
    });
    check("frame loop: sustained highlights use keep-alives", result.highlights >= 1 && result.highlights <= 9, JSON.stringify(result));
    check("frame loop: queries are sliced", result.queries >= 1 && result.queries <= 16, JSON.stringify(result));
    check("frame loop: roll retains long notes", result.haps > 0);
  } finally {
    await stop(page);
    await page.evaluate((code) => window.editor.setCode(code), original);
    await page.evaluate(() => window.editor.evaluate(false));
  }
});

await step("legacy playback escape hatch", async () => {
  const legacy = await open({ width: 1440, height: 900 }, {
    storage: { ...KIT_NUDGE_SEEN, "strasbeat:flag:frameloop": "off" },
  });
  try {
    check("frame loop off: upstream Drawer retained", await legacy.page.evaluate(() => !!window.editor.drawer.framer && !window.editor.drawer.window));
    check("frame loop off: playback starts", await play(legacy.page));
    await stop(legacy.page);
    check("frame loop off: no idle animation loop", await rafRate(legacy.page, 1500) <= 3);
  } finally {
    await legacy.context.close();
  }
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

await step("formatting worker", () => checkFormatting({ page, check, stop }));

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

await step("track bar mute and solo across tabs", async () => {
  // A mute in a tab that is not playing edits that tab's code and leaves the
  // playing pattern alone; in the playing tab it is applied live.
  const names = await page.$$eval('[role="treeitem"][data-name]', (els) =>
    els.filter((e) => e.offsetParent).map((e) => e.dataset.name));
  const [a, b] = names;
  check("track bar: two patterns to open", !!a && !!b, names.slice(0, 4).join(", "));
  if (!a || !b) return;
  const openTab = async (name) => {
    await page.click(`[role="treeitem"][data-name="${name}"]`);
    await page.waitForTimeout(300);
  };
  const setCode = async (code) => {
    await page.evaluate((c) => window.editor.setCode(c), code);
    await page.waitForTimeout(300);
  };
  const state = () => page.evaluate(() => ({
    started: !!window.editor.repl.scheduler.started,
    playing: window.editor.repl.state.activeCode,
    buffer: window.editor.code,
  }));
  const codeA = 'drums: s("bd*2")\nhats: s("hh*4")';
  const codeB = 'kick: s("bd")\nsnare: s("sd")';

  await openTab(a);
  const originalA = await page.evaluate(() => window.editor.code);
  await setCode(codeA);
  const started = await play(page);
  await openTab(b);
  const originalB = await page.evaluate(() => window.editor.code);
  await setCode(codeB);
  await page.click("#track-bar .track-bar__entry");
  await page.waitForTimeout(800);
  const other = await state();
  check("track bar: a mute in another tab edits that tab only",
    started && other.started && other.buffer !== codeB && other.playing === codeA, JSON.stringify(other));

  // The palette's mute command (the same code path as the Mod-M key) follows
  // the same rule. The cursor goes on the second track's line first.
  const paletteCommand = async (lineText, query) => {
    await page.evaluate((needle) => {
      const view = window.editor.editor;
      view.dispatch({ selection: { anchor: view.state.doc.toString().indexOf(needle) + 1 } });
      view.focus();
    }, lineText);
    await page.keyboard.press("Control+Shift+P");
    await page.waitForSelector(".palette-overlay .palette__input", { timeout: 3000 });
    await page.keyboard.type(query);
    await page.waitForTimeout(200);
    await page.keyboard.press("Enter");
    await page.waitForTimeout(800);
  };
  await paletteCommand("snare:", "Mute Track at Cursor");
  const viaPalette = await state();
  check("palette: a mute in another tab edits that tab only",
    viaPalette.started && viaPalette.buffer !== other.buffer && viaPalette.playing === codeA, JSON.stringify(viaPalette));

  await openTab(a);
  await page.click("#track-bar .track-bar__entry");
  let live = await state();
  for (let i = 0; i < 40 && live.playing === codeA; i++) {
    await page.waitForTimeout(100);
    live = await state();
  }
  check("track bar: a mute in the playing tab is applied live",
    live.started && live.buffer !== codeA && live.playing === live.buffer, JSON.stringify(live));

  const beforePalette = live.buffer;
  await paletteCommand("hats:", "Mute Track at Cursor");
  live = await state();
  for (let i = 0; i < 40 && live.playing === beforePalette; i++) {
    await page.waitForTimeout(100);
    live = await state();
  }
  check("palette: a mute in the playing tab is applied live",
    live.started && live.buffer !== beforePalette && live.playing === live.buffer, JSON.stringify(live));

  await stop(page);
  await setCode(originalA);
  await openTab(b);
  await setCode(originalB);
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
  const v = await open({ width: 1280, height: 800 }, { storage: { ...KIT_NUDGE_SEEN, "strasbeat:keymap-profile": "vim" } });
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

// ── Default drum kit: the one-time nudge and the switch ────────────────────
await step("drum kit", async () => {
  const k = await open({ width: 1280, height: 800 }, { storage: {} });
  const p = k.page;
  const nudge = () => p.evaluate(() => !!document.querySelector(".kit-nudge"));
  const kit = () => p.evaluate(() => window.strasbeat.drumKit());
  const playCode = async (code) => {
    await p.evaluate((c) => window.editor.setCode(c), code);
    const started = await play(p);
    await p.waitForTimeout(700);
    return started;
  };

  const boot = await kit();
  check("drum kit: classic by default, no nudge at boot",
    boot.kit === "classic" && /dirt-samples/i.test(boot.bdSource ?? "") && !(await nudge()), JSON.stringify(boot));

  await playCode('s("bd*2, hh*4").bank("tr909")');
  check("drum kit: no nudge for drums with an explicit bank", !(await nudge()));
  await stop(p);
  await playCode('note("c e g").s("sawtooth")');
  check("drum kit: no nudge for a pattern without the shared drum names", !(await nudge()));
  await stop(p);

  const started = await playCode('s("bd*2, hh*4")');
  await p.waitForSelector(".kit-nudge__title", { timeout: 5000 }).catch(() => {});
  const shown = await p.evaluate(() => {
    const card = document.querySelector(".kit-nudge");
    if (!card) return null;
    const r = card.getBoundingClientRect();
    const t = document.getElementById("transport").getBoundingClientRect();
    return {
      text: card.innerText.replace(/\s+/g, " ").trim(),
      buttons: [...card.querySelectorAll("button")].map((b) => b.innerText.trim() || b.getAttribute("aria-label")),
      live: card.querySelector('[role="status"]') != null,
      tookFocus: card.contains(document.activeElement),
      onScreen: r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= t.top + 1,
      modal: !!document.querySelector(".modal-overlay"),
    };
  });
  check("drum kit: the nudge appears when a pattern using bare drum names plays",
    started && shown && /Dirt kit/.test(shown.text) && /strudel\.cc/.test(shown.text) && shown.buttons.length === 3 && shown.live,
    JSON.stringify(shown));
  check("drum kit: the nudge takes no focus, blocks nothing, sits above the transport",
    shown && !shown.tookFocus && !shown.modal && shown.onScreen, JSON.stringify(shown));
  await p.screenshot({ path: "out/10-drum-kit-nudge.png" });
  // (Play has focus after the click that started playback.)
  await p.click(".cm-content");
  await p.keyboard.press("Control+End");
  await p.keyboard.type(" // still typing");
  check("drum kit: typing goes to the editor while the nudge is up",
    await p.evaluate(() => window.editor.code.includes("// still typing")));

  await p.click(".kit-nudge__btn--switch");
  await p.waitForTimeout(300);
  const switched = await kit();
  check("drum kit: Switch puts the strudel.cc kit under bd and remembers it",
    switched.kit === "strudel" && /uzu-drumkit/i.test(switched.bdSource ?? "") && !(await nudge()) &&
      (await p.evaluate(() => localStorage.getItem("strasbeat:drum-kit"))) === "strudel" &&
      (await p.evaluate(() => !!window.editor.repl.scheduler.started)),
    JSON.stringify(switched));
  await stop(p);
  await playCode('s("bd*2, hh*4")');
  check("drum kit: the nudge does not come back", !(await nudge()));
  await stop(p);

  await p.reload({ waitUntil: "domcontentloaded" });
  await p.waitForSelector(".shell.is-ready", { timeout: 90000 });
  const reloaded = await kit();
  check("drum kit: the choice is in force after a reload",
    reloaded.kit === "strudel" && /uzu-drumkit/i.test(reloaded.bdSource ?? ""), JSON.stringify(reloaded));
  await playCode('s("bd*2, hh*4")');
  check("drum kit: no nudge after a reload either", !(await nudge()));
  await stop(p);

  const settingsTab = p.locator('.right-rail__tab[data-panel-id="settings"]');
  if ((await settingsTab.getAttribute("aria-selected")) !== "true") await settingsTab.click();
  await p.waitForSelector(".settings-panel__segment-input", { timeout: 10000 });
  const before = await p.evaluate(() =>
    [...document.querySelectorAll(".settings-panel__segment-input")].find((i) => i.checked)?.value);
  await p.locator(".settings-panel__kit").scrollIntoViewIfNeeded();
  await p.screenshot({ path: "out/10-drum-kit-setting.png" });
  await p.locator('.settings-panel__segment:has(input[value="classic"])').click();
  await p.waitForTimeout(300);
  const back = await kit();
  check("drum kit: the Settings control shows the choice and switches back",
    before === "strudel" && back.kit === "classic" && /dirt-samples/i.test(back.bdSource ?? "") &&
      (await p.evaluate(() => localStorage.getItem("strasbeat:drum-kit"))) === "classic",
    JSON.stringify({ before, back }));
  check("drum kit: no unexpected page errors", k.problems.length === 0, [...new Set(k.problems)].slice(0, 6).join(" || "));
  await k.context.close();
});

// ── A stored working copy that does not transpile ──────────────────────────
await step("broken working copy", async () => {
  // What autosave leaves when an edit session on a Demo ends mid-expression.
  const broken = '// my edits\n$: s("bd*2").gain(';
  const h = await open({ width: 1280, height: 800 }, {
    storage: {
      ...KIT_NUDGE_SEEN,
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
