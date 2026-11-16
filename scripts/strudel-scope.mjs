// Enumerates every name pattern code can actually call in strasbeat: the
// globals boot.js hands to evalScope(), the globals the repl injects on
// evaluate (setcpm, hush, all…), `Pattern.prototype` methods, and whatever
// each opt-in package from the Setup panel adds on top.
//
// It imports the INSTALLED packages, so the answer is what this build can
// run — not what the upstream repository documents. Used by
// build-strudel-docs.mjs to decide which names may be documented, and by
// src/editor/strudel-docs.test.js to catch the committed index drifting.
//
// Callers must have scripts/test-loader.mjs registered (see
// test-register.mjs): @strudel/core does not link under bare node.

import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const require = createRequire(join(ROOT, "package.json"));

/** Directory of an installed package, symlinks resolved. */
export function packageDir(specifier, from = require) {
  return dirname(from.resolve(`${specifier}/package.json`));
}

// Names a module exports and Pattern methods it installs, read from its
// built entry file without executing it. Only for packages that cannot be
// imported outside a browser.
async function staticNames(specifier) {
  const dir = packageDir(specifier);
  const pkg = JSON.parse(await readFile(join(dir, "package.json"), "utf8"));
  const src = await readFile(join(dir, pkg.main), "utf8");
  const exports = [];
  for (const block of src.matchAll(/export\s*\{([^}]*)\}/g)) {
    for (const item of block[1].split(",")) {
      const name = item.trim().split(/\s+as\s+/).pop();
      if (name) exports.push(name);
    }
  }
  const methods = [...src.matchAll(/Pattern\.prototype\.(\w+)\s*=/g)].map(
    (m) => m[1],
  );
  return { exports, methods };
}

/**
 * @returns {Promise<{
 *   base: Set<string>,             always callable
 *   optIn: Map<string, string>,    name → label of the package that adds it
 *   values: Set<string>,           names that are values (signals such as
 *                                  `sine`, `silence`), not functions
 *   notes: string[],               anything worth telling the person running this
 * }>}
 */
export async function collectScopeNames() {
  const notes = [];
  const core = await import("@strudel/core");
  const { Pattern } = core;
  const methods = () => Object.getOwnPropertyNames(Pattern.prototype);

  const base = new Set();
  const values = new Set();
  const patterns = new Set();
  const addAll = (names) => names.forEach((n) => base.add(n));
  // An export can be `undefined` — upstream destructures a few names out of
  // register()/registerControl() results that don't contain them (`colour`).
  // Those are not callable as globals; they only count if a Pattern method
  // of that name exists, which the prototype pass below picks up.
  const addModule = (mod) => {
    for (const [name, value] of Object.entries(mod)) {
      if (value === undefined) continue;
      base.add(name);
      if (typeof value !== "function") values.add(name);
      else values.delete(name);
      if (value?._Pattern === true) patterns.add(name);
      else patterns.delete(name);
    }
  };

  // Mirrors the evalScope() call in src/boot.js (later modules win there).
  for (const spec of ["@strudel/core", "@strudel/draw", "@strudel/mini", "@strudel/tonal", "@strudel/webaudio"]) {
    addModule(await import(spec));
  }
  try {
    addModule(await import("@strudel/soundfonts"));
  } catch {
    const { exports, methods: sfMethods } = await staticNames("@strudel/soundfonts");
    addAll(exports);
    addAll(sfMethods);
    notes.push(
      "@strudel/soundfonts cannot be imported under node — its names were read from the built file instead",
    );
  }
  // boot.js exposes only these two from the editor package; importing it
  // also installs the methods it registers (markcss…), as in the app.
  const codemirror = await import("@strudel/codemirror");
  for (const name of ["slider", "sliderWithID"]) {
    if (name in codemirror) base.add(name);
  }
  addModule(await import("../src/strudel-ext/index.js"));

  // What the repl adds to the global scope on evaluate.
  const globalsBefore = new Set(Object.getOwnPropertyNames(globalThis));
  const repl = core.repl({ getTime: () => 0, defaultOutput: async () => {} });
  // setcps() is itself one of those globals and returns a (silent) pattern,
  // so this evaluates cleanly without starting the scheduler.
  await repl.evaluate("setcps(0.5)", false);
  for (const name of Object.getOwnPropertyNames(globalThis)) {
    if (!globalsBefore.has(name)) base.add(name);
  }

  addAll(methods());

  // Opt-in packages, loaded the way the app loads them.
  const optIn = new Map();
  const { OPT_IN_PACKAGES } = await import("../src/user-setup.js");
  for (const pkg of OPT_IN_PACKAGES) {
    const before = new Set(methods());
    let mod;
    try {
      mod = await pkg.load();
    } catch (err) {
      notes.push(`${pkg.label} could not be imported: ${err.message}`);
      continue;
    }
    const added = [
      ...Object.keys(mod).filter((n) => mod[n] !== undefined),
      ...methods().filter((n) => !before.has(n)),
    ];
    for (const name of added) {
      if (base.has(name) || optIn.has(name)) continue;
      optIn.set(name, pkg.label);
      if (name in mod && typeof mod[name] !== "function") values.add(name);
    }
  }

  // A few exports are neither functions nor patterns but wrap a function of
  // the same name that is also installed as a method (`euclidLegato`): what
  // a pattern author calls is the method.
  for (const name of methods()) {
    if (values.has(name) && !patterns.has(name)) values.delete(name);
  }

  return { base, optIn, values, notes };
}
