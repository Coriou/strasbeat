/**
 * Hover docs: CM6 hoverTooltip that shows Strudel function documentation
 * when hovering an identifier in the editor.
 *
 * Reads from the generated `strudel-docs.json` index (built by
 * `scripts/build-strudel-docs.mjs`). Unknown identifiers are ignored —
 * no empty bubbles, no crashes.
 */
import { hoverTooltip } from "@codemirror/view";
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
 * Build the DOM for a hover tooltip.
 * Compact by default: signature + truncated description.
 * Params and examples are collapsed behind a disclosure toggle.
 * @param {import('./strudel-docs.json')[string]} entry
 * @param {string} name — the function name (needed for the deep link)
 * @param {((name: string) => void) | null} onOpenReference — when provided,
 *        appends a "→ Reference" link that calls this callback with `name`
 * @returns {HTMLElement}
 */
function renderTooltip(entry, name, onOpenReference) {
  const el = document.createElement("div");
  el.className = "hover-docs";

  // Signature
  const sig = document.createElement("div");
  sig.className = "hover-docs-sig";
  sig.textContent = entry.signature;
  el.appendChild(sig);

  // Description — truncated to ~120 chars in compact mode
  if (entry.doc) {
    const desc = document.createElement("div");
    desc.className = "hover-docs-desc";
    desc.textContent = entry.doc;
    el.appendChild(desc);
  }

  // Params + examples behind a collapsible details element
  const hasDetail =
    (entry.params && entry.params.length > 0) ||
    (entry.examples && entry.examples.length > 0);

  if (hasDetail) {
    const details = document.createElement("details");
    details.className = "hover-docs-details";

    const summary = document.createElement("summary");
    summary.className = "hover-docs-summary";
    const parts = [];
    if (entry.params?.length)
      parts.push(
        `${entry.params.length} param${entry.params.length > 1 ? "s" : ""}`,
      );
    if (entry.examples?.length)
      parts.push(
        `${entry.examples.length} example${entry.examples.length > 1 ? "s" : ""}`,
      );
    summary.textContent = parts.join(", ");
    details.appendChild(summary);

    // Params
    if (entry.params && entry.params.length > 0) {
      const params = document.createElement("div");
      params.className = "hover-docs-params";
      for (const p of entry.params) {
        const row = document.createElement("div");
        row.className = "hover-docs-param";
        row.innerHTML =
          `<span class="hover-docs-param-name">${esc(p.name)}</span>` +
          (p.type
            ? `<span class="hover-docs-param-type">${esc(p.type)}</span>`
            : "") +
          (p.doc
            ? `<span class="hover-docs-param-doc"> — ${esc(p.doc)}</span>`
            : "");
        params.appendChild(row);
      }
      details.appendChild(params);
    }

    // Examples
    if (entry.examples && entry.examples.length > 0) {
      const exSection = document.createElement("div");
      exSection.className = "hover-docs-examples";
      for (const ex of entry.examples) {
        const pre = document.createElement("pre");
        pre.className = "hover-docs-example";
        pre.textContent = ex;
        exSection.appendChild(pre);
      }
      details.appendChild(exSection);
    }

    el.appendChild(details);
  }

  // Deep link to the API reference panel
  if (typeof onOpenReference === "function") {
    const link = document.createElement("button");
    link.type = "button";
    link.className = "hover-docs-ref-link";
    link.textContent = "→ Reference";
    link.addEventListener("mousedown", (e) => {
      e.preventDefault();
      e.stopPropagation();
      try {
        onOpenReference(name);
      } catch (err) {
        console.warn("[hover-docs] onOpenReference failed:", err);
      }
    });
    el.appendChild(link);
  }

  return el;
}

/**
 * Build a CM6 hoverTooltip source for Strudel functions. Fires on
 * Identifier nodes that match a known function name in `docs`. The
 * `onOpenReference` callback (if provided) is plumbed into each rendered
 * tooltip so the "→ Reference" link can deep-link into the API reference
 * panel — see src/ui/reference-panel.js and main.js's wiring.
 */
function makeStrudelHover(onOpenReference) {
  return function strudelHover(view, pos, side) {
    // Suppress hover docs when autocomplete is active — avoid overlay collision
    if (completionStatus(view.state) !== null) return null;

    const tree = syntaxTree(view.state);
    const node = tree.resolveInner(pos, side);

    // Only fire on identifier-like nodes
    const nodeName = node.name;
    if (
      nodeName !== "VariableName" &&
      nodeName !== "PropertyName" &&
      nodeName !== "Identifier" &&
      nodeName !== "PropertyDefinition"
    ) {
      return null;
    }

    const text = view.state.sliceDoc(node.from, node.to);
    const entry = docs[text];
    if (!entry) return null;

    return {
      pos: node.from,
      end: node.to,
      above: true,
      create() {
        const dom = renderTooltip(entry, text, onOpenReference);
        return { dom };
      },
    };
  };
}

/**
 * CM6 extension factory: hover-docs for Strudel functions.
 *
 *   editor.dispatch({
 *     effects: StateEffect.appendConfig.of([
 *       hoverDocs({ onOpenReference: (name) => referencePanel.scrollTo(name) }),
 *     ]),
 *   });
 *
 * `onOpenReference` is optional — when omitted the tooltip omits the
 * deep-link button entirely so it stays callable from places that
 * haven't wired the reference panel yet.
 *
 * @param {{ onOpenReference?: (name: string) => void }} [opts]
 */
export function hoverDocs(opts = {}) {
  return hoverTooltip(makeStrudelHover(opts.onOpenReference ?? null), {
    hideOnChange: true,
    hoverTime: 350,
  });
}
