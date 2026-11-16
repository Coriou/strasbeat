#!/usr/bin/env node
/**
 * build-strudel-docs.mjs
 *
 * Writes src/editor/strudel-docs.json — the index behind hover docs,
 * signature hints, autocomplete and the reference panel.
 *
 * Run: node scripts/build-strudel-docs.mjs   (or: pnpm gen:docs)
 *
 * What gets an entry is decided by what can actually be called, not by what
 * happens to be documented somewhere:
 *
 *   1. The set of callable names is read from the INSTALLED packages by
 *      importing them the way the app does (scripts/strudel-scope.mjs).
 *   2. JSDoc is read from src/strudel-ext/ and from the sources the installed
 *      packages ship in node_modules. Those describe the exact versions
 *      strasbeat runs.
 *   3. For callable names that still have no docs, the strudel-source/ clone
 *      is consulted as a fallback. The clone tracks upstream main, which is
 *      ahead of the published packages — so it only ever contributes text
 *      for names that exist here, never new names, and only where the
 *      declaration the text is attached to is unchanged in the installed
 *      source (a name can mean something else on main).
 *
 * Anything documented but not callable (unreleased upstream API, internal
 * helpers) is dropped and listed on stdout.
 */
import { readdir, readFile, writeFile, access } from "node:fs/promises";
import { createRequire, register } from "node:module";
import { join, relative, resolve } from "node:path";

// @strudel/core does not link under bare node; the test loader fixes that.
register("./test-loader.mjs", import.meta.url);
const { collectScopeNames, packageDir } = await import("./strudel-scope.mjs");

const ROOT = resolve(import.meta.dirname, "..");
const STRUDEL_SRC = join(ROOT, "strudel-source", "packages");
const STRAS_EXT = join(ROOT, "src", "strudel-ext");
const OUT = join(ROOT, "src", "editor", "strudel-docs.json");

// Packages whose JSDoc is scanned: everything boot.js puts in scope plus the
// opt-in packages from the Setup panel. Order matters only when two packages
// document the same name — the first one wins.
const SCAN_PACKAGES = [
  "@strudel/core",
  "@strudel/mini",
  "@strudel/tonal",
  "@strudel/webaudio",
  "superdough",
  "@strudel/draw",
  "@strudel/codemirror",
  "@strudel/soundfonts",
  "@strudel/xen",
  "@strudel/midi",
  "@strudel/osc",
  "@strudel/csound",
  "@strudel/serial",
];

// superdough is a dependency of @strudel/webaudio, not of strasbeat, so it
// has to be resolved from there.
function installedDir(specifier) {
  if (specifier !== "superdough") return packageDir(specifier);
  const fromWebaudio = createRequire(
    join(packageDir("@strudel/webaudio"), "package.json"),
  );
  return packageDir(specifier, fromWebaudio);
}

const IDENT = /^[A-Za-z_$][\w$]*$/;

/**
 * Parse JSDoc comment blocks from a source file.
 * Returns an array of { comment, followingCode } objects, where
 * followingCode is the statement the block is attached to: the next few
 * lines that are neither blank nor a line comment.
 */
function extractJSDocBlocks(source) {
  const blocks = [];
  const re = /\/\*\*([\s\S]*?)\*\//g;
  let match;
  while ((match = re.exec(source)) !== null) {
    const rest = source.slice(re.lastIndex, re.lastIndex + 800);
    const lines = rest
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("//"));
    blocks.push({
      comment: match[1],
      followingCode: lines.slice(0, 4).join("\n"),
    });
  }
  return blocks;
}

// `@param {type} name doc`, where the type may contain nested braces and the
// name may be optional (`[name]`, `[name=default]`) or variadic (`...name`).
function parseParamTag(line) {
  let rest = line.replace(/^@param\s*/, "");
  let type = "";
  if (rest.startsWith("{")) {
    let depth = 0;
    let end = -1;
    for (let i = 0; i < rest.length; i++) {
      if (rest[i] === "{") depth++;
      else if (rest[i] === "}" && --depth === 0) {
        end = i;
        break;
      }
    }
    if (end === -1) return null;
    type = rest.slice(1, end).trim();
    rest = rest.slice(end + 1).trimStart();
  }
  const m = rest.match(/^(\[)?(\.\.\.)?([\w$.]+)(?:\s*=\s*[^\]]*)?\]?\s*(.*)$/);
  if (!m) return null;
  return {
    name: m[3],
    type,
    doc: m[4].replace(/^-\s*/, ""),
  };
}

// Names a statement defines, primary first:
//   export const { fast, density } = register(…)   → fast, density
//   export const seq = …  /  export function seq(…) → seq
//   Pattern.prototype.piano = function …            → piano
//   register('ply', …)  /  register(['a', 'b'], …)  → ply / a, b
function namesFromCode(code) {
  const first = code.split("\n")[0] ?? "";
  let m = first.match(/^(?:export\s+)?(?:const|let|var)\s*[{[]([^}\]]*)[}\]]\s*=/);
  if (m) {
    return m[1]
      .split(",")
      .map((s) => s.trim().split(/\s*:\s*/).pop())
      .filter((s) => IDENT.test(s));
  }
  m = first.match(/^(?:export\s+)?(?:async\s+)?(?:function\s*\*?|const|let|var)\s+([\w$]+)/);
  if (m) return [m[1]];
  m = first.match(/^[\w$.]+\.prototype\.([\w$]+)\s*=/);
  if (m) return [m[1]];
  m = first.match(/^(?:register|registerControl)\(\s*\[([^\]]*)\]/);
  if (m) {
    return m[1]
      .split(",")
      .map((s) => s.trim().replace(/^['"]|['"]$/g, ""))
      .filter((s) => IDENT.test(s));
  }
  m = first.match(/^(?:register|registerControl)\(\s*['"]([\w$]+)['"]/);
  if (m) return [m[1]];
  m = first.match(/^(?:async\s+)?([\w$]+)\s*\(/);
  if (m) return [m[1]];
  return [];
}

// Parameters of the function a statement defines, for blocks that have no
// @param tags. Only the plain shapes are read; anything else gives [].
//   - register('x', function (a, b, pat) {…}) → a, b: the pattern is the
//     last argument and callers never pass it
//   - registerControl('x') → one value
//   - function x(a, b) / const x = (a, b) => / X.prototype.x = function (a, b)
const ARGS = String.raw`\(([^()]*)\)`;
const FN_HEAD = String.raw`(?:async\s*)?(?:function\s*\*?\s*[\w$]*\s*)?${ARGS}`;
const BINDING = String.raw`(?:export\s+)?(?:const|let|var)\s*(?:[\w$]+|\{[^}]*\})\s*=\s*`;
const REGISTERED = new RegExp(
  String.raw`^${BINDING}register\(\s*(?:\[[^\]]*\]|['"][\w$]+['"])\s*,\s*${FN_HEAD}`,
);
const CONTROL = new RegExp(String.raw`^${BINDING}registerControl\(`);
const PLAIN = [
  new RegExp(String.raw`^(?:export\s+)?(?:async\s+)?function\s*\*?\s*[\w$]+\s*${ARGS}`),
  new RegExp(String.raw`^${BINDING}${FN_HEAD}\s*(?:=>|\{)`),
  new RegExp(String.raw`^[\w$.]+\.prototype\.[\w$]+\s*=\s*(?:async\s*)?function\s*[\w$]*\s*${ARGS}`),
];

function paramsFromCode(code) {
  const head = code.split("\n").slice(0, 3).join(" ");
  if (CONTROL.test(head)) return [{ name: "value", type: "", doc: "" }];
  let list;
  let registered = false;
  const reg = head.match(REGISTERED);
  if (reg) {
    list = reg[1];
    registered = true;
  } else {
    for (const re of PLAIN) {
      const m = head.match(re);
      if (m) {
        list = m[1];
        break;
      }
    }
  }
  if (list === undefined) return [];
  const names = list
    .split(",")
    .map((s) => s.trim().replace(/\s*=.*$/, ""))
    .filter(Boolean);
  if (registered) names.pop();
  // Destructured or throwaway (`_`) arguments have no name worth showing.
  if (!names.every((n) => /^(\.\.\.)?[A-Za-z$][\w$]*$/.test(n))) return [];
  return names.map((name) => ({ name, type: "", doc: "" }));
}

/**
 * Parse a JSDoc comment into structured data.
 */
function parseJSDoc(comment, followingCode) {
  const lines = comment
    .split("\n")
    .map((l) => l.replace(/^\s*\*\s?/, "").trimEnd());

  let description = "";
  const params = [];
  const examples = [];
  const synonyms = [];
  let currentExample = null;
  let inDescription = true;
  let nameTag = "";
  let excluded = false;

  for (const line of lines) {
    if (line.startsWith("@param")) {
      inDescription = false;
      const p = parseParamTag(line);
      if (p) params.push(p);
    } else if (line.startsWith("@example")) {
      inDescription = false;
      if (currentExample !== null) examples.push(currentExample.trim());
      currentExample = "";
    } else if (line.startsWith("@synonyms")) {
      inDescription = false;
      const syns = line.replace("@synonyms", "").trim();
      synonyms.push(...syns.split(/[,\s]+/).filter(Boolean));
    } else if (line.startsWith("@name")) {
      inDescription = false;
      nameTag = line.replace("@name", "").trim();
    } else if (
      line.includes("noAutocomplete") ||
      line.includes("superdirtOnly")
    ) {
      excluded = true;
    } else if (line.startsWith("@")) {
      inDescription = false;
      // Skip other tags (@tags, @return, etc.)
      if (currentExample !== null) {
        examples.push(currentExample.trim());
        currentExample = null;
      }
    } else if (currentExample !== null) {
      currentExample += (currentExample ? "\n" : "") + line;
    } else if (inDescription) {
      description += (description ? " " : "") + line;
    }
  }
  if (currentExample !== null) examples.push(currentExample.trim());

  // Prefer the @name tag (which may list several: `@name getDuration,getDur`),
  // then derive from the code the block is attached to.
  const tagged = nameTag.split(/[,\s]+/).filter((s) => IDENT.test(s));
  const declared = namesFromCode(followingCode);
  const [name, ...alsoNamed] = tagged.length ? tagged : declared;
  for (const other of alsoNamed) {
    if (!synonyms.includes(other)) synonyms.push(other);
  }

  // `@param {x} [config.rate]` documents a key of the `config` argument, not
  // an argument of its own: fold it into its parent so the signature keeps
  // one entry per positional argument.
  const positional = [];
  for (const p of params) {
    if (!p.name.includes(".")) {
      positional.push(p);
      continue;
    }
    const [parentName, ...key] = p.name.split(".");
    const parent = positional.find((q) => q.name === parentName);
    if (!parent) continue;
    parent.keys ??= [];
    parent.keys.push(key.join("."));
  }
  for (const p of positional) {
    if (!p.keys) continue;
    p.doc = `${p.doc ? `${p.doc} ` : ""}Keys: ${p.keys.join(", ")}.`;
    delete p.keys;
  }

  return {
    name,
    description: description.trim(),
    // Parameters are read off the code only when the block sits on the
    // declaration of the very name it documents — an `@name x` block above
    // an internal helper says nothing about how x is called.
    params: positional.length
      ? positional
      : declared.includes(name)
        ? paramsFromCode(followingCode)
        : [],
    examples: examples.filter(Boolean),
    synonyms: synonyms.filter((s) => s !== name),
    excluded,
  };
}

/**
 * Scan a package directory for .mjs/.js files and extract JSDoc.
 */
async function scanPackage(pkgDir, { excludedNames, declarationLines } = {}) {
  const entries = [];
  let files;
  try {
    files = await readdir(pkgDir, { recursive: true });
  } catch {
    return entries;
  }

  // readdir order is filesystem-dependent; the output must not be.
  for (const file of files.sort()) {
    if (!/\.(mjs|js)$/.test(file)) continue;
    if (/node_modules|dist|test|bench/.test(file)) continue;

    const fullPath = join(pkgDir, file);
    let source;
    try {
      source = await readFile(fullPath, "utf-8");
    } catch {
      continue;
    }

    if (declarationLines) {
      for (const line of source.split("\n")) declarationLines.add(line.trim());
    }

    const blocks = extractJSDocBlocks(source);
    for (const { comment, followingCode } of blocks) {
      const parsed = parseJSDoc(comment, followingCode);
      if (parsed.excluded) {
        for (const n of [parsed.name, ...parsed.synonyms]) excludedNames?.add(n);
      } else if (parsed.name && parsed.description) {
        entries.push({ ...parsed, declaration: followingCode.split("\n")[0] });
      }
    }
  }
  return entries;
}

async function main() {
  try {
    await access(STRUDEL_SRC);
  } catch {
    console.error(
      "[build-strudel-docs] strudel-source/ not found.\n" +
        "  The docs index is completed from a clone of the Strudel repository\n" +
        "  (for functions whose published package ships no JSDoc). Clone it next\n" +
        "  to package.json and run again:\n" +
        "    git clone https://codeberg.org/uzu/strudel strudel-source\n" +
        "  src/editor/strudel-docs.json was left untouched.",
    );
    process.exit(1);
  }

  const { base, optIn, values, notes } = await collectScopeNames();
  const callable = (name) => base.has(name) || optIn.has(name);

  const docs = {};
  const dropped = new Map(); // name → where it was documented
  const sources = { ext: 0, installed: 0, clone: 0 };
  const fromClone = [];

  // Signals and other plain values (`sine`, `silence`) are used bare, not
  // called.
  const signatureOf = (name, params) =>
    values.has(name)
      ? name
      : params.length
      ? `${name}(${params.map((p) => (p.type ? `${p.name}: ${p.type}` : p.name)).join(", ")})`
        : `${name}()`;

  /**
   * Add a parsed JSDoc entry (and its synonyms) to `docs` — for every one of
   * its names that is callable and not documented yet.
   */
  function addEntry(entry, source, where) {
    for (const name of [entry.name, ...entry.synonyms]) {
      if (!IDENT.test(name) || name === "constructor") continue;
      if (Object.hasOwn(docs, name)) continue;
      if (!callable(name)) {
        if (!dropped.has(name)) dropped.set(name, where);
        continue;
      }
      const requires = base.has(name) ? undefined : optIn.get(name);
      docs[name] = {
        signature: signatureOf(name, entry.params),
        doc: requires
          ? `${entry.description} Needs ${requires} — enable it in Settings → Packages.`
          : entry.description,
        params: values.has(name) ? [] : entry.params,
        examples: entry.examples,
        ...(requires ? { requires } : {}),
      };
      sources[source]++;
      if (source === "clone") fromClone.push(name);
    }
  }

  // ── Strasbeat extensions ──────────────────────────────────────────────────
  // First, because boot.js passes them to evalScope() last: where an
  // extension shadows an upstream function (arrange), its docs are the ones
  // that describe what runs. Internal helpers that are not in the barrel are
  // not callable from a pattern and drop out like any other unknown name.
  for (const entry of await scanPackage(STRAS_EXT)) {
    addEntry(entry, "ext", "src/strudel-ext");
  }

  // ── Installed packages ────────────────────────────────────────────────────
  // Names the installed sources deliberately keep out (@noAutocomplete,
  // @superdirtOnly) stay out, whatever a newer upstream says about them.
  const excludedNames = new Set();
  const declarationLines = new Set();
  for (const spec of SCAN_PACKAGES) {
    const found = await scanPackage(installedDir(spec), {
      excludedNames,
      declarationLines,
    });
    for (const entry of found) addEntry(entry, "installed", spec);
  }

  // ── Upstream clone, for callable names the installed sources leave bare ───
  const changedUpstream = new Set();
  for (const spec of SCAN_PACKAGES) {
    const dir = join(STRUDEL_SRC, spec.replace("@strudel/", ""));
    for (const entry of await scanPackage(dir)) {
      const names = [entry.name, ...entry.synonyms];
      if (!declarationLines.has(entry.declaration)) {
        const where = `strudel-source (${spec})`;
        for (const n of names) {
          if (!IDENT.test(n) || Object.hasOwn(docs, n)) continue;
          if (callable(n)) changedUpstream.add(n);
          else if (!dropped.has(n)) dropped.set(n, where);
        }
        continue;
      }
      addEntry(
        {
          ...entry,
          name: excludedNames.has(entry.name) ? "" : entry.name,
          synonyms: entry.synonyms.filter((n) => !excludedNames.has(n)),
        },
        "clone",
        `strudel-source (${spec})`,
      );
    }
  }

  await writeFile(OUT, JSON.stringify(docs, null, 2) + "\n");

  const names = Object.keys(docs);
  const out = relative(ROOT, OUT);
  console.log(`[build-strudel-docs] ${names.length} entries → ${out}`);
  console.log(
    `  from src/strudel-ext: ${sources.ext}, installed packages: ${sources.installed}, strudel-source fallback: ${sources.clone}`,
  );
  console.log(
    `  without parameters: ${names.filter((n) => !docs[n].params.length).length}, without examples: ${names.filter((n) => !docs[n].examples.length).length}, needing an opt-in package: ${names.filter((n) => docs[n].requires).length}`,
  );
  if (fromClone.length) {
    console.log(`  documented from strudel-source: ${fromClone.join(" ")}`);
  }
  const stillBare = [...changedUpstream].filter((n) => !Object.hasOwn(docs, n));
  if (stillBare.length) {
    console.log(
      `  left undocumented (upstream documents them, but on a declaration that differs from the installed one): ${stillBare.join(" ")}`,
    );
  }
  if (dropped.size) {
    console.log(
      `  dropped ${dropped.size} documented names that are not callable in this build:`,
    );
    const byWhere = new Map();
    for (const [name, where] of dropped) {
      if (!byWhere.has(where)) byWhere.set(where, []);
      byWhere.get(where).push(name);
    }
    for (const [where, list] of byWhere) {
      console.log(`    ${where}: ${list.join(" ")}`);
    }
  }
  for (const note of notes) console.log(`  note: ${note}`);
}

main().catch((err) => {
  console.error("[build-strudel-docs] fatal:", err);
  process.exit(1);
});
