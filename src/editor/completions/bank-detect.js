// src/editor/completions/bank-detect.js
//
// Bank-detection helpers shared by:
//   - the mini-notation provider (in-string completions)
//   - the standalone sounds provider (regex-fallback path)
//   - the Cmd+Shift+B reveal-in-browser keymap binding
//
// All three need to ask "given this cursor position / String node, what
// `bank("X")` is in lexical scope on the same call chain?". Extracting
// the algorithm here keeps the implementations in lockstep so a fix in
// one place lands for every caller.
//
// See spec design/work/22-intellisense-v2.md §3.B for the detection
// algorithm; the dispatch walks both directions of the
// MemberExpression chain containing the String.

import { syntaxTree } from "@codemirror/language";

/**
 * Resolve the `bank("X")` in scope at the cursor: find the enclosing
 * String node, then walk its containing CallExpression chain (down the
 * callee, up the parent) for any `bank()` calls. Returns the rightmost
 * (last-in-source-order) bank name or null.
 *
 * Per spec §3.B detection algorithm.
 *
 * @param {import("@codemirror/state").EditorState} state
 * @param {number} pos
 * @returns {string | null}
 */
export function findBankInScopeForCursor(state, pos) {
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
 *
 * @param {import("@codemirror/state").EditorState} state
 * @param {import("@lezer/common").SyntaxNode} stringNode
 * @returns {string | null}
 */
export function findBankInScope(state, stringNode) {
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
 *
 * @param {import("@codemirror/state").EditorState} state
 * @param {import("@lezer/common").SyntaxNode} callNode
 * @returns {string | null}
 */
export function readFirstStringArg(state, callNode) {
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
