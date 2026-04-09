/**
 * Mini-notation completion: completes sound names inside s("...") / sound("...")
 * and note names inside note("...") / n("...") strings.
 *
 * Works with the Phase 1 combined autocomplete handler — this source is
 * added to the override chain via `installMiniCompletion()`.
 *
 * The completion fires when the cursor is inside a string literal that is
 * a direct argument to s/sound/note/n. It uses a lightweight tokeniser
 * (mini-notation-tokens.js) to identify the current word within the
 * mini-notation string and offers contextual completions.
 */
import { syntaxTree } from "@codemirror/language";
import { soundMap } from "@strudel/webaudio";
import { tokenAtOffset, miniContext } from "../mini-notation-tokens.js";

// ─── Note completions ────────────────────────────────────────────────────
// Standard Western note names with accidentals and octaves.

const NOTE_NAMES = ["c", "d", "e", "f", "g", "a", "b"];
const ACCIDENTALS = ["", "#", "b"];
const OCTAVES = ["0", "1", "2", "3", "4", "5", "6", "7", "8"];

/** Pre-built note completion options. */
const noteCompletions = (() => {
  const opts = [];
  // Plain note names (no octave) — short form
  for (const n of NOTE_NAMES) {
    for (const acc of ACCIDENTALS) {
      opts.push({ label: `${n}${acc}`, type: "constant", boost: 2 });
    }
  }
  // Notes with octaves
  for (const n of NOTE_NAMES) {
    for (const acc of ACCIDENTALS) {
      for (const oct of OCTAVES) {
        opts.push({ label: `${n}${acc}${oct}`, type: "constant", boost: 1 });
      }
    }
  }
  // Rest
  opts.push({ label: "~", type: "keyword", boost: 3 });
  return opts;
})();

// ─── Sound completion cache ──────────────────────────────────────────────

let cachedKeys = [];
let cachedSnapshot = null;

function getSoundOptions() {
  const current = soundMap.get();
  if (current !== cachedSnapshot) {
    cachedSnapshot = current;
    cachedKeys = Object.keys(current)
      .sort()
      .map((name) => ({ label: name, type: "variable" }));
  }
  return cachedKeys;
}

// ─── Tree walking helpers ────────────────────────────────────────────────

/**
 * Walk up from the cursor position to find an enclosing string literal
 * that is a direct argument to a function call. Returns the function name,
 * the string content range, and the quote character, or null.
 */
function findMiniContext(state, pos) {
  const tree = syntaxTree(state);
  let node = tree.resolveInner(pos, -1);

  // Look for a String node around the cursor
  for (let cur = node; cur; cur = cur.parent) {
    if (cur.name !== "String" && cur.name !== "TemplateString") continue;

    // Get the raw doc range of this string node
    const strFrom = cur.from;
    const strTo = cur.to;
    const raw = state.sliceDoc(strFrom, strTo);

    // Determine if it's a quoted string and extract content range
    let contentFrom, contentTo;
    if (raw.startsWith('"') || raw.startsWith("'") || raw.startsWith("`")) {
      contentFrom = strFrom + 1;
      contentTo = strTo - (raw.endsWith(raw[0]) ? 1 : 0);
    } else {
      continue;
    }

    // Cursor must be inside the string content
    if (pos < contentFrom || pos > contentTo) continue;

    // Walk up to find the enclosing call expression
    let fnName = null;
    for (let p = cur.parent; p; p = p.parent) {
      if (p.name === "CallExpression") {
        const callee = p.firstChild;
        if (!callee) break;
        if (callee.name === "VariableName" || callee.name === "Identifier") {
          fnName = state.sliceDoc(callee.from, callee.to);
        } else if (
          callee.name === "MemberExpression" ||
          callee.name === "MemberAccess"
        ) {
          let prop = callee.lastChild;
          if (prop && prop.name === ".") prop = prop.nextSibling;
          if (prop) {
            fnName = state.sliceDoc(prop.from, prop.to);
          }
        }
        break;
      }
      // Don't cross function boundaries
      if (
        p.name === "ArrowFunction" ||
        p.name === "FunctionDeclaration" ||
        p.name === "FunctionExpression"
      ) {
        break;
      }
    }

    if (!fnName) continue;

    return {
      fnName,
      contentFrom,
      contentTo,
      content: state.sliceDoc(contentFrom, contentTo),
      cursorOffset: pos - contentFrom,
    };
  }

  return null;
}

// ─── Completion source ───────────────────────────────────────────────────

/**
 * CM6 CompletionSource for mini-notation contexts.
 *
 * @param {import('@codemirror/autocomplete').CompletionContext} context
 */
export function miniNotationCompletion(context) {
  const ctx = findMiniContext(context.state, context.pos);
  if (!ctx) return null;

  const kind = miniContext(ctx.fnName);
  if (kind === "other") return null;

  const tok = tokenAtOffset(ctx.content, ctx.cursorOffset);

  // If there's no token (cursor at separator), only show completions on
  // explicit invocation (Ctrl+Space) to avoid noise.
  if (!tok && !context.explicit) return null;

  const fragment = tok ? tok.token : "";
  const from = tok ? ctx.contentFrom + tok.from : context.pos;

  let options;
  if (kind === "sound") {
    const all = getSoundOptions();
    options = fragment ? all.filter((o) => o.label.includes(fragment)) : all;
  } else {
    // note context
    options = fragment
      ? noteCompletions.filter((o) => o.label.startsWith(fragment))
      : noteCompletions;
  }

  if (options.length === 0) return null;

  return {
    from,
    to: tok ? ctx.contentFrom + tok.to : context.pos,
    options,
    filter: false, // we already filtered
  };
}
