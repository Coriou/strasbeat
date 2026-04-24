import { transpiler as originalTranspiler } from "@strudel/transpiler";
import { parse } from "acorn";

// Wraps @strudel/transpiler with the upstream silence-fallback.
//
// @strudel/transpiler@1.2.6 throws "unexpected ast format without body
// expression" when a pattern's last top-level statement is not an
// expression — e.g. a `function` declaration, `const`/`let`, or `if`
// block. Real strudel.cc patterns often end that way
// (patterns/mario-flowhacker.js defines helper functions at the bottom),
// so they can't be imported into strasbeat as-is.
//
// Upstream fixed this in
// strudel-source/packages/transpiler/transpiler.mjs:139-141 by pushing a
// synthetic `silence` expression onto the body instead of throwing. That
// fix hasn't shipped to npm yet (1.2.6 is the latest). We mirror it here
// by appending `;silence` to the source before the real transpiler runs.
// Delete this file and restore the direct `@strudel/transpiler` import in
// main.js once a release includes the fallback.
export function transpiler(input, options = {}) {
  if (needsSilenceFallback(input)) {
    input = `${input}\n;silence\n`;
  }
  return originalTranspiler(input, options);
}

// The transpiler's own last-statement check runs after `labelToP` rewrites
// LabeledStatements (`$: pat`) into ExpressionStatements — so a trailing
// `$:` line is fine as-is. Everything else without `.expression` needs
// the fallback.
function needsSilenceFallback(input) {
  let ast;
  try {
    ast = parse(input, {
      ecmaVersion: 2022,
      allowAwaitOutsideFunction: true,
    });
  } catch {
    return false;
  }
  const last = ast.body[ast.body.length - 1];
  if (!last) return false;
  if (last.expression) return false;
  if (last.type === "LabeledStatement") return false;
  return true;
}
