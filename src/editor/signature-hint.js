/**
 * Signature hint: a thin pill showing the signature of the function call
 * the cursor is inside, with the active parameter highlighted.
 *
 * The pill is a CodeMirror tooltip driven by a StateField, anchored to the
 * call's opening paren and placed above that line. Letting CodeMirror own
 * the positioning is what keeps it glued to the code: it follows scrolling
 * and layout changes, moves when the cursor jumps to another call of the
 * same function, and travels with the per-tab EditorState. Anchoring to the
 * paren (not the cursor) also keeps it off the lines between the opener and
 * the cursor in a multi-line call.
 */
import { StateField } from "@codemirror/state";
import { showTooltip } from "@codemirror/view";
import { syntaxTree } from "@codemirror/language";
import { completionStatus } from "@codemirror/autocomplete";
import docs from "./strudel-docs.json" with { type: "json" };

/**
 * Escape user-facing text for safe HTML insertion.
 * @param {string} s
 */
function esc(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Walk up from `pos` through the syntax tree to find the innermost
 * ArgList the cursor is *inside* whose parent CallExpression has a known,
 * documented callee.
 *
 * Returns `{ name, entry, argIndex, from }` (`from` is the offset of the
 * opening paren) or null. Exported for tests.
 */
export function findCallContext(state, pos) {
  const tree = syntaxTree(state);
  let node = tree.resolveInner(pos, -1);

  // Walk up looking for ArgList / ArgumentList
  for (let cur = node; cur; cur = cur.parent) {
    const n = cur.name;
    if (n !== "ArgList" && n !== "ArgumentList") continue;

    // The cursor must be between the parens. Right after the closing `)`
    // the tree still resolves to this ArgList, but the call is finished —
    // keep walking, an enclosing call may still apply. An unclosed list
    // (still being typed) has no `)` to be past.
    if (pos <= cur.from) continue;
    const closed = state.sliceDoc(cur.to - 1, cur.to) === ")";
    if (closed && pos >= cur.to) continue;

    // The parent should be the call expression
    const call = cur.parent;
    if (!call) continue;

    // Find the callee name. Could be:
    // - CallExpression > VariableName  (e.g. `note(...)`)
    // - CallExpression > MemberExpression > PropertyName (e.g. `.fast(...)`)
    let calleeName = null;
    const firstChild = call.firstChild;
    if (firstChild) {
      if (
        firstChild.name === "VariableName" ||
        firstChild.name === "Identifier"
      ) {
        calleeName = state.sliceDoc(firstChild.from, firstChild.to);
      } else if (
        firstChild.name === "MemberExpression" ||
        firstChild.name === "MemberAccess"
      ) {
        // Get the property name (last child of the member expression)
        let prop = firstChild.lastChild;
        if (
          prop &&
          (prop.name === "PropertyName" ||
            prop.name === "PropertyDefinition" ||
            prop.name === "Identifier" ||
            prop.name === ".")
        ) {
          // If we landed on '.', step to next sibling
          if (prop.name === ".") prop = prop.nextSibling;
          if (prop) {
            calleeName = state.sliceDoc(prop.from, prop.to);
          }
        }
      }
    }

    // The innermost call owns the cursor. If it isn't something we can
    // describe, show nothing rather than an outer call's signature.
    // hasOwn: `docs` is a plain object, so `docs["toString"]` would
    // otherwise resolve to Object.prototype. A docs entry without params
    // would render as a bare `name()` — misleading for the many functions
    // whose parameters simply aren't documented.
    if (!calleeName || !Object.hasOwn(docs, calleeName)) return null;
    const entry = docs[calleeName];
    if (!entry.params || entry.params.length === 0) return null;

    // Determine which argument the cursor is in by counting commas
    // before `pos` inside the ArgList.
    let argIndex = 0;
    for (let child = cur.firstChild; child; child = child.nextSibling) {
      if (child.from >= pos) break;
      if (state.sliceDoc(child.from, child.to) === ",") argIndex++;
    }

    return { name: calleeName, entry, argIndex, from: cur.from };
  }

  return null;
}

/**
 * Render the signature pill HTML. Highlights the active parameter.
 */
function renderPill(name, entry, argIndex) {
  const params = entry.params || [];
  const parts = params.map((p, i) => {
    const text = p.type ? `${p.name}: ${p.type}` : p.name;
    if (i === argIndex) {
      return `<span class="sig-hint-active-param">${esc(text)}</span>`;
    }
    return esc(text);
  });

  return (
    `<span class="sig-hint-name">${esc(name)}</span>(` + parts.join(", ") + ")"
  );
}

// What the pill should show for `state`, or null for nothing.
function computeHint(state) {
  // Hide when autocomplete is active — one surface owns attention at a time
  if (completionStatus(state) !== null) return null;
  // Don't show if there's a selection range (multi-char select)
  const sel = state.selection.main;
  if (!sel.empty) return null;
  return findCallContext(state, sel.head);
}

// Field value: `{ name, entry, argIndex, from, tooltip } | null`.
//
// CodeMirror tears a tooltip's DOM down and rebuilds it whenever the Tooltip
// object changes identity. While the cursor stays inside the same call the
// previous object is reused, so moving between arguments just re-renders the
// pill in place (no flicker, no replayed pop-in).
function nextHint(prev, ctx) {
  if (!ctx) return null;
  if (prev && prev.name === ctx.name && prev.from === ctx.from) {
    if (prev.argIndex === ctx.argIndex) return prev;
    return { ...ctx, tooltip: prev.tooltip };
  }
  return {
    ...ctx,
    tooltip: {
      pos: ctx.from,
      above: true,
      create: createHintView,
    },
  };
}

const hintField = StateField.define({
  create(state) {
    return nextHint(null, computeHint(state));
  },
  update(value, tr) {
    // Strudel dispatches a highlight transaction per animation frame while
    // playing; only edits, cursor moves and the completion popup opening or
    // closing can change the answer.
    if (
      !tr.docChanged &&
      !tr.selection &&
      completionStatus(tr.startState) === completionStatus(tr.state)
    ) {
      return value;
    }
    return nextHint(value, computeHint(tr.state));
  },
  provide: (f) => showTooltip.from(f, (value) => value?.tooltip ?? null),
});

function createHintView(view) {
  const dom = document.createElement("div");
  dom.className = "sig-hint";
  let rendered = null;

  const render = (state) => {
    const hint = state.field(hintField, false);
    if (!hint || hint === rendered) return;
    rendered = hint;
    dom.innerHTML = renderPill(hint.name, hint.entry, hint.argIndex);
  };
  // The hint describes where the cursor is; with focus elsewhere there is
  // no cursor to describe.
  // Hidden with `visibility`, not `display`: CodeMirror places the tooltip
  // from its measured box, and a display:none pill measures 0×0, so it would
  // flash on top of the code line when shown again.
  const syncFocus = (v) => {
    dom.style.visibility = v.hasFocus ? "" : "hidden";
  };

  render(view.state);
  syncFocus(view);
  return {
    dom,
    update(update) {
      render(update.state);
      if (update.focusChanged) syncFocus(update.view);
    },
  };
}

/** CM6 extension: signature hints for Strudel functions. */
export const signatureHint = hintField;
