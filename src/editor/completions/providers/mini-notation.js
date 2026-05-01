// src/editor/completions/providers/mini-notation.js

import { syntaxTree } from "@codemirror/language";
import { soundMap } from "@strudel/webaudio";
import { tokenAtOffset, miniContext } from "../../mini-notation-tokens.js";
import { score } from "../score.js";
import { getBufferTokens } from "../context.js";
import { rankSounds } from "./sounds.js";

const NOTE_NAMES = ["c", "d", "e", "f", "g", "a", "b"];
const ACCIDENTALS = ["", "#", "b"];
const OCTAVES = ["0", "1", "2", "3", "4", "5", "6", "7", "8"];

const NOTE_COMPLETIONS = (() => {
  const opts = [];
  for (const n of NOTE_NAMES) {
    for (const acc of ACCIDENTALS) opts.push({ label: `${n}${acc}` });
  }
  for (const n of NOTE_NAMES) {
    for (const acc of ACCIDENTALS) {
      for (const oct of OCTAVES) opts.push({ label: `${n}${acc}${oct}` });
    }
  }
  return opts;
})();

let cachedKeys = [];
let cachedSnapshot = null;
function getSoundKeys() {
  const current = soundMap.get();
  if (current !== cachedSnapshot) {
    cachedSnapshot = current;
    cachedKeys = Object.keys(current);
  }
  return cachedKeys;
}

/**
 * @param {{ recency: ReturnType<typeof import("../context.js").createRecency> }} deps
 */
export function miniNotationProvider({ recency }) {
  return function provider(context) {
    const ctx = findMiniContext(context.state, context.pos);
    if (!ctx) return null;
    const kind = miniContext(ctx.fnName);
    if (kind === "other") return null;

    const tok = tokenAtOffset(ctx.content, ctx.cursorOffset);
    if (!tok && !context.explicit) return null;

    const fragment = tok ? tok.token : "";
    const from = tok ? ctx.contentFrom + tok.from : context.pos;
    const to = tok ? ctx.contentFrom + tok.to : context.pos;

    if (kind === "sound") {
      const buffer = getBufferTokens().get("sound");
      const ranked = rankSounds({
        fragment,
        buffer,
        recency,
        allKeys: getSoundKeys(),
      });
      if (ranked.length === 0) return null;
      return {
        from, to, filter: false,
        options: ranked.map((r) => ({
          label: r.label,
          type: "sound",
          detail: r.bank,
          boost: r.finalScore,
        })),
      };
    }

    // note context
    const ranked = NOTE_COMPLETIONS
      .map((n) => {
        const m = fragment ? score(fragment, n.label) : { score: 0.3, matched: [] };
        if (!m) return null;
        return {
          label: n.label,
          finalScore: m.score + 0.6,
        };
      })
      .filter(Boolean)
      .sort((a, b) => b.finalScore - a.finalScore);

    if (ranked.length === 0) return null;
    return {
      from, to, filter: false,
      options: ranked.slice(0, 60).map((r) => ({
        label: r.label, type: "constant", boost: r.finalScore,
      })),
    };
  };
}

/**
 * Walk up from cursor to find an enclosing string literal that is a direct
 * argument to a function call. Returns the function name + content range +
 * cursor offset within content. Lifted from the old mini-notation.js with
 * no behavior change in Phase 1; Phase 3 extends with bank-detection.
 */
function findMiniContext(state, pos) {
  const tree = syntaxTree(state);
  const node = tree.resolveInner(pos, -1);

  for (let cur = node; cur; cur = cur.parent) {
    if (cur.name !== "String" && cur.name !== "TemplateString") continue;
    const strFrom = cur.from;
    const strTo = cur.to;
    const raw = state.sliceDoc(strFrom, strTo);
    if (!(raw.startsWith('"') || raw.startsWith("'") || raw.startsWith("`"))) continue;
    const contentFrom = strFrom + 1;
    const contentTo = strTo - (raw.endsWith(raw[0]) ? 1 : 0);
    if (pos < contentFrom || pos > contentTo) continue;

    let fnName = null;
    for (let p = cur.parent; p; p = p.parent) {
      if (p.name === "CallExpression") {
        const callee = p.firstChild;
        if (!callee) break;
        if (callee.name === "VariableName" || callee.name === "Identifier") {
          fnName = state.sliceDoc(callee.from, callee.to);
        } else if (callee.name === "MemberExpression" || callee.name === "MemberAccess") {
          let prop = callee.lastChild;
          if (prop && prop.name === ".") prop = prop.nextSibling;
          if (prop) fnName = state.sliceDoc(prop.from, prop.to);
        }
        break;
      }
      if (p.name === "ArrowFunction" || p.name === "FunctionDeclaration" || p.name === "FunctionExpression") break;
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
