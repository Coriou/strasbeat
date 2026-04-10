/**
 * Signature hint: shows a thin pill above the cursor with the function
 * signature when the cursor is inside a CallExpression's arguments.
 *
 * Uses the CM6 syntax tree to detect when the cursor sits between the
 * opening `(` and closing `)` of a known function call, then positions
 * a floating DOM element above the cursor line.
 */
import { EditorView, ViewPlugin } from "@codemirror/view";
import { syntaxTree } from "@codemirror/language";
import { completionStatus } from "@codemirror/autocomplete";
import docs from "./strudel-docs.json";

/**
 * Escape user-facing text for safe HTML insertion.
 * @param {string} s
 */
function esc(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Walk up from `pos` through the syntax tree to find an enclosing
 * ArgList whose parent CallExpression has a known callee name.
 *
 * Returns `{ name, entry, argIndex }` or null.
 */
function findCallContext(state, pos) {
  const tree = syntaxTree(state);
  let node = tree.resolveInner(pos, -1);

  // Walk up looking for ArgList / ArgumentList
  for (let cur = node; cur; cur = cur.parent) {
    const n = cur.name;
    if (n !== "ArgList" && n !== "ArgumentList") continue;

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

    if (!calleeName) continue;
    const entry = docs[calleeName];
    if (!entry) continue;

    // Determine which argument the cursor is in by counting commas
    // before `pos` inside the ArgList.
    let argIndex = 0;
    for (let child = cur.firstChild; child; child = child.nextSibling) {
      if (child.from >= pos) break;
      if (state.sliceDoc(child.from, child.to) === ",") argIndex++;
    }

    return { name: calleeName, entry, argIndex };
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

/**
 * CM6 ViewPlugin that manages the signature hint pill.
 */
const signaturePlugin = ViewPlugin.fromClass(
  class {
    constructor(view) {
      this.view = view;
      this.pill = null;
      this.currentKey = "";
    }

    update(update) {
      if (!update.selectionSet && !update.docChanged && !update.focusChanged) {
        return;
      }

      const { state } = update.view;
      const pos = state.selection.main.head;

      // Hide when autocomplete is active — one surface owns attention at a time
      if (completionStatus(state) !== null) {
        this.hide();
        return;
      }

      // Don't show if there's a selection range (multi-char select)
      if (!state.selection.main.empty) {
        this.hide();
        return;
      }

      const ctx = findCallContext(state, pos);
      if (!ctx) {
        this.hide();
        return;
      }

      // Build a cache key so we don't re-render on every keystroke
      // within the same function + same active param.
      const key = `${ctx.name}:${ctx.argIndex}`;
      if (key === this.currentKey && this.pill) return;
      this.currentKey = key;

      // Defer show() — coordsAtPos reads layout, which is forbidden
      // during the CM6 update cycle. requestMeasure runs after the
      // update settles.
      this._pendingCtx = ctx;
      this.view.requestMeasure({
        read: () => {
          const c = this._pendingCtx;
          if (!c) return null;
          const p = this.view.state.selection.main.head;
          const coords = this.view.coordsAtPos(p);
          if (!coords) return null;
          const parentRect = this.view.dom.getBoundingClientRect();
          return { ctx: c, coords, parentRect };
        },
        write: (measured) => {
          if (!measured) {
            this.hide();
            return;
          }
          this.show(measured.ctx, measured.coords, measured.parentRect);
        },
      });
    }

    show({ name, entry, argIndex }, coords, parentRect) {
      if (!this.pill) {
        this.pill = document.createElement("div");
        this.pill.className = "sig-hint";
        this.pill.setAttribute("role", "tooltip");
        this.pill.setAttribute("aria-live", "polite");
        this.view.dom.appendChild(this.pill);
      }

      this.pill.innerHTML = renderPill(name, entry, argIndex);

      // Place above the line, offset by pill height + 4px gap
      const top = coords.top - parentRect.top - 28;
      const left = coords.left - parentRect.left;

      this.pill.style.top = `${Math.max(0, top)}px`;
      this.pill.style.left = `${Math.max(0, left)}px`;
      this.pill.style.display = "";
    }

    hide() {
      if (this.pill) {
        this.pill.style.display = "none";
        this.currentKey = "";
      }
    }

    destroy() {
      if (this.pill) {
        this.pill.remove();
        this.pill = null;
      }
    }
  },
);

/** CM6 extension: signature hints for Strudel functions. */
export const signatureHint = signaturePlugin;
