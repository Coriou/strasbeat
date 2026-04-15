// Arrangement timeline strip — appears between the transport and the track
// bar when the pattern contains an `arrange(...)` call. Renders sections as
// proportional segments (flex basis = cycles), tracks the scheduler's
// cycle-wise playhead across the whole song, and jumps the editor cursor
// to the source tuple when you click a section.
//
// Mirrors src/ui/track-bar.js: parse on docChange, hide when empty.

import { StateEffect } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { parseArrangements, locatePlayhead } from "../editor/arrange-parse.js";

/**
 * @param {object} opts
 * @param {HTMLElement} opts.container  outer element (gets `hidden` when empty)
 * @param {import("@codemirror/view").EditorView} opts.view  the CodeMirror view
 * @param {() => any} opts.getScheduler  returns editor.repl.scheduler (or null)
 */
export function mountArrangeBar({ container, view, getScheduler }) {
  let arrangement = null;
  let segmentEls = [];
  let progressEl = null;
  let dotEl = null;
  let currentEl = null;
  let raf = null;
  let lastIndex = -1;
  let lastPctKey = -1;
  let lastCurrentLabel = "";

  function rebuild() {
    const code = view.state.doc.toString();
    const arrangements = parseArrangements(code);
    const first = arrangements.find((a) => a.sections.length > 0) || null;

    arrangement = first;
    while (container.firstChild) container.removeChild(container.firstChild);
    segmentEls = [];
    progressEl = null;
    dotEl = null;
    currentEl = null;
    lastIndex = -1;
    lastPctKey = -1;
    lastCurrentLabel = "";

    if (!arrangement) {
      container.hidden = true;
      stopRaf();
      return;
    }

    container.hidden = false;

    const meta = document.createElement("div");
    meta.className = "arrange-bar__meta";

    const title = document.createElement("span");
    title.className = "arrange-bar__title";
    title.textContent = "Arrangement";

    const current = document.createElement("span");
    current.className = "arrange-bar__current";
    current.textContent = "—";
    currentEl = current;

    const total = document.createElement("span");
    total.className = "arrange-bar__total";
    const cyc = arrangement.totalCycles;
    const count = arrangement.sections.length;
    total.textContent = `${formatCycles(cyc)} cycle${cyc === 1 ? "" : "s"} · ${count} section${count === 1 ? "" : "s"}`;

    meta.append(title, current, total);
    container.appendChild(meta);

    const strip = document.createElement("div");
    strip.className = "arrange-bar__strip";
    strip.setAttribute("role", "list");

    const sections = document.createElement("div");
    sections.className = "arrange-bar__sections";
    strip.appendChild(sections);

    for (let i = 0; i < arrangement.sections.length; i++) {
      const section = arrangement.sections[i];
      const labelText = section.label || `Section ${i + 1}`;
      const cycleText = `${formatCycles(section.cycles)} cycle${section.cycles === 1 ? "" : "s"}`;

      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "arrange-bar__section";
      btn.style.flex = String(section.cycles);
      btn.setAttribute("role", "listitem");
      btn.title = `${labelText} · ${cycleText} · click to jump to source`;
      btn.setAttribute(
        "aria-label",
        `${labelText}, ${cycleText}. Click to jump to the source tuple.`,
      );

      const label = document.createElement("span");
      label.className = "arrange-bar__label";
      label.textContent = labelText;

      const cycles = document.createElement("span");
      cycles.className = "arrange-bar__cycles";
      cycles.textContent = formatCycles(section.cycles);

      btn.append(label, cycles);

      btn.addEventListener("click", () => {
        try {
          view.dispatch({
            selection: { anchor: section.start },
            scrollIntoView: true,
          });
          view.focus?.();
        } catch (err) {
          console.warn("[strasbeat/arrange-bar] jump failed:", err);
        }
      });

      sections.appendChild(btn);
      segmentEls.push(btn);
    }

    const progress = document.createElement("div");
    progress.className = "arrange-bar__progress";
    progress.setAttribute("aria-hidden", "true");
    strip.appendChild(progress);
    progressEl = progress;

    const dot = document.createElement("div");
    dot.className = "arrange-bar__dot";
    dot.setAttribute("aria-hidden", "true");
    strip.appendChild(dot);
    dotEl = dot;

    container.appendChild(strip);

    startRaf();
  }

  function tick() {
    if (!arrangement) {
      raf = null;
      return;
    }
    const sched = getScheduler();
    const started = !!sched?.started;
    const cycle = started && typeof sched.now === "function" ? sched.now() : 0;
    const located = started ? locatePlayhead(arrangement, cycle) : null;

    if (located) {
      const pctKey = Math.round(located.totalProgress * 1000);
      if (pctKey !== lastPctKey) {
        lastPctKey = pctKey;
        const pct = pctKey / 10;
        if (progressEl) progressEl.style.width = `${pct}%`;
        if (dotEl) dotEl.style.left = `${pct}%`;
      }
      if (located.index !== lastIndex) {
        if (lastIndex >= 0 && segmentEls[lastIndex]) {
          segmentEls[lastIndex].classList.remove("is-active");
        }
        segmentEls[located.index]?.classList.add("is-active");
        lastIndex = located.index;
      }
      const section = arrangement.sections[located.index];
      const label = section.label || `Section ${located.index + 1}`;
      if (label !== lastCurrentLabel && currentEl) {
        lastCurrentLabel = label;
        currentEl.textContent = label;
      }
    } else {
      if (lastPctKey !== 0) {
        lastPctKey = 0;
        if (progressEl) progressEl.style.width = "0%";
        if (dotEl) dotEl.style.left = "0%";
      }
      if (lastIndex !== -1) {
        if (segmentEls[lastIndex]) segmentEls[lastIndex].classList.remove("is-active");
        lastIndex = -1;
      }
      if (lastCurrentLabel !== "—" && currentEl) {
        lastCurrentLabel = "—";
        currentEl.textContent = "—";
      }
    }

    raf = requestAnimationFrame(tick);
  }

  function startRaf() {
    if (raf == null) raf = requestAnimationFrame(tick);
  }

  function stopRaf() {
    if (raf != null) cancelAnimationFrame(raf);
    raf = null;
  }

  rebuild();

  let rebuildScheduled = false;
  function scheduleRebuild() {
    if (rebuildScheduled) return;
    rebuildScheduled = true;
    requestAnimationFrame(() => {
      rebuildScheduled = false;
      rebuild();
    });
  }

  view.dispatch({
    effects: StateEffect.appendConfig.of(
      EditorView.updateListener.of((update) => {
        if (update.docChanged) scheduleRebuild();
      }),
    ),
  });
}

function formatCycles(n) {
  if (Number.isInteger(n)) return String(n);
  return n.toFixed(2).replace(/\.?0+$/, "");
}
