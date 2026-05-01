// src/editor/completions/info.js
//
// Lifted from the old sounds.js monolith — same DOM shape, same class
// names, same CSS hooks (autocomplete-info-*). Renders the rich info
// panel that CodeMirror displays beside a selected completion.

/**
 * @param {string} label
 * @param {{
 *   signature?: string,
 *   doc?: string,
 *   params?: Array<{ name: string, type?: string, doc?: string }>,
 *   examples?: string[]
 * }} entry
 * @returns {HTMLElement}
 */
export function renderCompletionInfo(label, entry) {
  const container = document.createElement("div");
  container.className = "autocomplete-info-container";

  const tooltip = document.createElement("div");
  tooltip.className = "autocomplete-info-tooltip";
  container.appendChild(tooltip);

  const name = document.createElement("h3");
  name.className = "autocomplete-info-function-name";
  name.textContent = entry.signature || `${label}()`;
  tooltip.appendChild(name);

  if (entry.doc) {
    const desc = document.createElement("div");
    desc.className = "autocomplete-info-function-description";
    desc.textContent = entry.doc;
    tooltip.appendChild(desc);
  }

  if (entry.params && entry.params.length > 0) {
    const params = document.createElement("div");
    params.className = "autocomplete-info-params-section";
    for (const p of entry.params) {
      const item = document.createElement("div");
      item.className = "autocomplete-info-param-item";
      const pname = document.createElement("span");
      pname.className = "autocomplete-info-param-name";
      pname.textContent = p.name;
      item.appendChild(pname);
      if (p.type) {
        const ptype = document.createElement("span");
        ptype.className = "autocomplete-info-param-type";
        ptype.textContent = p.type;
        item.appendChild(ptype);
      }
      if (p.doc) {
        const pdesc = document.createElement("div");
        pdesc.className = "autocomplete-info-param-desc";
        pdesc.textContent = p.doc;
        item.appendChild(pdesc);
      }
      params.appendChild(item);
    }
    tooltip.appendChild(params);
  }

  if (entry.examples && entry.examples.length > 0) {
    const ex = document.createElement("div");
    ex.className = "autocomplete-info-examples-section";
    for (const code of entry.examples) {
      const pre = document.createElement("pre");
      pre.className = "autocomplete-info-example-code";
      pre.textContent = code;
      ex.appendChild(pre);
    }
    tooltip.appendChild(ex);
  }

  return container;
}

/**
 * Build a small DOM node with a ▶ button that auditions the given sound
 * via the provided callback. Used as a Completion.info renderer for
 * sound-typed completions, so the docs panel doubles as a one-click
 * preview affordance.
 *
 * The button uses `mousedown` + `e.preventDefault()` to avoid blurring
 * the autocomplete popup (which would close it on click). The audition
 * callback is invoked with `(label, opts)` — Phase 3 (Task 18) extends
 * the opts to pass `n`/`bank` for sample variants and Task 19 passes
 * `bank` for bank-aware sound completions.
 *
 * `opts` is forwarded into the audition callback verbatim. When
 * `opts.bank` is set, the displayed meta line shows `bank_label` so the
 * preview affordance and the resolved sound name stay legible.
 *
 * @param {string} label
 * @param {(name: string, opts?: object) => void} audition
 * @param {object} [opts]
 * @returns {HTMLElement}
 */
export function buildAuditionInfo(label, audition, opts = undefined) {
  const wrap = document.createElement("div");
  wrap.className = "completion-info-audition";

  const resolved = opts && opts.bank ? `${opts.bank}_${label}` : label;
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "completion-info-audition__btn";
  btn.setAttribute("aria-label", `Preview ${resolved}`);
  btn.title = "Preview sound";
  btn.textContent = "▶";
  btn.addEventListener("mousedown", (e) => {
    e.preventDefault(); // don't blur the autocomplete popup
    audition(label, opts || {});
  });
  wrap.appendChild(btn);

  const meta = document.createElement("div");
  meta.className = "completion-info-audition__meta";
  meta.textContent = resolved;
  wrap.appendChild(meta);

  return wrap;
}
