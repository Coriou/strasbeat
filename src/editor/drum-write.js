// Pure computations that turn a beat-grid gesture into a CodeMirror
// change. Kept as plain functions (no CodeMirror deps) so the logic can
// be unit-tested without a live view.
//
// The grid calls parseDrumLanes(code) *just before* each dispatch so the
// offsets in `lane.steps[N]` are always fresh. These helpers take that
// freshly-parsed lane + step index and return a `{ from, to, insert }`
// change ready to drop into `view.dispatch({ changes })`.
//
// Design choices:
//   - We only mutate the single token at steps[N].tokenStart..tokenEnd.
//     Quote characters, surrounding whitespace, and the rest of the line
//     stay untouched so CodeMirror's minimal-diff algorithm keeps the
//     undo history clean (one cell toggle = one Cmd+Z).
//   - Turning a cell ON uses `sound:0` (explicit variant) when the lane
//     already mixes variants, and bare `sound` when it doesn't — the goal
//     is "match the prevailing style of the lane so the diff is small".
//   - Variant 0 is written as bare `sound` (no `:0` suffix). It's the
//     canonical default and the upstream getSound picks sample index 0
//     when no variant is given.

/**
 * Render a step to its source-text form. `kind: "rest"` → `"~"`;
 * `kind: "hit"` → `"sound"` or `"sound:N"` depending on variant.
 */
export function formatStepToken(step) {
  if (!step || step.kind === "rest") return "~";
  if (step.variant != null && step.variant > 0) {
    return `${step.sound}:${step.variant}`;
  }
  return step.sound;
}

/**
 * True iff any hit on the lane carries an explicit variant (`sound:N`
 * with N >= 0). Used to decide whether a newly-turned-on cell should
 * write bare `sound` or `sound:0` — we match whatever style the user's
 * line already prefers.
 */
export function laneUsesExplicitVariants(lane) {
  if (!lane || !lane.steps) return false;
  for (const step of lane.steps) {
    if (step.kind === "hit" && step.variant != null) return true;
  }
  return false;
}

/**
 * Resolve the "default sound" for a new hit on a lane. Prefers the
 * parser's primarySound (most-common hit); falls back to the first hit
 * the user wrote; returns null when every step is a rest (caller must
 * handle that case — we don't invent a sound out of thin air).
 */
export function defaultSoundFor(lane) {
  if (!lane) return null;
  if (lane.primarySound) return lane.primarySound;
  for (const step of lane.steps || []) {
    if (step.kind === "hit" && step.sound) return step.sound;
  }
  return null;
}

/**
 * Build a {from, to, insert} change that replaces the step token at
 * `stepIndex` with `newText`. Returns null when the index is out of
 * range (so callers can skip without throwing).
 */
export function changeForStepToken(lane, stepIndex, newText) {
  const step = lane?.steps?.[stepIndex];
  if (!step) return null;
  return { from: step.tokenStart, to: step.tokenEnd, insert: newText };
}

/**
 * Turn an empty (rest) cell into a hit. `sound` / `variant` override the
 * defaults — normally the caller supplies the lane's primarySound and
 * whatever variant the interaction dictates.
 *
 * Lane-style rule: when the lane already mixes variants we write the
 * explicit `sound:0` token (matches the prevailing look of the line);
 * otherwise we write bare `sound`. Per design/work/19-beat-grid.md
 * §"UX → Cell interactions".
 *
 * Returns null when the lane has no sound to fall back on.
 */
export function changeForCellOn(lane, stepIndex, opts = {}) {
  const sound = opts.sound ?? defaultSoundFor(lane);
  if (!sound) return null;
  let newText;
  if (opts.variant != null) {
    // Caller picked a variant explicitly — formatStepToken collapses 0
    // to bare `sound` (consistent with the variant menu's "N (0)" slot).
    newText = formatStepToken({
      kind: "hit",
      sound,
      variant: opts.variant,
    });
  } else if (laneUsesExplicitVariants(lane)) {
    newText = `${sound}:0`;
  } else {
    newText = sound;
  }
  return changeForStepToken(lane, stepIndex, newText);
}

/**
 * Turn a filled cell into a rest (`~`).
 */
export function changeForCellOff(lane, stepIndex) {
  return changeForStepToken(lane, stepIndex, "~");
}

/**
 * Set a specific variant on a filled cell. Variant 0 collapses to bare
 * `sound` (no suffix) so the diff stays small when the user picks "base
 * sample" from the variant menu.
 *
 * Returns null for rest cells — variants are a hit-only concept.
 */
export function changeForVariant(lane, stepIndex, variant) {
  const step = lane?.steps?.[stepIndex];
  if (!step || step.kind !== "hit" || !step.sound) return null;
  const newVariant = variant <= 0 ? null : variant;
  const newText = formatStepToken({
    kind: "hit",
    sound: step.sound,
    variant: newVariant,
  });
  return changeForStepToken(lane, stepIndex, newText);
}

/**
 * Cycle the variant on a filled cell: 0 → 1 → 2 → … → maxVariant → 0.
 * `maxVariant` is the highest *sample index* available for the sound —
 * i.e. sampleCount - 1. Caller fetches it from the soundMap.
 *
 * Returns null for rest cells.
 */
export function changeForCycleVariant(lane, stepIndex, maxVariant) {
  const step = lane?.steps?.[stepIndex];
  if (!step || step.kind !== "hit" || !step.sound) return null;
  const current = step.variant ?? 0;
  const cap = Math.max(0, maxVariant | 0);
  const next = current >= cap ? 0 : current + 1;
  return changeForVariant(lane, stepIndex, next);
}

/**
 * Build a sorted, non-overlapping changes array for a shift-drag paint
 * stroke. Each op is `{ stepIndex, action: "on"|"off", sound?, variant? }`.
 *
 * Returns the combined change list in ascending `from` order so
 * `view.dispatch({ changes })` applies cleanly. Ops with no effect
 * (step already matching the target, step out of range) are dropped.
 */
export function changesForPaint(lane, ops) {
  const changes = [];
  const seen = new Set();
  for (const op of ops) {
    if (seen.has(op.stepIndex)) continue;
    seen.add(op.stepIndex);

    let change = null;
    if (op.action === "on") {
      change = changeForCellOn(lane, op.stepIndex, {
        sound: op.sound,
        variant: op.variant,
      });
    } else if (op.action === "off") {
      change = changeForCellOff(lane, op.stepIndex);
    }
    if (!change) continue;

    // Skip no-ops — the CM transaction would mark docChanged and trigger a
    // rebuild even when nothing actually changed.
    const step = lane.steps[op.stepIndex];
    if (step) {
      const currentText = formatStepToken(step);
      if (currentText === change.insert) continue;
    }
    changes.push(change);
  }
  changes.sort((a, b) => a.from - b.from);
  return changes;
}

/**
 * How many sample variants are available for (bank, sound). Variant N
 * means sample index N in the resolved soundMap entry. Returns 1 when
 * the sound isn't registered — the caller should treat that as "no
 * variants to cycle".
 *
 * This mirrors the sample-count logic in src/ui/sound-browser.js so the
 * two panels agree on what counts as a variant.
 */
export function getSampleCount(soundMap, bank, sound) {
  if (!soundMap || !sound) return 1;
  const key = bank ? `${bank}_${sound}` : sound;
  const entry = soundMap[key] ?? soundMap[sound];
  const data = entry?.data;
  if (!data) return 1;
  if (Array.isArray(data.samples)) return data.samples.length || 1;
  if (data.samples && typeof data.samples === "object") {
    let n = 0;
    for (const v of Object.values(data.samples)) {
      n += Array.isArray(v) ? v.length : 1;
    }
    return n || 1;
  }
  return 1;
}

/**
 * Resolve the effective sound key used by superdough() when a bank is
 * set — `${bank}_${sound}` if bank is present and the combined key
 * exists, otherwise the plain sound name. Returns null for rest cells.
 */
export function resolveSoundKey(soundMap, bank, sound) {
  if (!sound) return null;
  if (bank) {
    const combined = `${bank}_${sound}`;
    if (soundMap?.[combined]) return combined;
  }
  return sound;
}

// ─── Phase 3: lane-chrome helpers ─────────────────────────────────────────
//
// These are pure transforms over a freshly-parsed lane. They either return
// a single CM `{from, to, insert}` change, an array of changes, or null
// when the gesture makes no sense (e.g. mute-toggle on a missing lane).
//
// Mute / solo reuse the label-decoration grammar from src/editor/track-labels.js
// so the beat-grid and track-bar write the *same* source edit — no second
// state store. The label body for a drum lane is always `$`; the decoration
// is a `_` mute (prefix or suffix, matching how the user originally typed
// it) and/or an `S` solo prefix. `S` takes precedence in the prefix slot,
// so `_S$_` is impossible — the track-labels rules resolve to:
//
//   $         plain
//   _$        muted (prefix)
//   $_        muted (suffix)
//   S$        soloed
//   S$_       soloed + muted
//   _S$       (parsed as muted + soloed — underscore prefix wins)
//
// We preserve the existing mute-style (prefix vs. suffix) when the user
// flips solo, so the diff stays small.

function decorateLabel(core, muted, soloed, muteStyle) {
  let body = core;
  if (muted) {
    // When solo is on, the `S` takes the prefix slot — so mute has to go
    // to the suffix. Otherwise the parser reads `S_$` as "soloed, not
    // muted" (the leading `S` strips off; the remaining body `_$` doesn't
    // start or end with `_`, so no mute is detected). Forcing suffix when
    // soloed keeps both decorations observable.
    const style = soloed ? "suffix" : muteStyle;
    body = style === "prefix" ? `_${body}` : `${body}_`;
  }
  if (soloed) {
    body = `S${body}`;
  }
  return body;
}

/**
 * Replace just the label name (`$`, `_$`, `S$`, etc.) with a freshly
 * decorated form. Returns a single-range change, or null if the lane has
 * no usable `rawLabel`.
 */
function changeForLabelRewrite(lane, nextRaw) {
  if (!lane || lane.lineStart == null) return null;
  // lineStart points at the first char of the label; rawLabel covers the
  // full decorated name. Do NOT try to guess the old length from the
  // parsed shape — use what the scanner captured.
  const from = lane.lineStart;
  const to = lane.lineStart + (lane.rawLabel?.length ?? 0);
  if (to <= from) return null;
  return { from, to, insert: nextRaw };
}

/**
 * Flip the `_` mute decoration on the lane label. Preserves solo + original
 * mute-style (prefix `_$` vs suffix `$_`).
 */
export function changeForMuteToggle(lane) {
  if (!lane) return null;
  const muteStyle =
    !lane.soloed && lane.rawLabel?.startsWith("_")
      ? "prefix"
      : lane.rawLabel?.endsWith("_")
        ? "suffix"
        : "prefix"; // default new mute goes to prefix, same as track-labels.js
  const nextRaw = decorateLabel("$", !lane.muted, !!lane.soloed, muteStyle);
  return changeForLabelRewrite(lane, nextRaw);
}

/**
 * Flip the `S` solo decoration on the lane label. Preserves mute + style.
 */
export function changeForSoloToggle(lane) {
  if (!lane) return null;
  const muteStyle =
    !lane.soloed && lane.rawLabel?.startsWith("_")
      ? "prefix"
      : lane.rawLabel?.endsWith("_")
        ? "suffix"
        : "prefix";
  const nextRaw = decorateLabel("$", !!lane.muted, !lane.soloed, muteStyle);
  return changeForLabelRewrite(lane, nextRaw);
}

/**
 * Set / replace / remove the `.bank("…")` call on a lane.
 *
 *   bankName === null        → delete the `.bank(...)` call entirely
 *   lane.bank === null       → insert `.bank("bankName")` right after `s("…")`
 *   otherwise                → replace the argument inside `.bank(...)`
 *
 * When deleting, we currently only strip the argument — callers dispatch
 * this through the grid which re-parses on docChange; we want the cleaner
 * "remove the whole `.bank(...)` call" behaviour though, so we handle that
 * via the full call range when `bankName === null`. The scanner gives us
 * `bank.argStart/argEnd` (offsets inside the quotes) but not the call
 * boundaries directly, so we reconstruct from the code and the argStart.
 *
 * Takes the full `code` too, so we can find the surrounding `.bank(` and
 * the closing `)` for the delete case without re-scanning.
 */
export function changeForBankSet(lane, bankName, code) {
  if (!lane) return null;
  const target = bankName == null ? null : String(bankName).trim() || null;

  // No bank currently, and caller asked to clear: no-op.
  if (!lane.bank && !target) return null;

  // Insert a brand-new `.bank("…")` call just after `s("…")`.
  if (!lane.bank && target) {
    return {
      from: lane.insertBankAt,
      to: lane.insertBankAt,
      insert: `.bank("${target}")`,
    };
  }

  // Replace the existing bank argument.
  if (lane.bank && target) {
    // argStart/argEnd span includes the opening + closing quotes. Replace
    // the whole quoted literal so the surrounding `.bank(` / `)` stays
    // untouched.
    return {
      from: lane.bank.argStart,
      to: lane.bank.argEnd,
      insert: `"${target}"`,
    };
  }

  // Delete the whole `.bank("…")` call. We walk back from argStart through
  // optional whitespace to the `(`, then to the method name, then to the
  // leading `.`; forward from argEnd we skip whitespace to the `)`.
  if (lane.bank && !target && typeof code === "string") {
    const aStart = lane.bank.argStart;
    const aEnd = lane.bank.argEnd;
    // Walk back from `(` to `.bank`.
    let i = aStart - 1;
    while (i >= 0 && /\s/.test(code[i])) i--;
    if (code[i] !== "(") return null;
    // behind the `(` we expect `bank` with optional whitespace between.
    let j = i - 1;
    while (j >= 0 && /\s/.test(code[j])) j--;
    // walk back across the identifier
    while (j >= 0 && /[A-Za-z0-9_$]/.test(code[j])) j--;
    // `j` now points at the char before the method name; expect `.` (with
    // possible whitespace).
    let k = j;
    while (k >= 0 && /\s/.test(code[k])) k--;
    if (code[k] !== ".") return null;

    // Walk forward from argEnd through whitespace to `)`.
    let m = aEnd;
    while (m < code.length && /\s/.test(code[m])) m++;
    if (code[m] !== ")") return null;

    return {
      from: k,
      to: m + 1,
      insert: "",
    };
  }

  return null;
}

/**
 * Swap every hit's `sound` ident on a lane from `fromSound` to `toSound`,
 * preserving any `:N` variant suffix. Returns an array of changes (one per
 * matched step), or an empty array when nothing matched.
 *
 * Use case: the user clicks the lane sound chip (currently "bd") and picks
 * "cp" — every `bd` / `bd:N` step in the lane becomes `cp` / `cp:N`, but
 * mixed-sound rows are preserved because steps whose sound is already `sd`
 * don't match `fromSound === "bd"`.
 */
export function changeForSoundSwap(lane, fromSound, toSound) {
  if (!lane || !lane.steps || !fromSound || !toSound) return [];
  if (fromSound === toSound) return [];
  const changes = [];
  for (const step of lane.steps) {
    if (step.kind !== "hit" || step.sound !== fromSound) continue;
    const newText = formatStepToken({
      kind: "hit",
      sound: toSound,
      variant: step.variant,
    });
    changes.push({
      from: step.tokenStart,
      to: step.tokenEnd,
      insert: newText,
    });
  }
  changes.sort((a, b) => a.from - b.from);
  return changes;
}

// ─── Phase 3b: lane authoring ──────────────────────────────────────────────

const DEFAULT_ADD_STEP_COUNT = 16;

/**
 * Build a new `$:` drum-lane source line given a sound name and an optional
 * bank. 16 steps, the sound on step 0, rests elsewhere — so the lane is
 * audible immediately when play fires, matching the
 * "audible without further clicks" rule in the Phase 3 spec.
 */
export function buildAddLaneText(sound, bank, stepCount = DEFAULT_ADD_STEP_COUNT) {
  if (!sound) return null;
  const n = stepCount > 0 ? (stepCount | 0) : DEFAULT_ADD_STEP_COUNT;
  const stepChars = [sound];
  for (let i = 1; i < n; i++) stepChars.push("~");
  const step = stepChars.join(" ");
  const bankCall = bank ? `.bank("${bank}")` : "";
  return `$: s("${step}")${bankCall}`;
}

/**
 * Insert a new `$:` line after the last `$:` drum lane in `lanes`. If
 * `lanes` is empty, the line is appended at the end of the buffer.
 *
 * Returns a single-range insertion. Newlines are added as needed so the
 * new line sits on its own line with a blank line of separation before it
 * (matches existing pattern style — `beat-grid-demo.js` and
 * `pattern-market.js` both keep blank lines between `$:` lanes).
 */
export function changeForAddLane(code, lanes, laneText) {
  if (!laneText) return null;
  const text = String(laneText);
  const codeStr = String(code ?? "");

  // Case 1: no existing lanes. Append at end of buffer.
  if (!lanes || lanes.length === 0) {
    const needsLeadingNewline = codeStr.length > 0 && !codeStr.endsWith("\n");
    const prefix = needsLeadingNewline ? "\n\n" : codeStr.length > 0 ? "\n" : "";
    return {
      from: codeStr.length,
      to: codeStr.length,
      insert: `${prefix}${text}\n`,
    };
  }

  // Case 2: insert after the last `$:` line's block.
  const last = lanes[lanes.length - 1];
  const insertAt = last.lineEnd; // points at the EOL or end-of-buffer of the last line of the block
  // We insert `\n\n<text>` so there's a blank line before the new lane,
  // matching the formatting in beat-grid-demo.js.
  const before = codeStr.slice(0, insertAt);
  const prefix = before.endsWith("\n") ? "\n" : "\n\n";
  return {
    from: insertAt,
    to: insertAt,
    insert: `${prefix}${text}`,
  };
}

/**
 * Remove a lane entirely — its full block range plus the trailing EOL so
 * the next line shifts up cleanly. If the block is at end-of-buffer and
 * has no trailing EOL, we also eat a preceding blank line if there is one
 * so we don't leave a "hanging" blank gap.
 */
export function changeForDeleteLane(code, lane) {
  if (!lane) return null;
  const codeStr = String(code ?? "");
  let from = lane.lineStart;
  let to = lane.lineEnd;
  // Eat one trailing newline so the following line collapses up.
  if (to < codeStr.length && codeStr[to] === "\n") to++;
  // If the deletion leaves double newlines behind, eat one of them so we
  // don't accumulate blank gap over repeated deletes.
  if (
    to < codeStr.length &&
    codeStr[to] === "\n" &&
    from > 0 &&
    codeStr[from - 1] === "\n"
  ) {
    to++;
  }
  return { from, to, insert: "" };
}

/**
 * Copy a lane's source verbatim and insert it directly after the original.
 * The copy includes any trailing chain the parser associated with the
 * block (via `lineEnd`), so multi-line chains round-trip.
 *
 * The parser's `lineEnd` sometimes includes the trailing `\n` (when the
 * block ends at end-of-buffer) and sometimes doesn't (when there's a
 * following block). We normalise here so the resulting source always has
 * exactly one `\n` separating the original and the copy.
 */
export function changeForDuplicateLane(code, lane) {
  if (!lane) return null;
  const codeStr = String(code ?? "");
  const rawBlock = codeStr.slice(lane.lineStart, lane.lineEnd);
  // Strip the trailing newline if one is embedded in the block — we'll add
  // a single leading newline on the insert so separation is uniform.
  const blockBody = rawBlock.endsWith("\n") ? rawBlock.slice(0, -1) : rawBlock;
  const insertAt = lane.lineEnd;
  // If the block ended at a `\n`, insertAt lands right after it — prefix
  // nothing (the original already has its own EOL and insertAt is on the
  // next line). Otherwise the original has no trailing newline, so we add
  // one before the copy so they don't collapse onto the same line.
  const prefix = rawBlock.endsWith("\n") ? "" : "\n";
  // Always put a trailing `\n` after the copy so the buffer stays
  // well-formed. If the insertion point was already followed by a `\n`,
  // leave the prefix to handle separation; otherwise the copy is the new
  // last line and needs its own terminator.
  const suffix = insertAt < codeStr.length && codeStr[insertAt] === "\n" ? "" : "\n";
  return {
    from: insertAt,
    to: insertAt,
    insert: `${prefix}${blockBody}${suffix}`,
  };
}

/**
 * Swap two lanes by replacing the full code range they collectively span
 * with their source text rewritten in opposite order. Returns a single-
 * range change so one Ctrl+Z reverts the reorder.
 *
 * Both lanes must be from the same parse pass (offsets must be live). If
 * `laneA` and `laneB` are the same lane, or if they overlap, returns null.
 *
 * The parser's `lineEnd` is inconsistent about whether the trailing `\n`
 * is included — a middle lane stops at the `\n` exclusive, while the
 * final lane in a buffer often runs to `code.length` (and therefore
 * includes any trailing `\n`). We normalise here by stripping any
 * trailing `\n` from each block body and re-using the existing between-
 * content (which already carries the single-newline separator).
 */
export function changeForReorderLanes(code, laneA, laneB) {
  if (!laneA || !laneB) return null;
  if (laneA.lineStart === laneB.lineStart) return null;
  const codeStr = String(code ?? "");
  // Order them top-down for an easy span.
  const [top, bot] =
    laneA.lineStart < laneB.lineStart ? [laneA, laneB] : [laneB, laneA];
  if (top.lineEnd > bot.lineStart) return null; // overlap — shouldn't happen for parsed lanes, but guard

  // Compute the bodies minus any trailing `\n`, and the between-content
  // likewise minus any leading `\n` so we can reason uniformly. The
  // canonical rewrite is:
  //
  //   botBody + "\n" + normalizedBetween + topBody + trailing
  //
  // where `trailing` is "\n" iff the original span included one at its
  // end (i.e. botRaw ended with `\n`).
  const topRaw = codeStr.slice(top.lineStart, top.lineEnd);
  const botRaw = codeStr.slice(bot.lineStart, bot.lineEnd);
  const rawBetween = codeStr.slice(top.lineEnd, bot.lineStart);
  const topBody = topRaw.endsWith("\n") ? topRaw.slice(0, -1) : topRaw;
  const botBody = botRaw.endsWith("\n") ? botRaw.slice(0, -1) : botRaw;
  // If the top block kept its trailing `\n` inside the body, we've just
  // peeled it off above, so the between-content starts with the next line.
  // If the top block's `\n` was outside the block (parser's usual choice
  // for a middle lane), the between-content starts with that `\n`. Either
  // way we want to strip exactly ONE leading `\n` from the between so we
  // don't double-up.
  const between = rawBetween.startsWith("\n")
    ? rawBetween.slice(1)
    : rawBetween;
  const trailing = botRaw.endsWith("\n") ? "\n" : "";

  return {
    from: top.lineStart,
    to: bot.lineEnd,
    insert: `${botBody}\n${between}${topBody}${trailing}`,
  };
}

/**
 * Move `source` to take the position of `target` and push `target` (plus
 * anything between them) in the opposite direction. This is the insert-
 * into-position semantics expected by a drag-to-reorder gesture:
 *
 *   drag A onto B  →  A ends up at B's old position, B shifts
 *                      toward A's old position along with anything
 *                      between them.
 *
 * Differs from `changeForReorderLanes`, which swaps only the two
 * endpoints and leaves the middle undisturbed — that's wrong for a
 * drag gesture across multiple lanes.
 */
export function changeForMoveLane(code, source, target) {
  if (!source || !target) return null;
  if (source.lineStart === target.lineStart) return null;
  const codeStr = String(code ?? "");
  const sourceRaw = codeStr.slice(source.lineStart, source.lineEnd);
  const sourceBody = sourceRaw.endsWith("\n") ? sourceRaw.slice(0, -1) : sourceRaw;

  if (source.lineStart < target.lineStart) {
    // Moving DOWN: pull source below target. The block spans from
    // source.lineStart through target.lineEnd. In the rewrite, we emit
    // the between-content first (pushed up), then source, then any
    // trailing newline that target originally had.
    const between = codeStr.slice(source.lineEnd, target.lineEnd);
    const betweenLead = between.startsWith("\n") ? between.slice(1) : between;
    const betweenBody = betweenLead.endsWith("\n")
      ? betweenLead.slice(0, -1)
      : betweenLead;
    const trailing = between.endsWith("\n") ? "\n" : "";
    return {
      from: source.lineStart,
      to: target.lineEnd,
      insert: `${betweenBody}\n${sourceBody}${trailing}`,
    };
  }
  // Moving UP: insert source above target. Span is target.lineStart
  // through source.lineEnd. Rewrite: source, then the between-content
  // (pushed down), then any trailing newline that source originally had.
  const between = codeStr.slice(target.lineStart, source.lineStart);
  const betweenBody = between.endsWith("\n") ? between.slice(0, -1) : between;
  const trailing = sourceRaw.endsWith("\n") ? "\n" : "";
  return {
    from: target.lineStart,
    to: source.lineEnd,
    insert: `${sourceBody}\n${betweenBody}${trailing}`,
  };
}

/**
 * Expand a `sound*N` shortcut step string into N space-separated copies of
 * `sound`. Returns the new step-string body (the contents inside the
 * `s("…")` quotes, no surrounding quotes) — or null when the body doesn't
 * match `<ident>[:N]*<count>` exactly.
 *
 * Cap `count` at 32 so an errant `hh*128` doesn't explode the buffer.
 */
export const NORMALISE_SHORTCUT_CAP = 32;

export function expandShortcut(stepStringRaw) {
  if (typeof stepStringRaw !== "string") return null;
  const trimmed = stepStringRaw.trim();
  const m = /^([A-Za-z_$][A-Za-z0-9_$]*(?::\d+)?)\*(\d+)$/.exec(trimmed);
  if (!m) return null;
  const token = m[1];
  const count = Math.min(NORMALISE_SHORTCUT_CAP, Math.max(1, parseInt(m[2], 10)));
  return Array.from({ length: count }, () => token).join(" ");
}

/**
 * Build the CM change that rewrites a shortcut lane's step string in-place
 * to its flat-expanded form. Returns null when the source doesn't match
 * the simple `sound*N` shape (so the grid's fallback "edit as text"
 * stripe keeps its generic behaviour).
 */
export function changeForNormaliseShortcut(lane, code) {
  if (!lane) return null;
  const codeStr = String(code ?? "");
  const body = codeStr.slice(lane.stepStart, lane.stepEnd);
  const expanded = expandShortcut(body);
  if (expanded == null) return null;
  return {
    from: lane.stepStart,
    to: lane.stepEnd,
    insert: expanded,
  };
}

/**
 * Double a lane's step count by interleaving a `~` rest between every
 * existing token. Caps at `targetCount` so the caller controls the
 * stopping point (8 or 16 are the only v1-editable larger sizes).
 *
 *   "bd ~ sd ~" (4 steps) → "bd ~ ~ ~ sd ~ ~ ~" (8 steps)
 *
 * Requires the lane to be editable and have a power-of-two step count
 * <= targetCount / 2. Returns null for anything else so the UI hides the
 * action rather than lying about what it can do.
 */
export function changeForUpgradeResolution(lane, targetCount) {
  if (!lane || !lane.editable) return null;
  const target = targetCount | 0;
  if (target !== 8 && target !== 16) return null;
  if (lane.stepCount >= target) return null;
  if (target % lane.stepCount !== 0) return null;
  const mult = target / lane.stepCount;
  // Build the new step string by emitting each token followed by (mult-1)
  // `~`s, space-separated.
  const parts = [];
  for (const step of lane.steps) {
    parts.push(formatStepToken(step));
    for (let k = 1; k < mult; k++) parts.push("~");
  }
  const body = parts.join(" ");
  return {
    from: lane.stepStart,
    to: lane.stepEnd,
    insert: body,
  };
}
