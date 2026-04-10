// Reference panel — second tab in the right rail.
//
// Searchable, categorized, example-rich browser for Strudel's ~552-
// function surface area. Same shape as src/ui/sound-browser.js (factory
// function, pure DOM, owns its own state) but the data source is
// strudel-docs.json instead of the live soundMap. See
// design/work/08-feature-parity-and-beyond.md "Phase 2: API Reference
// Panel".
//
// What it does:
//   - Search across function name + description + synonyms, ranked
//     exact > prefix > substring (debounced 150ms).
//   - Filter by category pill: Popular / Sound / Pattern / Effects /
//     Tonal / Mini / All. Functions can belong to multiple categories
//     — the pill is a filter, not a partition. Mini is a hand-curated
//     reference for mini-notation operators (`*`, `/`, `<>`, `[]`,
//     `~`, `!`, `@`, `?`, `{}`, `,`), not pulled from strudel-docs.json.
//   - Click an entry to expand it (accordion: only one entry open at
//     a time). Expanded view shows signature, description, params,
//     examples, and synonyms (functions sharing identical doc + params).
//   - "Try" replaces the editor buffer with a minimal playable pattern
//     using the function and re-evaluates. The host (main.js) handles
//     the dirty-buffer confirmation through the modal system.
//   - "Insert" inserts a `name()` call template at the cursor.
//   - Entries appearing in the current buffer get a subtle "in use"
//     dot, same shape as the sound browser's `setBufferText()` pattern.
//   - `scrollTo(name)` is the deep-link target from hover-docs: switches
//     the panel to "All", clears any active search, expands and scrolls
//     to the named entry.
//   - Keyboard nav: ArrowUp/Down moves the active entry, Enter expands
//     a collapsed entry / triggers Try on an already-expanded one,
//     Escape returns focus to the editor.
//
// Public surface (factory pattern, identical shape to
// createSoundBrowserPanel):
//
//   const panel = createReferencePanel({
//     docs,            // strudel-docs.json
//     onTry,           // (exampleCode: string) => Promise<void>
//     onInsert,        // (name: string, template: string) => void
//     onFocusEditor,   // () => void
//   });
//   rightRail.registerPanel(panel);
//   panel.setBufferText(editor.code); // refresh "in use" highlights
//   panel.scrollTo('lpf');            // deep link from hover-docs
//
// Pure DOM, no framework. Match the imperative style of left-rail.js,
// transport.js, and sound-browser.js.

import { makeIcon } from "./icons.js";

const SEARCH_DEBOUNCE_MS = 150;

// ─── Category assignments ────────────────────────────────────────────────
//
// Hardcoded because strudel-docs.json has no `tags` field. Names that
// aren't actually present in `docs` are dropped from their category at
// build time (with a console warning) so a stale category list never
// breaks the panel — surface silent failures loudly per CLAUDE.md.
//
// Categories overlap on purpose: `note` lives in both Popular and
// Tonal, `gain` in Popular / Sound / Effects, etc.

const POPULAR = [
  "note",
  "s",
  "sound",
  "stack",
  "cat",
  "n",
  "gain",
  "lpf",
  "delay",
  "room",
  "speed",
  "pan",
  "rev",
  "arp",
  "chord",
  "scale",
  "voicing",
  "setcpm",
  "silence",
];

const SOUND = [
  "s",
  "sound",
  "bank",
  "n",
  "gain",
  "pan",
  "orbit",
  "speed",
  "begin",
  "end",
  "loop",
  "cut",
  "clip",
  "samples",
];

const PATTERN = [
  "stack",
  "cat",
  "slowcat",
  "arrange",
  "rev",
  "fast",
  "slow",
  "every",
  "when",
  "sometimes",
  "rarely",
  "often",
  "almostAlways",
  "almostNever",
  "firstOf",
  "lastOf",
  "jux",
  "off",
  "struct",
  "mask",
  "euclid",
  "iter",
  "chunk",
  "striate",
  "chop",
  "splice",
  "randcat",
  "choose",
  "wchoose",
  "segment",
  "range",
  "run",
  "irand",
  "rand",
  "perlin",
  "sine",
  "saw",
  "tri",
  "square",
];

const EFFECTS = [
  "lpf",
  "hpf",
  "bpf",
  "lpenv",
  "hpenv",
  "delay",
  "delaytime",
  "delayfeedback",
  "room",
  "roomsize",
  "shape",
  "distort",
  "crush",
  "coarse",
  "phaser",
  "phaserdepth",
  "vibrato",
  "vibmod",
  "vowel",
  "pan",
  "orbit",
  "gain",
  "velocity",
  "attack",
  "decay",
  "sustain",
  "release",
  "adsr",
];

const TONAL = [
  "note",
  "chord",
  "scale",
  "voicing",
  "voicings",
  "mode",
  "transpose",
  "add",
  "sub",
  "mul",
  "div",
  "octave",
  "offset",
];

// Mini-notation operators — synthesized entries, not from strudel-docs
// (those operators are mini-language syntax, not JS functions, and
// don't have JSDoc). Each entry is shaped like a docs entry so the rest
// of the render path doesn't have to special-case it.
const MINI_OPERATORS = [
  {
    name: "*",
    signature: "pattern * n",
    doc: "Repeat: speed up the pattern n times per cycle. `bd*4` plays four kicks every cycle.",
    examples: ['s("bd*4")', 's("hh*8")'],
    aliases: ["repeat", "multiply", "speed up", "faster"],
  },
  {
    name: "/",
    signature: "pattern / n",
    doc: "Slow down: stretch the pattern over n cycles. `bd/2` plays one kick every two cycles.",
    examples: ['s("bd/2")', 's("[bd sd]/2")'],
    aliases: ["slow down", "divide", "stretch", "slower"],
  },
  {
    name: "<>",
    signature: "<a b c …>",
    doc: "Alternate: cycle through values one per cycle. Cycle 0 picks `a`, cycle 1 picks `b`, and so on.",
    examples: ['s("<bd sd cp>")', 'note("<c e g>").s("piano")'],
    aliases: ["alternate", "cycle", "switch", "rotate"],
  },
  {
    name: "[ ]",
    signature: "[a b c …]",
    doc: "Group: pack a sub-pattern into one step. `bd [hh hh]` plays one bd then two hats inside the same step.",
    examples: ['s("bd [hh hh] sd hh")'],
    aliases: ["group", "subdivide", "bracket", "nest"],
  },
  {
    name: "~",
    signature: "~",
    doc: "Rest: silence for one step. Useful for placing gaps inside a pattern.",
    examples: ['s("bd ~ sd ~")'],
    aliases: ["rest", "silence", "gap", "pause"],
  },
  {
    name: "!",
    signature: "value!n",
    doc: "Replicate: repeat a value n consecutive steps without speeding it up. `bd!3` is shorthand for `bd bd bd`.",
    examples: ['s("bd!3 sd")', 'note("c!2 e!2 g!2")'],
    aliases: ["replicate", "duplicate", "copy"],
  },
  {
    name: "@",
    signature: "value@n",
    doc: "Elongate: make a value take up n steps of cycle space. `bd@3 sd` makes the kick three times as long as the snare.",
    examples: ['s("bd@3 sd")'],
    aliases: ["elongate", "hold", "sustain", "extend", "weight"],
  },
  {
    name: "?",
    signature: "value? / value?p",
    doc: "Degrade: drop the value 50% of the time. Append a probability to override (e.g. `bd?0.2` plays 20% of the time).",
    examples: ['s("hh? hh hh? hh")'],
    aliases: ["degrade", "random", "probability", "chance", "maybe"],
  },
  {
    name: "{ }",
    signature: "{a b, c d e}%n",
    doc: "Polymeter: stack two patterns of different lengths and align them every n steps via `%n`.",
    examples: ['s("{bd sd, hh hh hh}%4")'],
    aliases: ["polymeter", "polyrhythm", "different lengths"],
  },
  {
    name: ",",
    signature: "[a, b, c …]",
    doc: "Parallel: stack values inside `[]` so they play simultaneously. The mini-language equivalent of `stack(...)`.",
    examples: ['s("[bd, hh]*4")', 'note("[c, e, g]")'],
    aliases: ["parallel", "stack", "simultaneous", "layer", "combine"],
  },
];

const CATEGORIES = [
  {
    id: "popular",
    label: "Popular",
    description: "Starter moves for sound, timing, and tone-shaping.",
    set: new Set(POPULAR),
  },
  {
    id: "sound",
    label: "Sound",
    description: "Pick sources, layer samples, and shape playback.",
    set: new Set(SOUND),
  },
  {
    id: "pattern",
    label: "Pattern",
    description: "Structure time, variation, and layered sequences.",
    set: new Set(PATTERN),
  },
  {
    id: "effects",
    label: "Effects",
    description: "Filter, space, and texture controls for the signal.",
    set: new Set(EFFECTS),
  },
  {
    id: "tonal",
    label: "Tonal",
    description: "Pitch, harmony, scales, and voicing tools.",
    set: new Set(TONAL),
  },
  {
    id: "mini",
    label: "Mini",
    description: "Operators used inside quoted mini-notation patterns.",
    set: null,
    title: "Mini-notation operators (the pattern language inside quotes)",
  },
  {
    id: "all",
    label: "All",
    description: "Every documented Strudel function and mini operator.",
    set: null,
  },
];

// ─── Factory ─────────────────────────────────────────────────────────────

export function createReferencePanel({
  docs,
  onTry = () => {},
  onInsert = () => {},
  onFocusEditor = () => {},
}) {
  // ─── State ─────────────────────────────────────────────────────────────
  /** All entries (552 strudel + 10 mini) with categories + synonyms baked in. */
  let allEntries = [];
  /** name → entry, for fast scrollTo() lookup. */
  const entryByName = new Map();
  /** Names of entries currently appearing in the editor buffer. */
  let inUse = new Set();
  let query = "";
  let category = "popular";
  /** Name of the single accordion-expanded entry, or null. */
  let expandedName = null;
  let activeIndex = -1;

  // DOM refs (re-bound on create()).
  let root = null;
  let searchInput = null;
  let summaryTitleEl = null;
  let summaryMetaEl = null;
  let pillsEl = null;
  let listEl = null;
  let countEl = null;
  let mounted = false;
  let searchTimer = null;

  // Each render() flattens visible entries into this list so keyboard
  // nav can map activeIndex → entry name without re-walking the DOM.
  /** @type {Array<{ name: string, source: string }>} */
  let flatVisible = [];

  // Build entries up front — strudel-docs.json is a static import, so
  // there's no point deferring this until the first render().
  buildEntries();

  // ─── Right-rail panel spec ─────────────────────────────────────────────

  return {
    id: "reference",
    icon: "book-open",
    label: "API reference",
    create,
    activate,
    deactivate,
    setBufferText,
    scrollTo,
  };

  // ─── Lifecycle ─────────────────────────────────────────────────────────

  function create(container) {
    root = container;
    root.classList.add("reference-panel");

    // Header — search input.
    const header = el("div", "reference-panel__header");
    const search = el("div", "reference-panel__search");
    const searchIcon = el("span", "reference-panel__search-icon");
    searchIcon.appendChild(makeIcon("search"));
    search.appendChild(searchIcon);

    searchInput = el("input", "reference-panel__search-input");
    searchInput.type = "text";
    searchInput.placeholder = "Search functions…";
    searchInput.setAttribute("aria-label", "Search functions");
    searchInput.spellcheck = false;
    searchInput.autocomplete = "off";
    searchInput.addEventListener("input", onSearchInput);
    searchInput.addEventListener("keydown", onSearchKeydown);
    search.appendChild(searchInput);
    header.appendChild(search);

    const summary = el("div", "reference-panel__summary");
    summaryTitleEl = el("div", "reference-panel__summary-title");
    summaryMetaEl = el("div", "reference-panel__summary-meta");
    summary.appendChild(summaryTitleEl);
    summary.appendChild(summaryMetaEl);
    header.appendChild(summary);
    root.appendChild(header);

    // Category pills.
    pillsEl = el("div", "reference-panel__pills");
    pillsEl.setAttribute("role", "tablist");
    pillsEl.setAttribute("aria-label", "Reference category");
    for (const c of CATEGORIES) {
      const pill = document.createElement("button");
      pill.type = "button";
      pill.className = "reference-panel__pill";
      pill.dataset.category = c.id;
      pill.textContent = c.label;
      if (c.title) pill.title = c.title;
      pill.setAttribute("role", "tab");
      pill.setAttribute("aria-selected", c.id === category ? "true" : "false");
      if (c.id === category) pill.classList.add("is-active");
      pill.addEventListener("click", () => {
        if (category === c.id) return;
        setCategory(c.id);
        render();
      });
      pillsEl.appendChild(pill);
    }
    root.appendChild(pillsEl);

    // List container — scroll region for collapsed/expanded entries.
    listEl = el("div", "reference-panel__list");
    listEl.setAttribute("role", "listbox");
    listEl.setAttribute("aria-label", "Functions");
    listEl.addEventListener("keydown", onListKeydown);
    root.appendChild(listEl);

    // Footer — count of visible / total entries.
    countEl = el("div", "reference-panel__count");
    root.appendChild(countEl);

    mounted = true;
    render();
  }

  function activate() {
    if (!mounted) return;
    if (searchInput) {
      searchInput.focus();
      searchInput.select();
    }
  }

  function deactivate() {
    // No timers/listeners that need teardown — the panel keeps its DOM
    // (and scroll position) so re-activate is fast.
  }

  // ─── Public helpers ────────────────────────────────────────────────────

  function setBufferText(text) {
    inUse = scanInUse(text ?? "", allEntries);
    if (mounted) render();
  }

  /**
   * Open the panel to a specific function. Used by hover-docs to deep-
   * link from the editor tooltip. Always switches to the "All" category
   * and clears the search so the entry is guaranteed visible regardless
   * of the current filter state.
   */
  function scrollTo(name) {
    if (!entryByName.has(name)) {
      console.warn(`[reference-panel] scrollTo: unknown function "${name}"`);
      return;
    }
    if (!mounted) {
      // The right-rail wiring guarantees create() runs before scrollTo()
      // is called from a deep link, but if a future caller violates that
      // ordering we want to fail loudly rather than silently no-op.
      console.warn("[reference-panel] scrollTo called before mount");
      return;
    }
    // Reset filters so the entry is visible regardless of current state.
    if (category !== "all") {
      setCategory("all");
    }
    if (searchInput.value || query) {
      searchInput.value = "";
      query = "";
    }
    expandedName = name;
    render();
    activeIndex = flatVisible.findIndex((e) => e.name === name);
    const target = listEl.querySelector(
      `.reference-panel__entry[data-entry-name="${cssEscape(name)}"]`,
    );
    if (target) {
      target.scrollIntoView({ block: "center" });
      target.classList.add("is-active");
    }
  }

  // ─── Build entries ─────────────────────────────────────────────────────

  function buildEntries() {
    if (!docs || typeof docs !== "object") {
      console.warn(
        "[reference-panel] strudel-docs.json is empty or invalid:",
        docs,
      );
      allEntries = [];
      return;
    }
    const names = Object.keys(docs);
    if (names.length === 0) {
      console.warn(
        "[reference-panel] strudel-docs.json has no entries — has `pnpm gen:docs` run?",
      );
    }

    // Group by (doc, params) so we can attach synonym lists. Two
    // entries with identical doc + params signal that one is an alias
    // for the other (e.g. `s` and `sound`).
    const synonymGroups = new Map();
    for (const name of names) {
      const e = docs[name];
      const key = JSON.stringify({ doc: e.doc ?? "", params: e.params ?? [] });
      if (!synonymGroups.has(key)) synonymGroups.set(key, []);
      synonymGroups.get(key).push(name);
    }

    // Walk strudel docs entries.
    const out = [];
    for (const name of names) {
      const e = docs[name];
      const key = JSON.stringify({ doc: e.doc ?? "", params: e.params ?? [] });
      const group = synonymGroups.get(key) ?? [name];
      const synonyms = group.filter((n) => n !== name);
      const categories = new Set(["all"]);
      for (const c of CATEGORIES) {
        if (c.set && c.set.has(name)) categories.add(c.id);
      }
      out.push({
        name,
        source: "strudel",
        signature: e.signature ?? `${name}()`,
        doc: e.doc ?? "",
        params: e.params ?? [],
        examples: e.examples ?? [],
        synonyms,
        categories,
      });
    }

    // Mini operators get their own entries; they only belong to "mini"
    // and "all".
    for (const m of MINI_OPERATORS) {
      out.push({
        name: m.name,
        source: "mini",
        signature: m.signature,
        doc: m.doc,
        params: [],
        examples: m.examples ?? [],
        synonyms: [],
        aliases: m.aliases ?? [],
        categories: new Set(["mini", "all"]),
      });
    }

    // Surface stale category lists — a name in the category set that
    // has no docs entry usually means the JSDoc was renamed upstream.
    for (const c of CATEGORIES) {
      if (!c.set) continue;
      for (const wanted of c.set) {
        if (!docs[wanted]) {
          console.warn(
            `[reference-panel] category "${c.id}" lists "${wanted}" but it's not in strudel-docs.json — drop it from the list or run pnpm gen:docs`,
          );
        }
      }
    }

    allEntries = out;
    entryByName.clear();
    for (const e of allEntries) entryByName.set(e.name, e);
  }

  // ─── Render ────────────────────────────────────────────────────────────

  function render() {
    if (!listEl) return;
    listEl.replaceChildren();
    flatVisible = [];
    activeIndex = -1;

    // 1. Filter by category.
    const visible = allEntries.filter((e) => e.categories.has(category));

    // 2. Filter + rank by query (or sort alpha if no query).
    const ranked = query ? rankEntries(visible, query) : sortAlpha(visible);
    const categoryDef = getCategory(category);
    const usedVisibleCount = ranked.filter((entry) =>
      inUse.has(entry.name),
    ).length;

    updateSummary(categoryDef, ranked.length, usedVisibleCount);

    const countText =
      ranked.length === allEntries.length
        ? `${allEntries.length} entries`
        : `${ranked.length} of ${allEntries.length}`;
    countEl.textContent = usedVisibleCount
      ? `${countText} · ${usedVisibleCount} used`
      : countText;

    if (allEntries.length === 0) {
      const empty = el("div", "reference-panel__empty", "no docs loaded");
      listEl.appendChild(empty);
      return;
    }
    if (ranked.length === 0) {
      const empty = el(
        "div",
        "reference-panel__empty",
        query
          ? `no functions match "${query}"`
          : "no functions in this category",
      );
      listEl.appendChild(empty);
      return;
    }

    // Flat layout — 552 entries renders fine when most are collapsed.
    // The expanded view is one entry at a time (accordion).
    const frag = document.createDocumentFragment();
    for (const entry of ranked) {
      frag.appendChild(buildEntry(entry));
      flatVisible.push({ name: entry.name, source: entry.source });
    }
    listEl.appendChild(frag);
  }

  function buildEntry(entry) {
    const wrap = el("div", "reference-panel__entry");
    wrap.dataset.entryName = entry.name;
    wrap.setAttribute("role", "option");
    wrap.setAttribute("tabindex", "-1");
    if (entry.name === expandedName) wrap.classList.add("is-expanded");

    // Collapsed header — chevron + name. Always rendered.
    const head = el("button", "reference-panel__entry-head");
    head.type = "button";
    head.setAttribute(
      "aria-expanded",
      entry.name === expandedName ? "true" : "false",
    );
    const chev = el("span", "reference-panel__entry-chev");
    chev.appendChild(makeIcon("chevron-down"));
    head.appendChild(chev);

    const nameEl = el("span", "reference-panel__entry-name");
    appendHighlightedText(nameEl, entry.name, query);
    const textWrap = el("span", "reference-panel__entry-text");
    textWrap.appendChild(nameEl);
    const preview = buildPreview(entry);
    if (preview) {
      textWrap.appendChild(
        el("span", "reference-panel__entry-preview", preview),
      );
    }
    head.appendChild(textWrap);

    if (inUse.has(entry.name)) {
      const state = el("span", "reference-panel__entry-state", "used");
      state.title = "Appears in the current editor buffer";
      head.appendChild(state);
    }

    if (entry.source === "mini") {
      const tag = el("span", "reference-panel__entry-tag", "mini");
      head.appendChild(tag);
    }

    head.addEventListener("click", (e) => {
      e.preventDefault();
      toggleExpanded(entry.name);
    });

    wrap.appendChild(head);

    // Expanded body — only built when this entry is the open one.
    if (entry.name === expandedName) {
      wrap.appendChild(buildEntryBody(entry));
    }

    return wrap;
  }

  function buildEntryBody(entry) {
    const body = el("div", "reference-panel__entry-body");
    const overview = el("div", "reference-panel__entry-overview");

    // Signature
    const sig = el("div", "reference-panel__entry-sig", entry.signature);
    overview.appendChild(sig);

    // Description
    if (entry.doc) {
      const desc = el("div", "reference-panel__entry-doc", entry.doc);
      overview.appendChild(desc);
    }
    body.appendChild(overview);

    // Parameters
    if (entry.params && entry.params.length > 0) {
      const paramsSection = buildSection("Parameters");
      const params = el("div", "reference-panel__entry-params");
      for (const p of entry.params) {
        const row = el("div", "reference-panel__entry-param");
        const meta = el("div", "reference-panel__entry-param-head");
        const pname = el("span", "reference-panel__entry-param-name", p.name);
        meta.appendChild(pname);
        if (p.type) {
          const ptype = el("span", "reference-panel__entry-param-type", p.type);
          meta.appendChild(ptype);
        }
        row.appendChild(meta);
        if (p.doc) {
          const pdoc = el("div", "reference-panel__entry-param-doc", p.doc);
          row.appendChild(pdoc);
        }
        params.appendChild(row);
      }
      paramsSection.appendChild(params);
      body.appendChild(paramsSection);
    }

    // Examples
    if (entry.examples && entry.examples.length > 0) {
      const examplesSection = buildSection("Examples");
      const exSection = el("div", "reference-panel__entry-examples");
      for (const ex of entry.examples) {
        const pre = document.createElement("pre");
        pre.className = "reference-panel__entry-example";
        pre.textContent = ex;
        exSection.appendChild(pre);
      }
      examplesSection.appendChild(exSection);
      body.appendChild(examplesSection);
    }

    // Synonyms — clickable, jump to the alias's entry via scrollTo.
    if (entry.synonyms && entry.synonyms.length > 0) {
      const synSection = buildSection("Also named");
      const syn = el("div", "reference-panel__entry-synonyms");
      for (const synName of entry.synonyms) {
        const a = document.createElement("button");
        a.type = "button";
        a.className = "reference-panel__entry-synonym";
        a.textContent = synName;
        a.addEventListener("click", (e) => {
          e.stopPropagation();
          scrollTo(synName);
        });
        syn.appendChild(a);
      }
      synSection.appendChild(syn);
      body.appendChild(synSection);
    }

    // Action buttons.
    const actions = el("div", "reference-panel__entry-actions");

    // Try is meaningful for any entry that has a runnable example.
    if (entry.examples && entry.examples.length > 0) {
      const tryBtn = document.createElement("button");
      tryBtn.type = "button";
      tryBtn.className =
        "reference-panel__entry-btn reference-panel__entry-btn--primary";
      tryBtn.textContent = "▶ Try in editor";
      tryBtn.title = "Replace the editor buffer with this example and play it";
      tryBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        triggerTry(entry);
      });
      actions.appendChild(tryBtn);
    }

    // Insert is only meaningful for actual function entries — mini
    // operators aren't called like functions.
    if (entry.source === "strudel") {
      const insertBtn = document.createElement("button");
      insertBtn.type = "button";
      insertBtn.className = "reference-panel__entry-btn";
      insertBtn.textContent = "Insert";
      insertBtn.title = "Insert a call template at the cursor";
      insertBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        triggerInsert(entry);
      });
      actions.appendChild(insertBtn);
    }

    if (actions.childElementCount > 0) body.appendChild(actions);

    return body;
  }

  function appendHighlightedText(parent, text, q) {
    if (!q) {
      parent.textContent = text;
      return;
    }
    const lower = text.toLowerCase();
    const idx = lower.indexOf(q);
    if (idx < 0) {
      parent.textContent = text;
      return;
    }
    parent.appendChild(document.createTextNode(text.slice(0, idx)));
    const match = el(
      "span",
      "reference-panel__entry-match",
      text.slice(idx, idx + q.length),
    );
    parent.appendChild(match);
    parent.appendChild(document.createTextNode(text.slice(idx + q.length)));
  }

  function setCategory(nextCategory) {
    category = nextCategory;
    syncPills();
  }

  function syncPills() {
    if (!pillsEl) return;
    for (const p of pillsEl.querySelectorAll(".reference-panel__pill")) {
      const isMe = p.dataset.category === category;
      p.classList.toggle("is-active", isMe);
      p.setAttribute("aria-selected", isMe ? "true" : "false");
    }
  }

  function updateSummary(categoryDef, visibleCount, usedVisibleCount) {
    if (!summaryTitleEl || !summaryMetaEl) return;

    if (query) {
      summaryTitleEl.textContent = `Search results for "${query}"`;
      summaryMetaEl.textContent =
        `${visibleCount} match${visibleCount === 1 ? "" : "es"} ` +
        `in ${categoryDef.label.toLowerCase()}` +
        (usedVisibleCount ? ` · ${usedVisibleCount} used` : "");
      return;
    }

    summaryTitleEl.textContent = categoryDef.description;
    summaryMetaEl.textContent = usedVisibleCount
      ? `${usedVisibleCount} in current pattern`
      : `${visibleCount} ${categoryDef.label.toLowerCase()} entries`;
  }

  // ─── Expand / collapse ─────────────────────────────────────────────────

  function toggleExpanded(name) {
    if (expandedName === name) {
      expandedName = null;
    } else {
      expandedName = name;
    }
    render();
    activeIndex = flatVisible.findIndex((e) => e.name === name);
    paintActive();
  }

  // ─── Try / Insert actions ──────────────────────────────────────────────

  function triggerTry(entry) {
    // Pick the example to send to the editor: prefer the first listed
    // example. If there isn't one, synthesize a minimal pattern that
    // calls the function on top of `s("piano")`.
    let code = "";
    if (entry.examples && entry.examples.length > 0) {
      code = entry.examples[0];
    } else if (entry.source !== "strudel") {
      return;
    } else {
      code = `s("piano").${entry.name}()`;
    }

    // If the example doesn't already produce sound, wrap it. Cheap
    // string sniff: a runnable example references one of the source
    // primitives `s(`, `note(`, or `sound(` somewhere in its body.
    if (!/\b(?:s|note|sound)\s*\(/.test(code)) {
      code = `${code}.s("piano")`;
    }

    try {
      onTry(code);
    } catch (err) {
      console.warn("[reference-panel] try failed:", err);
    }
  }

  function triggerInsert(entry) {
    if (entry.source !== "strudel") return;
    // Intentionally simple heuristic per spec: insert `name()` at the
    // cursor regardless of chainable / standalone usage. The host
    // (main.js) places the cursor between the parens.
    const template = `${entry.name}()`;
    try {
      onInsert(entry.name, template);
    } catch (err) {
      console.warn("[reference-panel] insert failed:", err);
    }
  }

  // ─── Search + ranking ──────────────────────────────────────────────────

  function rankEntries(entries, q) {
    // Four-tier rank: exact name > prefix on name > substring in name >
    // substring in description / synonym / alias. Within a tier,
    // ties are broken alphabetically by name so the ordering is stable
    // across identical-rank matches.
    const ql = q.toLowerCase();
    const ranked = [];
    for (const e of entries) {
      const nameL = e.name.toLowerCase();
      const docL = (e.doc ?? "").toLowerCase();
      let rank = -1;
      if (nameL === ql) rank = 0;
      else if (nameL.startsWith(ql)) rank = 1;
      else if (nameL.includes(ql)) rank = 2;
      else if (e.synonyms.some((s) => s.toLowerCase().includes(ql))) rank = 2;
      else if (e.aliases && e.aliases.some((a) => a.toLowerCase().includes(ql)))
        rank = 2;
      else if (docL.includes(ql)) rank = 3;
      if (rank >= 0) ranked.push({ entry: e, rank });
    }
    ranked.sort((a, b) => {
      if (a.rank !== b.rank) return a.rank - b.rank;
      return a.entry.name.localeCompare(b.entry.name);
    });
    return ranked.map((r) => r.entry);
  }

  function sortAlpha(entries) {
    // Mini operators sink below the strudel functions in any view that
    // mixes both — their single-character names sort before everything
    // else otherwise, which feels noisy.
    return [...entries].sort((a, b) => {
      const am = a.source === "mini" ? 1 : 0;
      const bm = b.source === "mini" ? 1 : 0;
      if (am !== bm) return am - bm;
      return a.name.localeCompare(b.name);
    });
  }

  // ─── Keyboard navigation ───────────────────────────────────────────────

  function paintActive() {
    if (!listEl) return;
    for (const item of listEl.querySelectorAll(".reference-panel__entry")) {
      item.classList.remove("is-active");
    }
    if (activeIndex < 0 || activeIndex >= flatVisible.length) return;
    const name = flatVisible[activeIndex].name;
    const target = listEl.querySelector(
      `.reference-panel__entry[data-entry-name="${cssEscape(name)}"]`,
    );
    if (target) {
      target.classList.add("is-active");
      target.scrollIntoView({ block: "nearest" });
      target.focus({ preventScroll: true });
    }
  }

  function moveActive(delta) {
    if (flatVisible.length === 0) return;
    if (activeIndex < 0) {
      activeIndex = delta > 0 ? 0 : flatVisible.length - 1;
    } else {
      activeIndex =
        (activeIndex + delta + flatVisible.length) % flatVisible.length;
    }
    paintActive();
  }

  // ─── Event handlers ────────────────────────────────────────────────────

  function onSearchInput() {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      query = searchInput.value.trim().toLowerCase();
      render();
    }, SEARCH_DEBOUNCE_MS);
  }

  function onSearchKeydown(e) {
    if (e.key === "Escape") {
      if (searchInput.value) {
        e.preventDefault();
        searchInput.value = "";
        query = "";
        render();
        return;
      }
      e.preventDefault();
      onFocusEditor();
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      // Flush the debounce so render() has the freshest filter, then
      // jump into the list.
      clearTimeout(searchTimer);
      query = searchInput.value.trim().toLowerCase();
      render();
      moveActive(+1);
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      clearTimeout(searchTimer);
      query = searchInput.value.trim().toLowerCase();
      render();
      if (flatVisible.length === 0) return;
      // Expand the top match.
      expandedName = flatVisible[0].name;
      activeIndex = 0;
      render();
      paintActive();
    }
  }

  function onListKeydown(e) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      moveActive(+1);
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      if (activeIndex === 0) {
        // Wrap back into the search field at the top.
        activeIndex = -1;
        paintActive();
        searchInput.focus();
        searchInput.select();
        return;
      }
      moveActive(-1);
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      onFocusEditor();
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      if (activeIndex < 0) return;
      const entryName = flatVisible[activeIndex].name;
      const entry = entryByName.get(entryName);
      if (!entry) return;
      if (entryName !== expandedName) {
        // Collapsed → expand it.
        toggleExpanded(entryName);
      } else {
        // Already expanded → trigger Try.
        triggerTry(entry);
      }
    }
  }
}

// ─── Pure helpers (no closure state) ──────────────────────────────────────

/**
 * Lightweight string scan: which entry names appear in the editor
 * buffer? Anchored on word boundaries so `s` doesn't match every
 * alphabetic character. Mini operators are skipped — their single-char
 * names would trigger countless false positives. Cheap for ~552 entries
 * × ~2KB buffer.
 */
function scanInUse(text, entries) {
  const out = new Set();
  if (!text) return out;
  for (const e of entries) {
    if (e.source === "mini") continue;
    const name = e.name;
    let from = 0;
    while (from <= text.length) {
      const i = text.indexOf(name, from);
      if (i < 0) break;
      const before = i === 0 ? "" : text[i - 1];
      const after = text[i + name.length] ?? "";
      if (!isWordChar(before) && !isWordChar(after)) {
        out.add(name);
        break;
      }
      from = i + 1;
    }
  }
  return out;
}

function isWordChar(c) {
  return /[a-z0-9_$]/i.test(c);
}

function cssEscape(s) {
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") {
    return CSS.escape(s);
  }
  return s.replace(/[^a-z0-9_-]/gi, "\\$&");
}

function getCategory(id) {
  return (
    CATEGORIES.find((c) => c.id === id) ?? CATEGORIES[CATEGORIES.length - 1]
  );
}

function buildPreview(entry) {
  const source = entry.doc || entry.signature;
  if (!source) return "";
  const compact = source.replace(/\s+/g, " ").trim();
  if (compact.length <= 64) return compact;
  return compact.slice(0, 61).trimEnd() + "...";
}

function buildSection(label) {
  const section = el("div", "reference-panel__section");
  section.appendChild(el("div", "reference-panel__section-label", label));
  return section;
}

function el(tag, className, text) {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text != null) e.textContent = text;
  return e;
}
