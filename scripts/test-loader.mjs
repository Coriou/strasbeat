// Node ESM loader hook for `node --test`. Used only by `pnpm test`, never
// by Vite.
//
// Why this exists: @strudel/core's `repl.mjs` does
// `import { SalatRepl } from '@kabelsalat/web'`. The `@kabelsalat/web`
// package has both a CJS build (`dist/index.js`, exposed via the package's
// `main` field) and an ESM build (`dist/index.mjs`, exposed via the
// `module` field). Node's ESM resolver only honours `main`, so it picks
// the CJS build — which has no named `SalatRepl` export, so the import
// fails with `SyntaxError: does not provide an export named 'SalatRepl'`
// at link time. Vite uses the `module` field, so the dev server has no
// such problem.
//
// This hook intercepts requests for `@kabelsalat/web` and redirects them
// to the .mjs file inside the pnpm store. The version-pinned path is
// brittle on paper but stable in practice — pnpm-lock.yaml fixes the
// exact version, and the loader fails loudly if the path goes stale.
//
// Run with: `node --experimental-loader=./scripts/test-loader.mjs --test ...`

import { existsSync, readdirSync } from "node:fs";
import { dirname, join, resolve as pathResolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pnpmDir = pathResolve(__dirname, "..", "node_modules/.pnpm");

function findKabelsalatEsm() {
  if (!existsSync(pnpmDir)) return null;
  const versions = readdirSync(pnpmDir).filter((d) =>
    d.startsWith("@kabelsalat+web@"),
  );
  for (const v of versions) {
    const candidate = join(
      pnpmDir,
      v,
      "node_modules/@kabelsalat/web/dist/index.mjs",
    );
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

const kabelsalatEsm = findKabelsalatEsm();
if (!kabelsalatEsm) {
  // Fail loudly: silent fallback would re-introduce the original
  // SalatRepl link error and the user would have no idea why.
  throw new Error(
    "[strasbeat test-loader] could not locate @kabelsalat/web's dist/index.mjs in node_modules/.pnpm — has the package layout changed?",
  );
}
const kabelsalatUrl = pathToFileURL(kabelsalatEsm).href;

export async function resolve(specifier, context, nextResolve) {
  if (specifier === "@kabelsalat/web") {
    return { url: kabelsalatUrl, format: "module", shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
