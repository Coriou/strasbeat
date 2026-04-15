// Shadow wrapper for Strudel's core arrange(). Behaviourally identical to
// upstream (delegates to @strudel/core's arrange via a named import), plus:
//
//  1. Registers per-call metadata (cycle counts, labels merged from the
//     static parser) into a module-local registry so the arrange-bar UI
//     can render an accurate song-form strip based on what actually ran.
//  2. Optional "solo" state: when the UI asks to isolate section N of
//     arrange M, the wrapper returns an arrangement of just that section,
//     looped at its original cadence. Solo persists across evaluates so
//     WAV export naturally renders the soloed section (that's the user's
//     committed choice, not a detour).
//
// This module is re-exported from src/strudel-ext/index.js, which
// boot.js passes as the LAST namespace to evalScope(). Later namespaces
// overwrite earlier ones, so our arrange shadows @strudel/core's export
// for every pattern evaluation — no upstream patch needed.
//
// See design/work/18-arrangement-timeline.md for the full spec.

import * as strudelCore from "@strudel/core";

// ─── Parsed labels queue ────────────────────────────────────────────────
// Primed by eval-feedback.js's patchedEvaluate before each evaluate, drained
// FIFO by wrapper calls during that evaluate. We can't reliably map a
// runtime arrange() invocation back to a source line (the transpiler wraps
// pattern code in an async IIFE that rewrites locations), so instead we
// rely on source-order matching the JS evaluation order for the common
// case (top-level sibling arranges). Mismatches fall back to numbered
// labels + a console.warn.
let parsedQueue = [];

/**
 * Called by eval-feedback.js right before editor.evaluate fires. Stashes
 * the parser's output so the wrapper can recover human-readable labels.
 * @param {Array} parsedList  output of parseArrangements(editor.code)
 */
export function primeArrangementParser(parsedList) {
  parsedQueue = Array.isArray(parsedList) ? parsedList.slice() : [];
}

// ─── Live registry ──────────────────────────────────────────────────────
// One entry per arrange() call that actually executed during the last
// evaluate. Rebuilt from scratch on every evaluate (see resetRegistry).
// UI components subscribe via subscribeRegistry() and get the current
// snapshot immediately + every future change.

let registry = [];
let currentEvalOrdinal = 0;
// True between beginEvaluate() and endEvaluate(). While true, the UI may
// see an empty or partially-filled registry; validateSolo() must refuse
// to clear stale solo keys based on that transient state.
let evalInProgress = false;
// Snapshot of editor.code at the start of the last completed evaluate.
// The UI compares this to the current buffer to decide whether the
// registry still describes what's on screen. `null` means "no eval has
// populated the registry yet" — the UI should then render from the
// static parser instead.
let lastAppliedCode = null;
const subscribers = new Set();

function emit() {
  for (const fn of subscribers) {
    try {
      fn({ registry, soloKey });
    } catch (err) {
      console.warn("[strasbeat/arrange] subscriber failed:", err);
    }
  }
}

/**
 * Subscribe to registry/solo-state changes. Fires immediately with the
 * current snapshot, then on every subsequent emit(). Returns an unsubscribe.
 */
export function subscribeRegistry(fn) {
  subscribers.add(fn);
  try {
    fn({ registry, soloKey });
  } catch (err) {
    console.warn("[strasbeat/arrange] initial subscriber call failed:", err);
  }
  return () => subscribers.delete(fn);
}

export function getRegistry() {
  return registry;
}

/**
 * Reset the registry at the start of each evaluate. Solo state is
 * intentionally NOT reset — it persists across evaluates so the user can
 * iterate on a soloed section without re-toggling after each Cmd+Enter,
 * and so WAV export respects the soloed selection.
 */
export function resetRegistry() {
  registry = [];
  currentEvalOrdinal = 0;
  emit();
}

/** Called by eval-feedback before _editorEvaluate fires. */
export function beginEvaluate() {
  evalInProgress = true;
}

/**
 * Called by eval-feedback once the evaluate resolves successfully.
 * Snapshots the buffer text that produced the current registry so the
 * UI can detect post-eval edits and downgrade to a parser preview.
 */
export function markEvalAppliedFor(code) {
  lastAppliedCode = typeof code === "string" ? code : null;
  emit();
}

export function getLastAppliedCode() {
  return lastAppliedCode;
}

/**
 * Called by eval-feedback after _editorEvaluate resolves (or throws).
 * This is the only safe point to reconcile solo state against the
 * fresh registry — during eval, the registry can briefly be empty or
 * mid-build and would misleadingly fail the validity check.
 */
export function endEvaluate() {
  evalInProgress = false;
  validateSolo();
}

export function isEvalInProgress() {
  return evalInProgress;
}

// ─── Solo state ─────────────────────────────────────────────────────────
// Keyed by `arrangeIndex` (the wrapper's ordinal during the eval pass,
// which is also the index into the registry) and `sectionIndex` (0-based
// within that arrangement). Stable across evaluates as long as the
// arrange call order doesn't change.

let soloKey = null;

export function getSoloKey() {
  return soloKey;
}

/**
 * Toggle the solo for a given arrange/section coordinate. If the same
 * coordinate is already soloed, clears the solo. Any other coordinate
 * replaces the current solo.
 *
 * Callers are expected to trigger a re-evaluate after this (so the
 * wrapper fires again and substitutes the soloed pattern into the
 * scheduler). The UI does `setSolo(...); editor.evaluate();`.
 */
export function setSolo(arrangeIndex, sectionIndex) {
  if (
    soloKey &&
    soloKey.arrangeIndex === arrangeIndex &&
    soloKey.sectionIndex === sectionIndex
  ) {
    soloKey = null;
  } else {
    soloKey = { arrangeIndex, sectionIndex };
  }
  emit();
  return soloKey;
}

export function clearSolo() {
  if (soloKey == null) return;
  soloKey = null;
  emit();
}

/**
 * Check whether the current solo coordinate still points at a valid
 * section in the latest registry. If the user edited the arrange out
 * of existence (or removed the section), the solo is silently cleared
 * and the UI goes back to normal.
 *
 * Only runs when NOT mid-eval — during an evaluate the registry can be
 * transiently empty (reset at start, populates as wrappers fire), and a
 * naive check would clear solo mid-flight. eval-feedback calls this via
 * endEvaluate() at the right moment.
 */
export function validateSolo() {
  if (evalInProgress) return;
  if (soloKey == null) return;
  const entry = registry[soloKey.arrangeIndex];
  if (!entry || soloKey.sectionIndex >= entry.sections.length) {
    soloKey = null;
    emit();
  }
}

// ─── The wrapper ────────────────────────────────────────────────────────

/**
 * Allows to arrange multiple patterns together over multiple cycles.
 * Takes a variable number of arrays with two elements specifying the
 * number of cycles and the pattern to use. strasbeat instruments this
 * call so the arrangement timeline strip can show section names and a
 * playhead — audible output is identical to upstream Strudel's arrange.
 *
 * @param {...Array} sections  `[cycles, pattern]` tuples
 * @returns {Pattern}
 * @example
 * arrange(
 *   [4, "<c a f e>(3,8)"],
 *   [2, "<g a>(5,8)"]
 * ).note()
 */
export function arrange(...sections) {
  if (!sections.length) {
    return strudelCore.silence;
  }

  const arrangeIndex = currentEvalOrdinal++;

  // Extract cycle counts for the registry. Malformed tuples (non-numeric
  // cycles, missing pattern) still get recorded so the UI doesn't silently
  // drop them — core arrange() will throw on them in a moment, which the
  // eval pipeline surfaces as an error mark. We want the registry to
  // reflect intent, not audible truth.
  const runtimeCycles = sections.map((s) => {
    const c = Array.isArray(s) ? s[0] : NaN;
    return Number.isFinite(c) && c > 0 ? c : 0;
  });
  const totalCycles = runtimeCycles.reduce((a, b) => a + b, 0);

  // Pull the next parsed arrangement (by source order) and merge labels
  // when the section counts agree. A mismatch here means either (a) the
  // pattern author is using a dynamic section list (`...buildSections()`)
  // or (b) this is a nested arrange whose parent already consumed the
  // queue entry. Either way, numbered labels + a single warn is the
  // graceful degradation.
  const parsed = parsedQueue.length ? parsedQueue.shift() : null;
  let labels = null;
  let parsedSectionMeta = null;
  if (parsed) {
    if (parsed.sections.length === sections.length) {
      labels = parsed.sections.map((s) => s.label ?? null);
      parsedSectionMeta = parsed.sections;
    } else if (parsed.sections.length > 0) {
      console.warn(
        `[strasbeat/arrange] runtime has ${sections.length} section${sections.length === 1 ? "" : "s"} but parser found ${parsed.sections.length} at line ${parsed.line} — using numbered labels (nested or dynamic arrange?)`,
      );
    }
  }

  // Freeze the metadata shape — UI only reads these fields, never the
  // raw pattern args. Pattern references live only in the closure over
  // `sections` above and are applied via the solo branch below.
  const entry = {
    arrangeIndex,
    sections: sections.map((_, i) => ({
      cycles: runtimeCycles[i],
      label: labels?.[i] || `Section ${i + 1}`,
      sourceStart: parsedSectionMeta?.[i]?.start ?? null,
      sourceEnd: parsedSectionMeta?.[i]?.end ?? null,
      sourceLine: parsedSectionMeta?.[i]?.line ?? null,
      rawExpr: parsedSectionMeta?.[i]?.rawExpr ?? null,
    })),
    totalCycles,
    sourceLine: parsed?.line ?? null,
    callStart: parsed?.callStart ?? null,
    openParen: parsed?.openParen ?? null,
    closeParen: parsed?.closeParen ?? null,
  };

  registry = registry.concat(entry);
  emit();

  // Solo branch: return a single-section arrangement so the scheduler
  // loops that section at its original cadence. Uses the raw pattern
  // arg (not a derivative) so transforms on the section are preserved.
  if (
    soloKey &&
    soloKey.arrangeIndex === arrangeIndex &&
    soloKey.sectionIndex >= 0 &&
    soloKey.sectionIndex < sections.length
  ) {
    return strudelCore.arrange(sections[soloKey.sectionIndex]);
  }

  return strudelCore.arrange(...sections);
}
