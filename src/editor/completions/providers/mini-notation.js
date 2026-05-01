// src/editor/completions/providers/mini-notation.js

import { syntaxTree } from "@codemirror/language";
import { soundMap } from "@strudel/webaudio";
import { tokenAtOffset, miniContext } from "../../mini-notation-tokens.js";
import { score } from "../score.js";
import { getBufferTokens } from "../context.js";
import { buildAuditionInfo } from "../info.js";
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
 * @param {{
 *   recency: ReturnType<typeof import("../context.js").createRecency>,
 *   audition?: (name: string, opts?: object) => void
 * }} deps
 */
export function miniNotationProvider({ recency, audition }) {
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

    // Variant fragment (after a colon) — emit numeric variants of the
    // prior sound. Bank-context resolution lands in Task 19; until then
    // we use the bare token name as the lookup key.
    if (kind === "sound" && tok && tok.prevSeparator === ":") {
      const variants = computeVariants({
        content: ctx.content,
        tokFrom: tok.from,
        fragment: tok.token,
        bankInScope: null, // wired in Task 19
        audition,
      });
      if (variants) return {
        from: ctx.contentFrom + tok.from,
        to: ctx.contentFrom + tok.to,
        filter: false,
        options: variants,
      };
    }

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
          info: audition ? () => buildAuditionInfo(r.label, audition) : undefined,
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
 * Variant fragment after a colon in mini-notation: walk back to find the
 * prior token (the sound name), look up its registered samples, and emit
 * one completion per array index.
 *
 * Skips object-form sample maps (chromatic soundfonts) — there the colon
 * isn't directly indexable.
 *
 * `bankInScope` is the resolved bank prefix (Task 19); the sound is looked
 * up under `${bank}_${name}` when present.
 */
function computeVariants({ content, tokFrom, fragment, bankInScope, audition }) {
  // Walk back from the colon to find the prior token (the sound name).
  let i = tokFrom - 1;
  if (i < 0 || content[i] !== ":") return null;
  i--;
  const SEP = /[\s[\]<>{},|!@?*/:~]/;
  const priorEnd = i + 1;
  while (i >= 0 && !SEP.test(content[i])) i--;
  const priorStart = i + 1;
  const priorToken = content.slice(priorStart, priorEnd);
  if (!priorToken) return null;

  const resolvedName = bankInScope ? `${bankInScope}_${priorToken}` : priorToken;
  const entry = soundMap.get()[resolvedName.toLowerCase()];
  if (!entry || !entry.data) return null;
  const samples = entry.data.samples;
  if (!Array.isArray(samples)) return null; // skip object form (chromatic)

  const lowFrag = fragment.toLowerCase();
  const out = [];
  for (let n = 0; n < samples.length; n++) {
    const label = String(n);
    if (lowFrag && !label.startsWith(lowFrag)) continue;
    const fileName = describeSample(samples[n]);
    out.push({
      label,
      type: "constant",
      detail: fileName,
      apply: label,
      info: audition
        ? () => buildVariantInfo(resolvedName, n, audition, bankInScope)
        : undefined,
    });
  }
  return out.length > 0 ? out : null;
}

function describeSample(sample) {
  if (typeof sample === "string") {
    const slash = sample.lastIndexOf("/");
    return slash >= 0 ? sample.slice(slash + 1) : sample;
  }
  return "";
}

/**
 * Build a small DOM node with a ▶ button that auditions the given variant
 * via the provided callback. Same shape as info.js#buildAuditionInfo, but
 * carries the resolved sound name + n + bank captured at completion-build
 * time so the audition fires the right variant.
 */
function buildVariantInfo(resolvedName, n, audition, bank) {
  const wrap = document.createElement("div");
  wrap.className = "completion-info-audition";
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "completion-info-audition__btn";
  btn.textContent = "▶";
  btn.title = `Preview ${resolvedName}:${n}`;
  btn.addEventListener("mousedown", (e) => {
    e.preventDefault();
    audition(resolvedName, { n, bank });
  });
  wrap.appendChild(btn);
  return wrap;
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
