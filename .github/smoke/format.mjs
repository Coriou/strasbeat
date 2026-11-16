// Production-browser formatting checks. Use the real worker and keybinding;
// only hold reply delivery for the deterministic edit-during-format check.
// The reference pipeline runs in Node, never in the page being measured.
import path from "node:path";
import { pathToFileURL } from "node:url";

export async function checkFormatting({ page, check, stop }) {
  // CI copies smoke scripts into the separate Playwright install. Resolve
  // the reference from the checkout, where Prettier is already installed.
  const workspace = process.env.GITHUB_WORKSPACE || process.cwd();
  const { formatBuffer, iterateStringLiterals } = await import(
    pathToFileURL(path.join(workspace, "src/editor/format-core.js")).href
  );
  const original = await page.evaluate(() => window.editor.code);
  const pattern = await page.evaluate(() => window.patterns["captainmo"]);
  check("format: captainmo exists", typeof pattern === "string");
  if (typeof pattern !== "string") return;
  const source = `${pattern}\nprogression(  'Cm7 F7'  )\n`;
  const expected = await formatBuffer(source);
  const literals = (code) =>
    [...iterateStringLiterals(code)]
      .filter((literal) => literal.quote !== "`")
      .map(({ quote, body }) => ({ quote, body }));

  await page.evaluate(() => {
    const NativeWorker = window.Worker;
    window.__formatProbe = { replies: 0, workers: 0, hold: false, held: [] };
    window.__restoreFormatWorker = () => {
      window.Worker = NativeWorker;
    };
    window.Worker = class extends NativeWorker {
      constructor(url, options) {
        super(url, options);
        this.isFormatWorker = String(url).includes("format-worker");
        if (this.isFormatWorker) window.__formatProbe.workers++;
      }

      addEventListener(type, listener, options) {
        if (type !== "message" || !this.isFormatWorker) {
          return super.addEventListener(type, listener, options);
        }
        return super.addEventListener(
          type,
          (event) => {
            const probe = window.__formatProbe;
            const deliver = () => {
              listener.call(this, event);
              probe.replies++;
            };
            if (probe.hold) probe.held.push(deliver);
            else deliver();
          },
          options,
        );
      }
    };
  });

  const trigger = async () => {
    const before = await page.evaluate(() => window.__formatProbe.replies);
    await page.keyboard.press("Control+Shift+F");
    await page.waitForFunction(
      (count) => window.__formatProbe.replies > count,
      before,
      { timeout: 20000 },
    );
    // Give PerformanceObserver delivery and the format transaction time to
    // finish before inspecting the main thread's long-task collection.
    await page.waitForTimeout(100);
  };

  try {
    check(
      "format: worker is not started before intent",
      (await page.evaluate(() => window.__formatProbe.workers)) === 0,
    );
    // Stopped on purpose: with software GL a playing roll blocks the main
    // thread by itself for hundreds of milliseconds at a time, and those long
    // tasks would be blamed on the format.
    await page.evaluate((code) => window.editor.setCode(code), source);
    await page.evaluate(() => window.editor.editor.focus());
    await page.waitForTimeout(200);
    await page.evaluate(() => {
      window.__long.length = 0;
    });
    await trigger();
    const first = await page.evaluate(() => ({
      code: window.editor.code,
      long: [...window.__long],
    }));
    check(
      "format: first result matches the reference byte for byte",
      first.code !== source && first.code === expected,
    );
    check(
      "format: every string keeps its original quotes and contents",
      JSON.stringify(literals(first.code)) ===
        JSON.stringify(literals(source)) &&
        first.code.includes("progression('Cm7 F7')"),
    );
    check(
      "format: first request has no main-thread long task",
      first.long.length === 0,
      JSON.stringify(first.long),
    );

    await page.evaluate(() => {
      window.__formatDoc = window.editor.editor.state.doc;
      window.__long.length = 0;
    });
    await trigger();
    const second = await page.evaluate(() => ({
      code: window.editor.code,
      sameDoc: window.editor.editor.state.doc === window.__formatDoc,
      long: [...window.__long],
      workers: window.__formatProbe.workers,
    }));
    check(
      "format: second request is a no-op",
      second.code === expected && second.sameDoc,
    );
    check(
      "format: second request has no main-thread long task",
      second.long.length === 0,
      JSON.stringify(second.long),
    );
    check(
      "format: one worker serves both requests",
      second.workers === 1,
      second.workers,
    );
    await page.evaluate(() => {
      window.editor.setCode("stack(");
      window.editor.editor.focus();
    });
    await trigger();
    const errorStatus = await page.textContent("#status");
    check(
      "format: syntax error reaches the status line",
      /^format failed: .*Unexpected token/.test(errorStatus ?? ""),
      errorStatus,
    );
    check(
      "format: syntax error leaves the buffer intact",
      (await page.evaluate(() => window.editor.code)) === "stack(",
    );

    await page.evaluate((code) => {
      window.editor.setCode(code);
      const view = window.editor.editor;
      view.dispatch({ selection: { anchor: view.state.doc.length } });
      view.focus();
      window.__formatProbe.hold = true;
    }, source);
    await page.keyboard.press("Control+Shift+F");
    await page.waitForFunction(
      () => window.__formatProbe.held.length === 1,
      null,
      { timeout: 20000 },
    );
    await page.keyboard.type("// typed while formatting");
    const typed = await page.evaluate(() => window.editor.code);
    await page.evaluate(() => {
      window.__formatProbe.hold = false;
      for (const deliver of window.__formatProbe.held.splice(0)) deliver();
    });
    await page.waitForFunction(() =>
      document.getElementById("status")?.textContent.includes("format skipped"),
    );
    check(
      "format: typing during the request drops the result",
      (await page.evaluate(() => window.editor.code)) === typed &&
        typed !== source,
    );
  } finally {
    await stop(page);
    await page.evaluate((code) => {
      window.__formatProbe.hold = false;
      for (const deliver of window.__formatProbe.held.splice(0)) deliver();
      window.__restoreFormatWorker();
      window.editor.setCode(code);
      delete window.__formatDoc;
    }, original);
  }
}
