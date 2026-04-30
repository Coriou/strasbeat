// Node ESM loader hook for `node --test`. Used only by `pnpm test`, never
// by Vite.
//
// Why this exists:
//
//   1. @strudel/core's `repl.mjs` does
//      `import { SalatRepl } from '@kabelsalat/web'`. The `@kabelsalat/web`
//      package has both a CJS build (`dist/index.js`, exposed via the package's
//      `main` field) and an ESM build (`dist/index.mjs`, exposed via the
//      `module` field). Node's ESM resolver only honours `main`, so it picks
//      the CJS build — which has no named `SalatRepl` export, so the import
//      fails with `SyntaxError: does not provide an export named 'SalatRepl'`
//      at link time. Vite uses the `module` field, so the dev server has no
//      such problem.
//
//   2. `@codemirror/lang-javascript` is installed transitively via
//      `@strudel/codemirror`, but it's not in strasbeat's package.json
//      `dependencies` — so node's resolver can't find it. The intellisense
//      buffer-context test (Task 6 of intellisense-v2) needs it to parse
//      patterns into a Lezer Tree to verify the syntax-tree walker.
//      Adding it to package.json is overkill for one test; aliasing it
//      here mirrors the @kabelsalat/web pattern.
//
// Both aliases redirect to the .mjs/.js file inside the pnpm store. The
// version-pinned paths are brittle on paper but stable in practice —
// pnpm-lock.yaml fixes the exact versions, and the loader fails loudly
// if a path goes stale.
//
// Run with: `node --import ./scripts/test-register.mjs --test ...`

import { existsSync, readdirSync } from "node:fs";
import { dirname, join, resolve as pathResolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pnpmDir = pathResolve(__dirname, "..", "node_modules/.pnpm");

function findInPnpmStore(packagePrefix, relativeFile) {
  if (!existsSync(pnpmDir)) return null;
  const versions = readdirSync(pnpmDir).filter((d) =>
    d.startsWith(packagePrefix),
  );
  for (const v of versions) {
    const candidate = join(pnpmDir, v, relativeFile);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

const kabelsalatEsm = findInPnpmStore(
  "@kabelsalat+web@",
  "node_modules/@kabelsalat/web/dist/index.mjs",
);
if (!kabelsalatEsm) {
  // Fail loudly: silent fallback would re-introduce the original
  // SalatRepl link error and the user would have no idea why.
  throw new Error(
    "[strasbeat test-loader] could not locate @kabelsalat/web's dist/index.mjs in node_modules/.pnpm — has the package layout changed?",
  );
}
const kabelsalatUrl = pathToFileURL(kabelsalatEsm).href;

const langJavascriptEsm = findInPnpmStore(
  "@codemirror+lang-javascript@",
  "node_modules/@codemirror/lang-javascript/dist/index.js",
);
const langJavascriptUrl = langJavascriptEsm
  ? pathToFileURL(langJavascriptEsm).href
  : null;

export async function resolve(specifier, context, nextResolve) {
  if (specifier === "@kabelsalat/web") {
    return { url: kabelsalatUrl, format: "module", shortCircuit: true };
  }
  if (specifier === "@codemirror/lang-javascript" && langJavascriptUrl) {
    return { url: langJavascriptUrl, format: "module", shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
