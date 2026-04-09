#!/usr/bin/env node
/**
 * build-strudel-docs.mjs
 *
 * Extracts JSDoc from strudel-source/packages/ and writes a compact JSON
 * index to src/editor/strudel-docs.json for use by hover-docs and
 * signature-hint extensions.
 *
 * Run: node scripts/build-strudel-docs.mjs
 *
 * If strudel-source/ is missing, outputs an empty stub with a warning.
 */
import { readdir, readFile, writeFile, access } from "node:fs/promises";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const STRUDEL_SRC = join(ROOT, "strudel-source", "packages");
const OUT = join(ROOT, "src", "editor", "strudel-docs.json");

// Packages to scan (the ones strasbeat actually uses + core DSP ones).
const SCAN_PACKAGES = [
  "core",
  "mini",
  "tonal",
  "webaudio",
  "draw",
  "superdough",
];

/**
 * Parse JSDoc comment blocks from a source file.
 * Returns an array of { comment, followingCode } objects.
 */
function extractJSDocBlocks(source) {
  const blocks = [];
  const re = /\/\*\*\s*\n([\s\S]*?)\*\//g;
  let match;
  while ((match = re.exec(source)) !== null) {
    const comment = match[1];
    // Get the line following the closing */
    const afterIdx = match.index + match[0].length;
    const restOfLine = source.slice(afterIdx, afterIdx + 500);
    const nextLineMatch = restOfLine.match(/\n\s*(.+)/);
    const followingCode = nextLineMatch ? nextLineMatch[1].trim() : "";
    blocks.push({ comment, followingCode });
  }
  return blocks;
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
      const m = line.match(/@param\s+(?:\{([^}]*)\}\s+)?(\w+)\s*(.*)/);
      if (m) params.push({ name: m[2], type: m[1] || "", doc: m[3] || "" });
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
      // Skip other tags (@tags, @return, @noAutocomplete, etc.)
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

  // Prefer @name tag, then derive from following code.
  let name = nameTag;
  if (!name) {
    // Pattern.prototype methods
    const protoMatch = followingCode.match(
      /(?:Pattern\.prototype\.)?(\w+)\s*[=(]/,
    );
    if (protoMatch) name = protoMatch[1];
  }
  if (!name) {
    // Standalone function/const
    const fnMatch = followingCode.match(
      /(?:export\s+)?(?:function|const|let|var)\s+(\w+)/,
    );
    if (fnMatch) name = fnMatch[1];
  }
  if (!name) {
    // Method definition
    const methodMatch = followingCode.match(/^\s*(\w+)\s*\(/);
    if (methodMatch) name = methodMatch[1];
  }

  return {
    name,
    description: description.trim(),
    params,
    examples: examples.filter(Boolean),
    synonyms,
    excluded,
  };
}

/**
 * Scan a package directory for .mjs/.js files and extract JSDoc.
 */
async function scanPackage(pkgDir) {
  const entries = [];
  let files;
  try {
    files = await readdir(pkgDir, { recursive: true });
  } catch {
    return entries;
  }

  for (const file of files) {
    if (!/\.(mjs|js)$/.test(file)) continue;
    if (/node_modules|dist|test/.test(file)) continue;

    const fullPath = join(pkgDir, file);
    let source;
    try {
      source = await readFile(fullPath, "utf-8");
    } catch {
      continue;
    }

    const blocks = extractJSDocBlocks(source);
    for (const { comment, followingCode } of blocks) {
      const parsed = parseJSDoc(comment, followingCode);
      if (parsed.name && parsed.description && !parsed.excluded) {
        entries.push(parsed);
      }
    }
  }
  return entries;
}

async function main() {
  // Check if strudel-source exists
  try {
    await access(STRUDEL_SRC);
  } catch {
    console.warn(
      "[build-strudel-docs] strudel-source/ not found — writing empty stub",
    );
    await writeFile(OUT, JSON.stringify({}, null, 2) + "\n");
    return;
  }

  const docs = {};
  for (const pkg of SCAN_PACKAGES) {
    const pkgDir = join(STRUDEL_SRC, pkg);
    const entries = await scanPackage(pkgDir);
    for (const entry of entries) {
      if (!entry.name || docs[entry.name]) continue;

      const signature = entry.params.length
        ? `${entry.name}(${entry.params.map((p) => (p.type ? `${p.name}: ${p.type}` : p.name)).join(", ")})`
        : `${entry.name}()`;

      docs[entry.name] = {
        signature,
        doc: entry.description,
        params: entry.params,
        examples: entry.examples,
      };

      // Register synonyms as separate entries pointing to the same data
      for (const syn of entry.synonyms) {
        if (!docs[syn]) {
          docs[syn] = {
            signature: signature.replace(entry.name, syn),
            doc: entry.description,
            params: entry.params,
            examples: entry.examples,
          };
        }
      }
    }
  }

  const count = Object.keys(docs).length;
  await writeFile(OUT, JSON.stringify(docs, null, 2) + "\n");
  console.log(
    `[build-strudel-docs] extracted ${count} entries → src/editor/strudel-docs.json`,
  );
}

main().catch((err) => {
  console.error("[build-strudel-docs] fatal:", err);
  process.exit(1);
});
