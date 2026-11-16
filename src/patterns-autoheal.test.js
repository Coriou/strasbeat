// Run with:
//   node --import ./scripts/test-register.mjs --test src/patterns-autoheal.test.js
//
// Auto-heal for broken cached working copies (the stale-localStorage class).
//
// A shipped Demo's localStorage working copy normally SHADOWS its disk
// original — that's how live edits persist. But a working copy that no longer
// transpiles is not an edit worth keeping; it only errors on play. The classic
// case: a Demo whose disk source was fixed (e.g. 05-shader-demo's multi-line
// single-quoted shader string corrected to concatenated '…\n' lines) while a
// stale broken copy lingers in localStorage and keeps winning at boot. The
// user sees `Unterminated string constant` forever despite a correct disk file.
//
// resolveWorkingCopy() heals that losslessly: for a SHIPPED pattern only, if
// the working copy fails to transpile but the disk original succeeds, it drops
// the copy and falls back to the original. The first block uses an injected
// fake canTranspile to pin every branch; the second runs the REAL transpiler
// strasbeat ships against the ACTUAL disk 05 file plus the known-broken
// multi-line-single-quote shape, so the test is faithful to runtime.

import { describe, test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { resolveWorkingCopy } from "./patterns.js";
import { transpiler } from "./transpiler-patch.js";
import "@strudel/mini"; // register the minilang so the mini() rewrite resolves

// A minimal fake store: a Map keyed by name plus an index. `failSet` makes
// every record write fail the way a refused localStorage write does.
function makeStore(initial = {}, { failSet = null } = {}) {
  const m = new Map(Object.entries(initial));
  let index = { lastOpen: null, userPatterns: [] };
  return {
    get: (name) => m.get(name) ?? null,
    set: (name, record) => {
      if (failSet === "false") return false;
      if (failSet === "quota") {
        const err = new Error("full");
        err.name = "QuotaExceededError";
        throw err;
      }
      m.set(name, record);
      return true;
    },
    delete: (name) => m.delete(name),
    getIndex: () => index,
    setIndex: (next) => {
      index = next;
    },
    _has: (name) => m.has(name),
    _size: () => m.size,
  };
}

describe("resolveWorkingCopy() auto-heal (injected canTranspile)", () => {
  const patterns = { demo: "GOOD_ORIGINAL" };

  test("no working copy → returns the disk original, no heal", () => {
    const store = makeStore();
    const r = resolveWorkingCopy({
      name: "demo",
      patterns,
      store,
      canTranspile: () => true,
    });
    assert.equal(r.code, "GOOD_ORIGINAL");
    assert.equal(r.healed, false);
  });

  test("working copy that transpiles → honored as a real edit", () => {
    const store = makeStore({ demo: { code: "EDITED_COPY" } });
    const r = resolveWorkingCopy({
      name: "demo",
      patterns,
      store,
      canTranspile: () => true,
    });
    assert.equal(r.code, "EDITED_COPY");
    assert.equal(r.healed, false);
    assert.ok(store._has("demo"), "a healthy edit must NOT be dropped");
  });

  test("broken working copy + healthy original → heal: drop copy, use original", () => {
    const store = makeStore({ demo: { code: "BROKEN_COPY" } });
    const r = resolveWorkingCopy({
      name: "demo",
      patterns,
      store,
      // Only the original transpiles; the copy does not.
      canTranspile: (code) => code === "GOOD_ORIGINAL",
    });
    assert.equal(r.code, "GOOD_ORIGINAL");
    assert.equal(r.healed, true);
    assert.ok(!store._has("demo"), "the broken copy must stop shadowing");
  });

  test("a healed copy is kept as a listed user pattern, never discarded", () => {
    // What autosave leaves behind when an edit session ends mid-expression.
    const store = makeStore({
      demo: { code: "HOUR_OF_EDITS(", modified: "2026-01-01T00:00:00.000Z" },
    });
    const healed = [];
    const r = resolveWorkingCopy({
      name: "demo",
      patterns,
      store,
      canTranspile: (code) => code === "GOOD_ORIGINAL",
      onHeal: (info) => healed.push(info),
    });
    assert.equal(r.healed, true);
    assert.equal(r.recoveredAs, "demo-recovered");
    assert.deepEqual(store.get("demo-recovered"), {
      code: "HOUR_OF_EDITS(",
      modified: "2026-01-01T00:00:00.000Z",
      isUserPattern: true,
    });
    assert.deepEqual(store.getIndex().userPatterns, ["demo-recovered"]);
    assert.deepEqual(healed, [{ name: "demo", recoveredAs: "demo-recovered" }]);
  });

  test("an earlier recovered copy is not overwritten", () => {
    const store = makeStore({
      demo: { code: "BROKEN_AGAIN(" },
      "demo-recovered": { code: "FIRST_RECOVERY(", isUserPattern: true },
      "demo-recovered-2": { code: "unlisted leftover" },
    });
    const r = resolveWorkingCopy({
      name: "demo",
      patterns,
      store,
      canTranspile: (code) => code === "GOOD_ORIGINAL",
    });
    assert.equal(r.recoveredAs, "demo-recovered-3");
    assert.equal(store.get("demo-recovered").code, "FIRST_RECOVERY(");
    assert.equal(store.get("demo-recovered-2").code, "unlisted leftover");
    assert.equal(store.get("demo-recovered-3").code, "BROKEN_AGAIN(");
  });

  for (const failSet of ["false", "quota"]) {
    test(`copy cannot be set aside (${failSet}) → nothing is healed or deleted`, () => {
      const store = makeStore({ demo: { code: "BROKEN_COPY" } }, { failSet });
      let called = false;
      const r = resolveWorkingCopy({
        name: "demo",
        patterns,
        store,
        canTranspile: (code) => code === "GOOD_ORIGINAL",
        onHeal: () => {
          called = true;
        },
      });
      assert.equal(r.code, "BROKEN_COPY");
      assert.equal(r.healed, false);
      assert.equal(called, false);
      assert.ok(store._has("demo"), "the only copy must stay in the store");
      assert.equal(store._size(), 1);
    });
  }

  test("broken copy AND broken original → keep copy (dropping would lose data)", () => {
    const store = makeStore({ demo: { code: "BROKEN_COPY" } });
    const r = resolveWorkingCopy({
      name: "demo",
      patterns,
      store,
      canTranspile: () => false, // neither transpiles
    });
    assert.equal(r.code, "BROKEN_COPY");
    assert.equal(r.healed, false);
    assert.ok(
      store._has("demo"),
      "must not drop a copy with no working fallback",
    );
  });

  test("user pattern (no disk original) → never healed, copy used as-is", () => {
    const store = makeStore({ mine: { code: "BROKEN_USER_COPY" } });
    const r = resolveWorkingCopy({
      name: "mine",
      patterns, // no `mine` key
      store,
      canTranspile: () => false,
    });
    assert.equal(r.code, "BROKEN_USER_COPY");
    assert.equal(r.healed, false);
    assert.ok(
      store._has("mine"),
      "user patterns have no fallback — never dropped",
    );
  });

  test("record present but code is not a string → original, no heal", () => {
    const store = makeStore({ demo: { notCode: true } });
    const r = resolveWorkingCopy({
      name: "demo",
      patterns,
      store,
      canTranspile: () => true,
    });
    assert.equal(r.code, "GOOD_ORIGINAL");
    assert.equal(r.healed, false);
  });
});

describe("resolveWorkingCopy() against the REAL transpiler + the 05 disk file", () => {
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const patternsDir = path.join(__dirname, "..", "patterns");

  // The exact transpile check the app will inject at boot — mirrors how the
  // editor evaluates patterns with top-level await (await shader/initHydra).
  const canTranspile = (code) => {
    try {
      transpiler(code, { wrapAsync: true, addReturn: true });
      return true;
    } catch {
      return false;
    }
  };

  // The known-broken shape: a shader source written as ONE multi-line
  // single-quoted string. The outer template literal parses, but the inner
  // `shader('` opens a string literal that spans many physical lines → illegal
  // JS → acorn throws "Unterminated string constant" the instant you play.
  // This is precisely the stale copy that shadows the fixed disk 05.
  const BROKEN_SHADER_COPY = `await shader('precision mediump float;
uniform float uKick;
void main(){ gl_FragColor = vec4(uKick, 0., 0., 1.); }
')

$: s("bd*4")`;

  let diskCode05;
  beforeEach(async () => {
    const mod = await import(
      pathToFileURL(path.join(patternsDir, "05-shader-demo.js")).href
    );
    diskCode05 = mod.default;
  });

  test("the shipped 05 disk file transpiles (precondition for healing)", () => {
    assert.equal(typeof diskCode05, "string");
    assert.ok(
      canTranspile(diskCode05),
      "05-shader-demo.js on disk must transpile, else there's nothing to heal to",
    );
  });

  test("the broken multi-line single-quote shape does NOT transpile", () => {
    assert.ok(
      !canTranspile(BROKEN_SHADER_COPY),
      "the stale shape must fail to transpile (Unterminated string constant)",
    );
  });

  test("heals the user's actual situation: broken 05 copy → fixed disk 05", () => {
    const patterns = { "05-shader-demo": diskCode05 };
    const store = makeStore({ "05-shader-demo": { code: BROKEN_SHADER_COPY } });
    const r = resolveWorkingCopy({
      name: "05-shader-demo",
      patterns,
      store,
      canTranspile,
    });
    assert.equal(r.healed, true, "a broken cached 05 copy must be healed");
    assert.equal(r.code, diskCode05, "must fall back to the fixed disk source");
    assert.ok(
      canTranspile(r.code),
      "the healed code must itself transpile (no more Unterminated string)",
    );
    assert.ok(!store._has("05-shader-demo"), "the broken copy must stop shadowing");
    assert.equal(
      store.get("05-shader-demo-recovered").code,
      BROKEN_SHADER_COPY,
      "and must still be in the library",
    );
  });
});
