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
 * @param {import('./strudel-docs.json')[string]} entry
 * @returns {HTMLElement}
 */
function renderTooltip(entry) {
  const el = document.createElement("div");
  el.className = "hover-docs";

  // Signature
  const sig = document.createElement("div");
  sig.className = "hover-docs-sig";
  sig.textContent = entry.signature;
  el.appendChild(sig);

  // Description
  if (entry.doc) {
    const desc = document.createElement("div");
    desc.className = "hover-docs-desc";
    desc.textContent = entry.doc;
    el.appendChild(desc);
  }

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
    el.appendChild(params);
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
    el.appendChild(exSection);
  }

  return el;
}

/**
 * CM6 hoverTooltip source. Fires on Identifier nodes that match a
 * known Strudel function name.
 */
function strudelHover(view, pos, side) {
  const tree = syntaxTree(view.state);
  const node = tree.resolveInner(pos, side);

  // Only fire on identifier-like nodes
  const name = node.name;
  if (
    name !== "VariableName" &&
    name !== "PropertyName" &&
    name !== "Identifier" &&
    name !== "PropertyDefinition"
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
      const dom = renderTooltip(entry);
      return { dom };
    },
  };
}

/** CM6 extension: hover-docs for Strudel functions. */
export const hoverDocs = hoverTooltip(strudelHover, {
  hideOnChange: true,
  hoverTime: 350,
});
