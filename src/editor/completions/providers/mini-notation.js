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
    // prior sound. The bank-in-scope lookup uses the syntax tree to find
    // any chained `bank("X")` so the prior token resolves to `X_<token>`.
    if (kind === "sound" && tok && tok.prevSeparator === ":") {
      const bankInScope = findBankInScopeForCursor(context.state, context.pos);
      const variants = computeVariants({
        content: ctx.content,
        tokFrom: tok.from,
        fragment: tok.token,
        bankInScope,
        audition,
      });
      // null  → unknown sound, fall through to other providers (sound shelf)
      // []    → known sound but object-form / no matches; halt the chain
      // [...] → emit variants
      if (variants !== null) return {
        from: ctx.contentFrom + tok.from,
        to: ctx.contentFrom + tok.to,
        filter: false,
        options: variants,
      };
    }

    if (kind === "sound") {
      const bankInScope = findBankInScopeForCursor(context.state, context.pos);
      const buffer = getBufferTokens().get("sound");
      const ranked = rankSounds({
        fragment,
        buffer,
        recency,
        allKeys: getSoundKeys(),
        bankInScope,
      });
      if (ranked.length === 0) return null;
      return {
        from, to, filter: false,
        options: ranked.map((r) => ({
          label: r.label,
          detail: r.detail,
          apply: r.apply,
          type: "sound",
          boost: r.finalScore,
          info: audition
            ? () => buildAuditionInfo(r.apply ?? r.label, audition, r.inBank ? { bank: bankInScope } : undefined)
            : undefined,
          // Stash the audition payload so Alt+Arrow keyboard preview can
          // fire the right name+bank pair. For an in-bank candidate the
          // visible label is the short suffix (`bd`) while the resolved
          // name lives in `r.apply` and the bank prefix in
          // `bankInScope` — pass both so superdough rewrites correctly.
          // Out-of-bank candidates have a fully-qualified `r.apply`, no
          // bank rewrite needed.
          _audition: r.inBank
            ? { name: r.apply, bank: bankInScope }
            : { name: r.apply ?? r.label },
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
  if (!entry || !entry.data) return null; // unknown — let other providers try
  const samples = entry.data.samples;
  if (!Array.isArray(samples)) return []; // known but object-form — halt with empty

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
        ? () => buildVariantInfo(priorToken, resolvedName, n, audition, bankInScope)
        : undefined,
      // Stash the audition payload so Alt+Arrow keyboard preview can
      // fire the variant. `priorToken` is the bare name (e.g. "bd");
      // superdough's previewSoundName does the bank prefixing, so we
      // pass the bank separately rather than the resolved name.
      _audition: { name: priorToken, bank: bankInScope, n },
    });
  }
  return out;
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
 * carries the bare sound name + n + bank captured at completion-build
 * time so the audition fires the right variant.
 *
 * `bareName` is the unprefixed sound token (e.g. "bd"); `resolvedName` is
 * the bank-prefixed lookup key (e.g. "RolandTR909_bd") used only for the
 * tooltip / a11y label. The audition callback receives the bare name with
 * `bank` in opts so superdough's `previewSoundName` does the prefixing —
 * passing the resolved name with bank too would double-prefix.
 */
function buildVariantInfo(bareName, resolvedName, n, audition, bank) {
  const wrap = document.createElement("div");
  wrap.className = "completion-info-audition";
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "completion-info-audition__btn";
  btn.textContent = "▶";
  btn.title = `Preview ${resolvedName}:${n}`;
  btn.setAttribute("aria-label", `Preview ${resolvedName}:${n}`);
  btn.addEventListener("mousedown", (e) => {
    e.preventDefault();
    audition(bareName, { n, bank });
  });
  wrap.appendChild(btn);
  return wrap;
}

/**
 * Resolve the `bank("X")` in scope at the cursor: find the enclosing
 * String node, then walk its containing CallExpression chain (down the
 * callee, up the parent) for any `bank()` calls. Returns the rightmost
 * (last-in-source-order) bank name or null.
 *
 * Per spec §3.B detection algorithm.
 */
function findBankInScopeForCursor(state, pos) {
  const tree = syntaxTree(state);
  const node = tree.resolveInner(pos, -1);
  for (let cur = node; cur; cur = cur.parent) {
    if (cur.name === "String" || cur.name === "TemplateString") {
      return findBankInScope(state, cur);
    }
  }
  return null;
}

/**
 * Walk the chain containing the given String node to find the most recent
 * (rightmost) bank("X") call. Returns the bank name or null.
 *
 * Per spec §3.B detection algorithm: walk both directions of the
 * MemberExpression chain and inspect each CallExpression's callee.
 */
function findBankInScope(state, stringNode) {
  // Find the CallExpression that contains this String.
  let call = stringNode.parent;
  while (call && call.name !== "CallExpression") call = call.parent;
  if (!call) return null;

  const banks = [];

  // Walk DOWN the callee chain.
  let cur = call;
  while (cur && cur.name === "CallExpression") {
    const callee = cur.firstChild;
    if (!callee) break;
    if (callee.name === "VariableName" || callee.name === "Identifier") {
      const name = state.sliceDoc(callee.from, callee.to);
      if (name === "bank") {
        const arg = readFirstStringArg(state, cur);
        if (arg) banks.push({ name: arg, pos: cur.from });
      }
      break;
    }
    if (callee.name === "MemberExpression" || callee.name === "MemberAccess") {
      const prop = callee.lastChild;
      if (prop) {
        const propName = state.sliceDoc(prop.from, prop.to).replace(/^\./, "");
        if (propName === "bank") {
          const arg = readFirstStringArg(state, cur);
          if (arg) banks.push({ name: arg, pos: cur.from });
        }
      }
      cur = callee.firstChild;
    } else {
      break;
    }
  }

  // Walk UP from the s() call.
  let parent = call.parent;
  while (parent) {
    if (parent.name === "MemberExpression" || parent.name === "MemberAccess") {
      const prop = parent.lastChild;
      const propName = prop ? state.sliceDoc(prop.from, prop.to).replace(/^\./, "") : "";
      const callParent = parent.parent;
      if (callParent && callParent.name === "CallExpression" && propName === "bank") {
        const arg = readFirstStringArg(state, callParent);
        if (arg) banks.push({ name: arg, pos: callParent.from });
      }
      parent = callParent ? callParent.parent : null;
      continue;
    }
    break;
  }

  if (banks.length === 0) return null;
  banks.sort((a, b) => b.pos - a.pos);
  return banks[0].name;
}

/**
 * Read the first string argument of a CallExpression. Returns the unquoted
 * inner string, or null if the first arg isn't a String/TemplateString
 * literal.
 */
function readFirstStringArg(state, callNode) {
  for (let c = callNode.firstChild; c; c = c.nextSibling) {
    if (c.name === "ArgList" || c.name === "ArgumentList") {
      const first = c.firstChild?.nextSibling; // skip "("
      if (!first) return null;
      if (first.name === "String" || first.name === "TemplateString") {
        const raw = state.sliceDoc(first.from, first.to);
        if ((raw.startsWith('"') || raw.startsWith("'") || raw.startsWith("`")) && raw.length >= 2) {
          return raw.slice(1, -1);
        }
      }
      return null;
    }
  }
  return null;
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
