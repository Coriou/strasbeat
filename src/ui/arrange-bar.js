// Arrangement timeline strip — renders the song-form for every `arrange(...)`
// call that actually ran during the last evaluate. Each arrangement becomes
// one row of proportional segments (flex basis = cycles); the scheduler's
// cycle drives a per-row playhead; clicking a segment jumps the editor
// cursor to the source tuple.
//
// Data flow:
//   src/strudel-ext/arrange.js  →  registry (runtime metadata)
//           ↑                             │  subscribeRegistry
//     primeArrangementParser               ▼
//   (from eval-feedback.js,      mountArrangeBar() re-renders
//    called pre-evaluate)        + drives the per-row rAF playhead
//
// Before the first evaluate (or after one with no `arrange`), the strip
// falls back to the static parser output so it still previews what's in
// the buffer — but dimmed and badged "not yet played" so we never lie
// about what's audible.
//
// See design/work/18-arrangement-timeline.md for the full spec.

import { StateEffect } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import {
  parseArrangements,
  findTrailingDurationTransform,
  locatePlayhead,
} from "../editor/arrange-parse.js";
import { parseLabels } from "../editor/track-labels.js";
import {
  subscribeRegistry,
  setSolo,
  getSoloKey,
  getLastAppliedCode,
} from "../strudel-ext/arrange.js";
import { makeIcon } from "./icons.js";

/**
 * @param {object} opts
 * @param {HTMLElement} opts.container    outer element (gets `hidden` when empty)
 * @param {import("@codemirror/view").EditorView} opts.view  CodeMirror view
 * @param {() => any} opts.getScheduler   returns editor.repl.scheduler (or null)
 * @param {() => Promise<any>} opts.onEvaluate  trigger a re-evaluate (used after solo toggle)
 */
export function mountArrangeBar({
  container,
  view,
  getScheduler,
  onEvaluate,
}) {
  // ─── Per-render state ────────────────────────────────────────────────
  // `rows` holds one record per rendered arrangement; the rAF tick walks
  // all of them to update playheads/labels. Cache keys avoid DOM writes
  // when nothing meaningfully changed.
  let rows = [];
  let raf = null;
  let lastRegistry = [];

  function rebuild() {
    const code = view.state.doc.toString();
    const registryEntries = lastRegistry;
    const parsedArrangements = parseArrangements(code);

    // Decide data source. The registry is only authoritative when it was
    // populated from the *current* buffer — any edit since the last
    // evaluate drops us back into parser preview so we never lie about
    // which sections are audible. Pre-first-play is also parser preview.
    const lastAppliedCode = getLastAppliedCode();
    const registryMatchesBuffer =
      lastAppliedCode !== null && lastAppliedCode === code;
    const usingParser =
      registryEntries.length === 0 || !registryMatchesBuffer;
    const sourceEntries = usingParser
      ? parsedArrangements.map((p) => fromParsed(p))
      : registryEntries;
    const previewReason =
      !usingParser
        ? null
        : registryEntries.length === 0
          ? "not yet played"
          : "edited since last play";

    // Cross-reference track-labels to know which arranges live inside a
    // muted track. Strudel drops muted tracks before eval, so the
    // *registry* already omits them — but in parser-preview mode (before
    // first play) we still want to dim the row so the user isn't
    // surprised.
    const trackLabels = parseLabels(code);

    while (container.firstChild) container.removeChild(container.firstChild);
    rows = [];

    if (sourceEntries.length === 0) {
      container.hidden = true;
      stopRaf();
      return;
    }

    container.hidden = false;

    // When there's more than one arrangement we annotate each with its
    // source line — otherwise the bare "Arrangement" title reads cleaner.
    const showLineNumbers = sourceEntries.length > 1;

    for (let i = 0; i < sourceEntries.length; i++) {
      const entry = sourceEntries[i];
      if (!entry.sections || entry.sections.length === 0) continue;
      const row = buildRow({
        entry,
        arrangeIndex: i,
        usingParser,
        previewReason,
        showLineNumber: showLineNumbers,
        trailingTransform: resolveTrailingTransform(code, entry, parsedArrangements, i),
        mutedByTrack: isInsideMutedTrack(entry, trackLabels, code, parsedArrangements, i),
      });
      rows.push(row);
      container.appendChild(row.el);
    }

    if (rows.length === 0) {
      container.hidden = true;
      stopRaf();
      return;
    }

    // Dense mode kicks in past 4 arrangements — the cap on max-height
    // forces scrolling anyway, but in dense mode each row is slimmer so
    // more of them are visible before the user has to scroll.
    container.dataset.density = rows.length > 4 ? "dense" : "normal";

    startRaf();
  }

  function buildRow({ entry, arrangeIndex, usingParser, previewReason, showLineNumber, trailingTransform, mutedByTrack }) {
    const rowEl = document.createElement("div");
    rowEl.className = "arrange-bar__row";
    if (usingParser) rowEl.classList.add("arrange-bar__row--preview");
    if (mutedByTrack) rowEl.classList.add("arrange-bar__row--muted");

    const meta = document.createElement("div");
    meta.className = "arrange-bar__meta";

    const title = document.createElement("span");
    title.className = "arrange-bar__title";
    title.textContent =
      showLineNumber && entry.sourceLine
        ? `Arrangement · line ${entry.sourceLine}`
        : "Arrangement";

    // Current-section slot stays empty until the playhead locates a section;
    // the :empty CSS rule hides the span so the meta row collapses cleanly.
    const current = document.createElement("span");
    current.className = "arrange-bar__current";

    const badges = document.createElement("span");
    badges.className = "arrange-bar__badges";
    if (usingParser && previewReason) {
      badges.appendChild(makeBadge("parsed", previewReason));
    }
    if (mutedByTrack) {
      badges.appendChild(makeBadge("muted", "muted track"));
    }
    if (trailingTransform) {
      const arg = trailingTransform.argText || "";
      badges.appendChild(
        makeBadge(
          "transform",
          `.${trailingTransform.method}(${arg}) changes duration`,
        ),
      );
    }

    const total = document.createElement("span");
    total.className = "arrange-bar__total";
    const cyc = entry.totalCycles;
    const count = entry.sections.length;
    total.textContent = `${formatCycles(cyc)} cycle${cyc === 1 ? "" : "s"} · ${count} section${count === 1 ? "" : "s"}`;

    meta.append(title, current, badges, total);
    rowEl.appendChild(meta);

    const strip = document.createElement("div");
    strip.className = "arrange-bar__strip";
    strip.setAttribute("role", "list");

    const sectionsHost = document.createElement("div");
    sectionsHost.className = "arrange-bar__sections";
    strip.appendChild(sectionsHost);

    const segmentEls = [];
    const soloKey = getSoloKey();
    const hasSolo = !!soloKey && soloKey.arrangeIndex === arrangeIndex;

    for (let i = 0; i < entry.sections.length; i++) {
      const section = entry.sections[i];
      const isSoloed = hasSolo && soloKey.sectionIndex === i;
      const isDimmedBySolo = hasSolo && !isSoloed;

      const segEl = buildSegment({
        section,
        sectionIndex: i,
        arrangeIndex,
        isSoloed,
        isDimmedBySolo,
        interactive: !usingParser && !mutedByTrack,
      });
      sectionsHost.appendChild(segEl);
      segmentEls.push(segEl);
    }

    const progress = document.createElement("div");
    progress.className = "arrange-bar__progress";
    progress.setAttribute("aria-hidden", "true");
    strip.appendChild(progress);

    const dot = document.createElement("div");
    dot.className = "arrange-bar__dot";
    dot.setAttribute("aria-hidden", "true");
    strip.appendChild(dot);

    rowEl.appendChild(strip);

    return {
      el: rowEl,
      entry,
      arrangeIndex,
      segmentEls,
      progressEl: progress,
      dotEl: dot,
      currentEl: current,
      usingParser,
      mutedByTrack,
      lastIndex: -1,
      lastPctKey: -1,
      lastCurrentLabel: null,
    };
  }

  function buildSegment({
    section,
    sectionIndex,
    arrangeIndex,
    isSoloed,
    isDimmedBySolo,
    interactive,
  }) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "arrange-bar__section";
    btn.style.flex = String(Math.max(section.cycles, 0.0001));
    btn.setAttribute("role", "listitem");
    btn.dataset.arrangeIndex = String(arrangeIndex);
    btn.dataset.sectionIndex = String(sectionIndex);
    if (isSoloed) btn.classList.add("is-soloed");
    if (isDimmedBySolo) btn.classList.add("is-dimmed");
    if (!interactive) btn.classList.add("is-inert");

    const labelText = section.label || `Section ${sectionIndex + 1}`;
    const cycleText = `${formatCycles(section.cycles)} cycle${section.cycles === 1 ? "" : "s"}`;
    btn.title = `${labelText} · ${cycleText} · click to jump to source`;
    btn.setAttribute(
      "aria-label",
      `${labelText}, ${cycleText}. Click to jump to the source tuple.`,
    );

    const label = document.createElement("span");
    label.className = "arrange-bar__label";
    label.textContent = labelText;
    btn.appendChild(label);

    // Primary click: jump to source. Solo / un-solo have their own
    // dedicated controls so the segment-wide click stays predictable.
    btn.addEventListener("click", (e) => {
      if (e.target.closest(".arrange-bar__solo-btn, .arrange-bar__solo-pill")) return;
      if (typeof section.sourceStart === "number") {
        try {
          view.dispatch({
            selection: { anchor: section.sourceStart },
            scrollIntoView: true,
          });
          view.focus?.();
        } catch (err) {
          console.warn("[strasbeat/arrange-bar] jump failed:", err);
        }
      }
    });

    // Right-hand slot: cycle count by default, SOLO pill when soloed.
    // The pill is clickable and un-solos; no hover required — because
    // un-solo is a frequent action during iteration.
    if (isSoloed) {
      const pill = document.createElement("button");
      pill.type = "button";
      pill.className = "arrange-bar__solo-pill";
      pill.textContent = "SOLO";
      pill.title = `Clear solo on ${labelText}`;
      pill.setAttribute("aria-label", `Clear solo on ${labelText}`);
      pill.addEventListener("click", (e) => {
        e.stopPropagation();
        handleSoloClick(arrangeIndex, sectionIndex);
      });
      btn.appendChild(pill);
    } else {
      const cycles = document.createElement("span");
      cycles.className = "arrange-bar__cycles";
      cycles.textContent = formatCycles(section.cycles);
      btn.appendChild(cycles);
    }

    // Hover-revealed solo action (only when not already soloed).
    // Rendered unconditionally so keyboard users can tab to it;
    // CSS hides it until hover or focus-within.
    if (interactive && !isSoloed) {
      const soloBtn = document.createElement("button");
      soloBtn.type = "button";
      soloBtn.className = "arrange-bar__solo-btn";
      soloBtn.setAttribute(
        "aria-label",
        `Solo ${labelText} — loop just this section`,
      );
      soloBtn.title = "Solo (loop this section)";
      soloBtn.appendChild(makeIcon("headphones", { size: 12 }));
      soloBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        handleSoloClick(arrangeIndex, sectionIndex);
      });
      btn.appendChild(soloBtn);
    }

    return btn;
  }

  function handleSoloClick(arrangeIndex, sectionIndex) {
    setSolo(arrangeIndex, sectionIndex);
    // The wrapper's solo branch only takes effect on the next evaluate.
    // Triggering that here keeps the feedback instant: the user clicks,
    // the pattern re-evaluates, the scheduler swaps to the soloed
    // section within a few ms. Scheduler keeps playing — no stop/start.
    try {
      const p = onEvaluate?.();
      if (p && typeof p.catch === "function") {
        p.catch((err) =>
          console.warn("[strasbeat/arrange-bar] solo evaluate failed:", err),
        );
      }
    } catch (err) {
      console.warn("[strasbeat/arrange-bar] solo evaluate threw:", err);
    }
  }

  function tick() {
    if (rows.length === 0) {
      raf = null;
      return;
    }
    const sched = getScheduler();
    const started = !!sched?.started;
    const cycle = started && typeof sched.now === "function" ? sched.now() : 0;

    for (const row of rows) {
      if (row.usingParser || row.mutedByTrack) {
        resetRowPlayhead(row);
        continue;
      }
      const located = started
        ? locatePlayhead(
            { totalCycles: row.entry.totalCycles, sections: row.entry.sections },
            cycle,
          )
        : null;

      if (located) {
        const pctKey = Math.round(located.totalProgress * 1000);
        if (pctKey !== row.lastPctKey) {
          row.lastPctKey = pctKey;
          const pct = pctKey / 10;
          row.progressEl.style.width = `${pct}%`;
          row.dotEl.style.left = `${pct}%`;
        }
        if (located.index !== row.lastIndex) {
          if (row.lastIndex >= 0 && row.segmentEls[row.lastIndex]) {
            row.segmentEls[row.lastIndex].classList.remove("is-active");
          }
          row.segmentEls[located.index]?.classList.add("is-active");
          row.lastIndex = located.index;
        }
        const section = row.entry.sections[located.index];
        const label = section.label || `Section ${located.index + 1}`;
        if (label !== row.lastCurrentLabel) {
          row.lastCurrentLabel = label;
          row.currentEl.textContent = label;
        }
      } else {
        resetRowPlayhead(row);
      }
    }

    raf = requestAnimationFrame(tick);
  }

  function resetRowPlayhead(row) {
    if (row.lastPctKey !== 0) {
      row.lastPctKey = 0;
      row.progressEl.style.width = "0%";
      row.dotEl.style.left = "0%";
    }
    if (row.lastIndex !== -1) {
      if (row.segmentEls[row.lastIndex]) {
        row.segmentEls[row.lastIndex].classList.remove("is-active");
      }
      row.lastIndex = -1;
    }
    if (row.lastCurrentLabel !== null) {
      row.lastCurrentLabel = null;
      row.currentEl.textContent = "";
    }
  }

  function startRaf() {
    if (raf == null) raf = requestAnimationFrame(tick);
  }

  function stopRaf() {
    if (raf != null) cancelAnimationFrame(raf);
    raf = null;
  }

  // ─── Wiring ──────────────────────────────────────────────────────────

  let rebuildScheduled = false;
  function scheduleRebuild() {
    if (rebuildScheduled) return;
    rebuildScheduled = true;
    requestAnimationFrame(() => {
      rebuildScheduled = false;
      rebuild();
    });
  }

  // Registry updates — the authoritative signal. Fires immediately with
  // the current snapshot, then after every evaluate and every solo toggle.
  // validateSolo() is owned by eval-feedback.js (via endEvaluate) so it
  // can't clear a valid solo during the transient empty-registry state
  // mid-eval.
  subscribeRegistry(({ registry }) => {
    lastRegistry = registry;
    scheduleRebuild();
  });

  // Editor edits — keep the parser-preview fresh even before first play.
  view.dispatch({
    effects: StateEffect.appendConfig.of(
      EditorView.updateListener.of((update) => {
        if (update.docChanged) scheduleRebuild();
      }),
    ),
  });

  // Initial render (subscribeRegistry already called fn once above; this
  // is belt-and-braces for the pre-subscribe synchronous path).
  rebuild();
}

// ─── Helpers ──────────────────────────────────────────────────────────

function fromParsed(parsed) {
  // Wrap the parser output in the same shape as a registry entry so the
  // rendering code stays uniform.
  return {
    arrangeIndex: null,
    sections: parsed.sections.map((s, i) => ({
      cycles: s.cycles,
      label: s.label || `Section ${i + 1}`,
      sourceStart: s.start,
      sourceEnd: s.end,
      sourceLine: s.line,
      rawExpr: s.rawExpr,
    })),
    totalCycles: parsed.totalCycles,
    sourceLine: parsed.line,
    callStart: parsed.callStart,
    openParen: parsed.openParen,
    closeParen: parsed.closeParen,
  };
}

function resolveTrailingTransform(code, entry, parsedArrangements, arrangeIndex) {
  // Registry entries don't keep closeParen offsets that line up with the
  // current buffer after edits — so we look up the matching parsed entry
  // by source order (same assumption the label queue makes).
  const parsed =
    entry.closeParen != null && entry.openParen != null
      ? entry
      : parsedArrangements[arrangeIndex];
  if (!parsed || parsed.closeParen == null) return null;
  const found = findTrailingDurationTransform(code, parsed);
  if (!found) return null;
  const argText = code.slice(found.argStart, found.argEnd).trim().slice(0, 12);
  return { method: found.method, argText };
}

function isInsideMutedTrack(entry, trackLabels, code, parsedArrangements, arrangeIndex) {
  // Need the source offsets to do the inside-of-block check.
  const parsed =
    entry.callStart != null
      ? entry
      : parsedArrangements[arrangeIndex];
  if (!parsed || parsed.callStart == null) return false;
  for (const label of trackLabels) {
    if (!label.muted) continue;
    if (parsed.callStart >= label.blockStart && parsed.callStart < label.blockEnd) {
      return true;
    }
  }
  return false;
}

function makeBadge(kind, text) {
  const el = document.createElement("span");
  el.className = `arrange-bar__badge arrange-bar__badge--${kind}`;
  el.textContent = text;
  return el;
}

function formatCycles(n) {
  if (!Number.isFinite(n)) return "?";
  if (Number.isInteger(n)) return String(n);
  return n.toFixed(2).replace(/\.?0+$/, "");
}
