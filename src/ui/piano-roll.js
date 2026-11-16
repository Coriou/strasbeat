// Custom Canvas2D pianoroll renderer for strasbeat.
//
// Replaces @strudel/draw's drawPianoroll with one that fits the design
// system: dark background, subtle beat/cycle gridlines, accent playhead,
// per-layer note coloring, and click-to-locate via the CM6 EditorView.
//
// Called by src/ui/bottom-canvas.js, once per animation frame while the
// roll is on screen and playing, and once per repaint while stopped:
//
//   renderRoll({ haps, time, ctx, drawTime, view, width, height, dpr })
//
// `time` and `drawTime` are in the same units as `hap.whole.begin/end`
// (Strudel cycles, not seconds — see strudel-source/packages/draw/draw.mjs
// Drawer.framer for the upstream math: `phase = scheduler.now() + lookahead`,
// and `time = phase - lookahead`). The visible window is therefore
// `[time + drawTime[0], time + drawTime[1]]`, all in cycles.
//
// Per-layer coloring: groups haps by the start char-offset of their first
// `hap.context.locations` entry (each is a `{ start, end }` object). Different
// stack() arguments come from different source ranges, so they end up in
// different groups. Falls back to grouping by `value.s` (sound name) when
// locations are missing — at minimum, kits with different drum sounds remain
// distinguishable.
//
// Click-to-locate: the renderer rebuilds a per-canvas hit map every frame
// (in CSS pixel coords). A single click listener bound on the first call
// hit-tests against the latest map and dispatches a CM6 selection range
// to the supplied EditorView, scrolling it into view.
//
// Source offsets belong to the code that was evaluated, not to whatever is
// in the editor now. setRollSource() records that code on every evaluate;
// label colours are read from it, and a click maps its offsets through the
// edits made since (or does nothing when the note's source was edited away).
//
// Per-frame cost: everything derived from a hap alone — its times, row
// value, colour, dynamics, source range — is computed once and kept in a
// WeakMap, since the Drawer hands over the same hap objects every frame
// until they scroll off. The frame loop itself allocates nothing.
//
// Track mute/solo legend is handled by src/ui/track-bar.js — a persistent
// DOM strip that lives in the shell grid above the roll pane. The canvas no
// longer draws or hit-tests a legend strip.

import { noteToMidi, freqToMidi, midi2note } from "@strudel/core";
import { parseLabels } from "../editor/track-labels.js";
import { PALETTE } from "./palette.js";

// strasbeat patterns assume 4 beats / cycle (matches transport.js's
// BEATS_PER_CYCLE — see the note there for why this is a project-wide
// convention rather than something Strudel tracks).
const BEATS_PER_CYCLE = 4;
const BOTTOM_LABEL_H = 14; // reserved strip at the bottom for cycle labels
const LEFT_GUTTER_W = 44; // reserved strip on the left for row labels
const PILL_RADIUS = 3; // ≈ --radius-sm minus a hair so corners stay crisp
const MIN_PX_PER_BEAT = 8; // hide beat lines below this density
// How long a row stays reserved after we last saw any pill on it. The
// framer's visibleHaps is only ~4 cycles wide and patterns with masks /
// long periods don't show every value every frame, so we cache row values
// across frames. 16 cycles covers most metric loops while still letting
// truly-removed rows decay (e.g. after the user edits the pattern).
const ROW_STABILITY_CYCLES = 16;

// Per-canvas state. Keyed by HTMLCanvasElement so the click listener and
// the persistent color map are bound exactly once even though the renderer
// itself is called every animation frame.
const stateByCanvas = new WeakMap();

function ensureState(canvas) {
  let s = stateByCanvas.get(canvas);
  if (!s) {
    s = {
      // Hit rectangles for this frame, pooled: only the first `hitCount`
      // entries are live.
      hits: [],
      hitCount: 0,
      view: null,
      clickBound: false,
      // The evaluated code the current haps' source offsets refer to, with
      // its parsed labels: { code, labels }. Set by setRollSource(); until
      // the first evaluate the live document stands in (see liveSource).
      source: null,
      liveDoc: null,
      liveSource: null,
      // hap → derived per-hap data (see hapInfo).
      infoByHap: new WeakMap(),
      // Scratch list of the haps visible this frame, reused across frames.
      frame: [],
      // Rows of the fold layout, bottom to top, rebuilt only when a value
      // appears or decays — see the fold-layout note in renderRoll.
      rows: [],
      rowLabels: [],
      rowIndex: new Map(),
      rowsDirty: true,
      activeRows: new Set(),
      // Playhead glow gradient, valid for one x position and accent colour.
      glow: null,
      glowX: NaN,
      glowAccent: "",
      // Host hooks, refreshed on every render call.
      beforeLocate: null,
      requestRepaint: null,
      // First-sight → palette index. Persistent across frames so a layer's
      // color never re-flips when other layers appear or disappear.
      colorForKey: new Map(),
      // value → t1 of the most recent frame in which a pill for this value
      // was visible. Used to keep the row layout stable across frames even
      // when the framer's visibleHaps slice doesn't contain every row.
      valueLastSeen: new Map(),
      // Last frame's t1 in cycles, for detecting backward time jumps
      // (stop+play, scrub, pattern eval that resets time).
      lastT1: -Infinity,
      // Mouse position in canvas CSS px, or null when the pointer is not
      // over the canvas. The renderer re-hit-tests against this every
      // frame so the hover ring tracks the pill as the roll scrolls —
      // caching a screen-space hit would pin the ring to a dead rectangle.
      mousePos: null,
      // Error flash: performance.now() timestamp until which to draw a
      // brief red tint at the top of the note area. Set by the click
      // handler when a CM6 dispatch call fails.
      errorFlashUntil: 0,
    };
    stateByCanvas.set(canvas, s);
  }
  return s;
}

// Pull a hap's "value" for the y-axis. Mirrors the helper in
// strudel-source/packages/draw/pianoroll.mjs:11-38. Returns either:
//   - a number (a MIDI pitch — pitched notes resolve here, including
//     string note names like "c3" via noteToMidi, and `freq` via
//     freqToMidi), or
//   - a string key like "_bd" for s-only haps (drum hits etc.) so each
//     distinct sound name gets its own row in the fold layout, or
//   - null when no usable value is present.
function getValue(hap) {
  let value = hap?.value;
  if (typeof value !== "object") {
    value = { value };
  }
  let { note, n, freq, s } = value;
  if (freq) {
    return freqToMidi(freq);
  }
  note = note ?? n;
  if (typeof note === "string") {
    try {
      return noteToMidi(note);
    } catch {
      return 0;
    }
  }
  if (typeof note === "number") {
    return note;
  }
  if (s) {
    return "_" + s;
  }
  return null;
}

// Group key for per-layer coloring. Prefers the start char-offset of the
// first source location; falls back to sound name, then note name, then a
// constant so haps without context still render in *some* color.
function getGroupKey(hap) {
  const locs = hap?.context?.locations;
  if (Array.isArray(locs) && locs.length > 0) {
    const first = locs[0];
    if (first && typeof first.start === "number") return `loc:${first.start}`;
  }
  const v = hap?.value;
  if (v && typeof v === "object") {
    if (typeof v.s === "string") return `s:${v.s}`;
    if (v.note != null) return `note:${v.note}`;
  }
  return "default";
}

// Returns the [start, end] char range of the first location, or null. Used
// for click-to-locate; missing locs → no hit registered for that note.
function getFirstLocation(hap) {
  const locs = hap?.context?.locations;
  if (Array.isArray(locs) && locs.length > 0) {
    const first = locs[0];
    if (
      first &&
      typeof first.start === "number" &&
      typeof first.end === "number"
    ) {
      return [first.start, first.end];
    }
  }
  return null;
}

// Read design-token values off the canvas's computed style. Cached for 2s
// so we don't pay the getComputedStyle allocation cost on every animation
// frame (~60fps). Theme changes are picked up after the cache expires.
let _tokenCache = null;
let _tokenCanvas = null;
let _tokenTimer = null;
function readTokens(canvas) {
  if (canvas === _tokenCanvas && _tokenCache) return _tokenCache;
  const cs = getComputedStyle(canvas);
  const get = (name, fallback) => {
    const v = cs.getPropertyValue(name).trim();
    return v || fallback;
  };
  _tokenCanvas = canvas;
  _tokenCache = {
    bg: get("--surface-1", "#1f1f1f"),
    border: get("--border", "#4d4d4d"),
    borderSoft: get("--border-soft", "#2e2e2e"),
    accent: get("--accent", "#cf418d"),
    text: get("--text", "#f5f5f5"),
    textDim: get("--text-dim", "#666"),
    fontSans: get("--font-sans", "system-ui, sans-serif"),
    fontMono: get("--font-mono", "ui-monospace, monospace"),
    textXs: get("--text-xs", "11px"),
  };
  // Derived once per token read rather than once per frame.
  _tokenCache.fontSize = parseInt(_tokenCache.textXs, 10) || 11;
  _tokenCache.cycleFont = `500 ${_tokenCache.fontSize}px ${_tokenCache.fontSans}`;
  _tokenCache.gutterFontSize = 0;
  _tokenCache.gutterFont = "";
  clearTimeout(_tokenTimer);
  _tokenTimer = setTimeout(() => {
    _tokenCache = null;
  }, 2000);
  return _tokenCache;
}

function colorForKey(state, key) {
  const map = state.colorForKey;
  if (!map.has(key)) {
    map.set(key, PALETTE[map.size % PALETTE.length]);
  }
  return map.get(key);
}

/**
 * Record the code a fresh evaluate just installed. Haps created from now on
 * carry source offsets into this text, so their label colours and
 * click-to-locate targets are resolved against it. Haps already on screen
 * keep the source they were first drawn with.
 */
export function setRollSource(canvas, code) {
  const state = ensureState(canvas);
  if (typeof code !== "string") return;
  if (state.source && state.source.code === code) return;
  state.source = { code, labels: parseLabels(code) };
  // Fallback colours are keyed by source offset, which means nothing across
  // two different texts: start the assignment over rather than let the map
  // grow by a key per offset per edit.
  state.colorForKey.clear();
}

/**
 * Forget everything on screen: rows, hit map, hover. For when the canvas is
 * about to show nothing (the document it described was swapped out).
 */
export function resetRoll(canvas) {
  const state = ensureState(canvas);
  state.valueLastSeen.clear();
  state.rowsDirty = true;
  state.lastT1 = -Infinity;
  state.hitCount = 0;
  if (canvas.style && canvas.style.cursor) canvas.style.cursor = "";
}

// The source for haps seen before any evaluate was recorded: the live
// document, re-read only when it changes.
function liveSource(state) {
  const doc = state.view?.state?.doc;
  if (!doc) return EMPTY_SOURCE;
  if (state.liveDoc !== doc) {
    state.liveDoc = doc;
    const code = doc.toString();
    state.liveSource = { code, labels: parseLabels(code) };
  }
  return state.liveSource;
}
const EMPTY_SOURCE = { code: "", labels: [] };

/**
 * Where a range of `from` sits in `to`, given that `to` is `from` after
 * some edits. Exact for anything outside the edited stretch (the text
 * between the first and the last changed character); null for a range the
 * edit touched, since its text is no longer there to point at.
 *
 * @returns {{ start: number, end: number } | null}
 */
export function mapRangeThroughEdit(from, to, start, end) {
  if (!(start >= 0) || !(end >= start) || end > from.length) return null;
  if (from === to) return { start, end };
  const max = Math.min(from.length, to.length);
  let prefix = 0;
  while (prefix < max && from.charCodeAt(prefix) === to.charCodeAt(prefix)) {
    prefix++;
  }
  if (end <= prefix) return { start, end };
  let suffix = 0;
  const maxSuffix = max - prefix;
  while (
    suffix < maxSuffix &&
    from.charCodeAt(from.length - 1 - suffix) ===
      to.charCodeAt(to.length - 1 - suffix)
  ) {
    suffix++;
  }
  if (start >= from.length - suffix) {
    const shift = to.length - from.length;
    return { start: start + shift, end: end + shift };
  }
  return null;
}

// A colour set on the hap itself (`.color("cyan")`) wins over the layer
// colour. Canvas ignores a fillStyle it cannot parse and silently keeps the
// previous one, which would paint the pill in a neighbour's colour — so each
// distinct string is checked once against a context and remembered.
const colorValidity = new Map();
function isUsableColor(ctx, color) {
  let ok = colorValidity.get(color);
  if (ok === undefined) {
    const before = ctx.fillStyle;
    ctx.fillStyle = "#000";
    ctx.fillStyle = color;
    const onBlack = ctx.fillStyle;
    ctx.fillStyle = "#fff";
    ctx.fillStyle = color;
    ok = onBlack === ctx.fillStyle;
    ctx.fillStyle = before;
    if (colorValidity.size > 256) colorValidity.clear();
    colorValidity.set(color, ok);
  }
  return ok;
}

// Everything the frame loop needs from a hap that does not change while the
// hap lives. Times are plain numbers: reading them off the hap's Fractions
// (and `endClipped`, which builds three new Fractions per read) is the bulk
// of the per-note cost otherwise.
function hapInfo(state, ctx, hap) {
  let info = state.infoByHap.get(hap);
  if (info) return info;
  const begin = Number(hap.whole.begin);
  const end = Number(hap.whole.end);
  if (!Number.isFinite(begin) || !Number.isFinite(end)) {
    info = SKIP;
  } else {
    const source = state.source ?? liveSource(state);
    const loc = getFirstLocation(hap);
    const label = loc ? findLabelByOffset(source.labels, loc[0]) : null;
    const own = hap.value?.color;
    const color =
      typeof own === "string" && own && isUsableColor(ctx, own)
        ? own
        : label
          ? PALETTE[source.labels.indexOf(label) % PALETTE.length]
          : colorForKey(state, getGroupKey(hap));
    const { velocity = 1, gain = 1 } = hap.value || {};
    info = {
      begin,
      end,
      endClipped: Number(hap.endClipped),
      val: getValue(hap),
      color,
      dynAlpha: Math.min(1, velocity * gain), // clamp — gain can exceed 1
      locStart: loc ? loc[0] : -1,
      locEnd: loc ? loc[1] : -1,
      source,
    };
  }
  state.infoByHap.set(hap, info);
  return info;
}
const SKIP = Object.freeze({ skip: true });

// strings (drum sounds) sort first so they anchor at the bottom of the
// canvas after y-inversion; numbers (pitched notes) sort after, ascending.
export function compareRowValues(a, b) {
  if (typeof a === "number" && typeof b === "number") return a - b;
  if (typeof a === "number") return 1; // numbers sort AFTER strings
  if (typeof b === "number") return -1; // strings sort BEFORE numbers
  return String(a).localeCompare(String(b));
}

function rebuildRows(state) {
  const rows = state.rows;
  rows.length = 0;
  for (const val of state.valueLastSeen.keys()) rows.push(val);
  rows.sort(compareRowValues);
  state.rowIndex.clear();
  state.rowLabels.length = rows.length;
  for (let i = 0; i < rows.length; i++) {
    const val = rows[i];
    state.rowIndex.set(val, i);
    state.rowLabels[i] =
      typeof val === "number"
        ? midi2note(Math.round(val)) // 60 → "C4", 69 → "A4"
        : String(val).replace(/^_/, ""); // "_bd" → "bd"
  }
  state.rowsDirty = false;
}

// applyPatternTransforms() writes the label id into query-state controls,
// but the haps arriving at onDraw do not surface that state, so a hap is
// mapped back to its owning label via source offsets instead.
function findLabelByOffset(labels, offset) {
  for (const label of labels) {
    if (offset >= label.blockStart && offset < label.blockEnd) {
      return label;
    }
  }
  return null;
}

export function renderRoll({
  haps,
  time,
  ctx,
  drawTime,
  view,
  width,
  height,
  dpr,
  beforeLocate = null,
  requestRepaint = null,
}) {
  const canvas = ctx.canvas;
  const state = ensureState(canvas);
  // Refresh the view ref every frame so the click handler always sees the
  // current EditorView (cheap; the click closure reads from `state`).
  state.view = view ?? state.view;
  state.beforeLocate = beforeLocate;
  state.requestRepaint = requestRepaint;

  if (!state.clickBound) {
    bindInteraction(canvas, state);
    state.clickBound = true;
  }

  // The caller sizes the backing store and tells us the ratio it used, so a
  // display change can never leave the two out of step. Standalone callers
  // fall back to the window's current ratio.
  if (!(dpr > 0)) dpr = window.devicePixelRatio || 1;
  const w = width ?? canvas.width / dpr;
  const h = height ?? canvas.height / dpr;

  // The backing store is sized in device pixels; reset the transform every
  // frame so the renderer can think in CSS px.
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  const tokens = readTokens(canvas);

  // Background
  ctx.fillStyle = tokens.bg;
  ctx.fillRect(0, 0, w, h);

  // Visible time window — same units as hap.whole.begin/end (cycles).
  const t0 = time + drawTime[0];
  const t1 = time + drawTime[1];
  const span = t1 - t0;
  if (span <= 0 || w <= 0 || h <= 0) {
    state.hitCount = 0;
    return;
  }

  // Reserve a strip at the bottom for cycle labels and one on the left for
  // row labels. Every x-coord (gridlines, pills, playhead, hit map, cycle
  // labels) is `noteAreaX + ((t - t0) / span) * noteAreaW`, so the note area shifts
  // in lockstep.
  const noteAreaY = 0;
  const noteAreaH = Math.max(0, h - BOTTOM_LABEL_H);
  const noteAreaX = LEFT_GUTTER_W;
  const noteAreaW = Math.max(0, w - noteAreaX);

  // Clip everything that draws inside the note area (gridlines, pills,
  // playhead glow, cycle labels) to the region right of the gutter so it
  // can't bleed into the row labels. Full canvas height — the bottom-strip
  // cycle labels are inside this clip block.
  ctx.save();
  ctx.beginPath();
  ctx.rect(noteAreaX, noteAreaY, noteAreaW, h - noteAreaY);
  ctx.clip();

  // ── Gridlines ────────────────────────────────────────────────────────
  ctx.lineWidth = 1;

  // Beat lines: every (1 / BEATS_PER_CYCLE) cycle. Hidden when the visible
  // span is so wide that they would crowd into a smear.
  const beatStep = 1 / BEATS_PER_CYCLE;
  const pxPerBeat = (beatStep / span) * w;
  if (pxPerBeat >= MIN_PX_PER_BEAT) {
    ctx.strokeStyle = tokens.borderSoft;
    ctx.beginPath();
    const firstBeat = Math.ceil(t0 / beatStep) * beatStep;
    for (let bt = firstBeat; bt <= t1 + 1e-9; bt += beatStep) {
      // Skip beats that coincide with cycle lines (drawn heavier below).
      if (Math.abs(bt - Math.round(bt)) < 1e-9) continue;
      const x = Math.round(noteAreaX + ((bt - t0) / span) * noteAreaW) + 0.5;
      ctx.moveTo(x, noteAreaY);
      ctx.lineTo(x, noteAreaY + noteAreaH);
    }
    ctx.stroke();
  }

  // Cycle lines: integer cycles, always drawn (heavier).
  ctx.strokeStyle = tokens.border;
  ctx.beginPath();
  const firstCycle = Math.ceil(t0);
  for (let c = firstCycle; c <= t1 + 1e-9; c += 1) {
    const x = Math.round(noteAreaX + ((c - t0) / span) * noteAreaW) + 0.5;
    ctx.moveTo(x, noteAreaY);
    ctx.lineTo(x, noteAreaY + noteAreaH);
  }
  ctx.stroke();

  // Cycle labels in the bottom strip. Numeric-only ("1", "2", …) —
  // cycles are the only horizontal unit on the roll, so a "cyc" prefix
  // would just be visual noise next to the pills.
  const fontSize = tokens.fontSize;
  ctx.fillStyle = tokens.textDim;
  ctx.font = tokens.cycleFont;
  ctx.textBaseline = "alphabetic";
  ctx.textAlign = "left";
  const labelY = h - 3;
  for (let c = firstCycle; c <= t1 + 1e-9; c += 1) {
    const x = Math.round(noteAreaX + ((c - t0) / span) * noteAreaW);
    if (x < -20 || x > w) continue;
    ctx.fillText(String(c), x + 4, labelY);
  }

  // ── Note pills ───────────────────────────────────────────────────────
  // Fold layout: rows are derived from a per-canvas cache that persists
  // across frames. Without this, the row set rebuilds from the visible haps
  // every frame, which is unstable: the framer's slice is ~4 cycles wide,
  // patterns with masks or long periods don't show every value every frame,
  // and the labels would shuffle as values come and go. The cache holds the
  // most recent t1 each value was seen at; values not seen for
  // ROW_STABILITY_CYCLES are dropped, so genuinely-removed rows still decay
  // (e.g. after a pattern edit) without per-frame churn.
  const lastSeen = state.valueLastSeen;
  if (t1 < state.lastT1 - 0.5) {
    // Time jumped backward: stop+play, scrub, or pattern eval reset.
    // Dropping the cache prevents stale rows from a previous run.
    if (lastSeen.size > 0) state.rowsDirty = true;
    lastSeen.clear();
  }
  state.lastT1 = t1;

  // First pass: collect visible haps and mark their rows as seen.
  const frame = state.frame;
  frame.length = 0;
  for (let i = 0; i < haps.length; i++) {
    const hap = haps[i];
    if (!hap || !hap.whole) continue;
    const info = hapInfo(state, ctx, hap);
    if (info === SKIP) continue;
    if (info.end < t0 || info.begin > t1) continue; // off-screen
    frame.push(info);
    const val = info.val;
    if (val != null) {
      if (!lastSeen.has(val)) state.rowsDirty = true;
      lastSeen.set(val, t1);
    }
  }
  const decayCutoff = t1 - ROW_STABILITY_CYCLES;
  for (const [val, lastT] of lastSeen) {
    if (lastT < decayCutoff) {
      lastSeen.delete(val);
      state.rowsDirty = true;
    }
  }
  if (state.rowsDirty) rebuildRows(state);
  const rows = state.rows;
  const rowIndex = state.rowIndex;

  const slotCount = Math.max(1, rows.length);
  const rowH = noteAreaH / slotCount;
  const pillH = Math.max(2, rowH - 2);

  // Track which row values have a currently-playing pill so the gutter
  // label loop (drawn after the clip block) can wash matching rows.
  const activeRows = state.activeRows;
  activeRows.clear();

  // Reset hit map for this frame.
  const hits = state.hits;
  let hitCount = 0;

  const hasRoundRect = typeof ctx.roundRect === "function";
  // Canvas state the pill loop sets, tracked so a run of same-coloured
  // pills doesn't re-assign (and re-parse) an identical style string.
  let fillColor = null;
  let strokeColor = null;
  ctx.lineWidth = 1;

  for (let i = 0; i < frame.length; i++) {
    const info = frame[i];
    const val = info.val;
    if (val == null) continue; // truly empty haps have nowhere to land

    const xRaw = noteAreaX + ((info.begin - t0) / span) * noteAreaW;
    const wRaw = noteAreaX + ((info.end - t0) / span) * noteAreaW - xRaw;
    // Higher pitch = higher on screen → invert the slot index.
    const slot = slotCount - 1 - (rowIndex.get(val) ?? 0);
    const yRaw = noteAreaY + (slot / slotCount) * noteAreaH;

    const x = Math.round(xRaw) + 0.5;
    const y = Math.round(yRaw) + 0.5;
    const pillW = Math.max(2, Math.round(wRaw) - 1);

    const isActive = info.begin <= time && info.endClipped > time;
    if (isActive) activeRows.add(val);
    const color = info.color;
    const dynAlpha = info.dynAlpha;

    const r = Math.max(0, Math.min(PILL_RADIUS, pillH / 2, pillW / 2));
    ctx.beginPath();
    if (hasRoundRect) {
      ctx.roundRect(x, y, pillW, pillH, r);
    } else {
      // Defensive fallback — every modern target supports roundRect, but
      // failing back to a sharp rect is preferable to throwing.
      ctx.rect(x, y, pillW, pillH);
    }
    ctx.globalAlpha = (isActive ? 0.92 : 0.35) * dynAlpha;
    if (fillColor !== color) ctx.fillStyle = fillColor = color;
    ctx.fill();
    ctx.globalAlpha = (isActive ? 1.0 : 0.5) * dynAlpha;
    if (strokeColor !== color) ctx.strokeStyle = strokeColor = color;
    ctx.stroke();

    // Active pill: subtle bright top-edge highlight to reinforce "playing
    // now" beyond the opacity change alone. Thin white line across the top
    // of the pill, low opacity so it reads as a sheen, not an outline.
    if (isActive && pillH >= 4 && pillW >= 4) {
      ctx.globalAlpha = 0.35 * dynAlpha;
      ctx.strokeStyle = strokeColor = "#fff";
      ctx.beginPath();
      ctx.moveTo(x + r, y + 0.5);
      ctx.lineTo(x + pillW - r, y + 0.5);
      ctx.stroke();
    }

    if (info.locStart >= 0) {
      let hit = hits[hitCount];
      if (!hit) hit = hits[hitCount] = { x: 0, y: 0, w: 0, h: 0, info: null };
      hit.x = x - 0.5;
      hit.y = y - 0.5;
      hit.w = pillW + 1;
      hit.h = pillH + 1;
      hit.info = info;
      hitCount++;
    }
  }
  state.hitCount = hitCount;
  ctx.globalAlpha = 1;

  // ── Hover highlight ───────────────────────────────────────────────────
  // Re-hit-test against this frame's pills so the ring tracks whichever
  // pill is under the cursor *now* — pills scroll under a stationary
  // pointer, so a cached screen-space hit would anchor the ring to a
  // dead rectangle.
  const hoveredHit = state.mousePos
    ? hitTest(hits, hitCount, state.mousePos.x, state.mousePos.y)
    : null;
  // Sync cursor against the fresh hit so a stationary pointer over a
  // scrolling pill still shows the pointer affordance.
  if (state.mousePos) {
    const nextCursor = hoveredHit ? "pointer" : "";
    if (canvas.style.cursor !== nextCursor) canvas.style.cursor = nextCursor;
  }
  if (hoveredHit) {
    const hh = hoveredHit;
    const r = Math.max(
      0,
      Math.min(PILL_RADIUS + 1, (hh.h + 2) / 2, (hh.w + 2) / 2),
    );
    ctx.globalAlpha = 0.55;
    ctx.strokeStyle = tokens.text;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    if (hasRoundRect) {
      ctx.roundRect(hh.x - 1, hh.y - 1, hh.w + 2, hh.h + 2, r);
    } else {
      ctx.rect(hh.x - 1, hh.y - 1, hh.w + 2, hh.h + 2);
    }
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  // ── Error flash ──────────────────────────────────────────────────────
  // Brief red tint across the note area when a click-to-locate dispatch
  // fails. Fades over ~400ms so it reads as a blink, not a state.
  const flashRemaining = state.errorFlashUntil - performance.now();
  if (flashRemaining > 0) {
    ctx.globalAlpha = Math.min(0.18, 0.18 * (flashRemaining / 400));
    ctx.fillStyle = tokens.accent;
    ctx.fillRect(noteAreaX, noteAreaY, noteAreaW, noteAreaH);
    ctx.globalAlpha = 1;
    // Nothing else redraws the roll while stopped, so the fade has to ask
    // for its own next frame (a no-op while frames are already coming).
    requestRepaint?.();
  }

  // ── Playhead ─────────────────────────────────────────────────────────
  const px = Math.round(noteAreaX + ((time - t0) / span) * noteAreaW) + 0.5;
  // Subtle accent glow behind the line. The playhead sits at the same x
  // every frame, so the gradient is rebuilt only when that x (a resize) or
  // the accent colour changes.
  if (state.glowX !== px || state.glowAccent !== tokens.accent) {
    const glow = ctx.createLinearGradient(px - 6, 0, px + 6, 0);
    glow.addColorStop(0, "transparent");
    glow.addColorStop(0.5, tokens.accent);
    glow.addColorStop(1, "transparent");
    state.glow = glow;
    state.glowX = px;
    state.glowAccent = tokens.accent;
  }
  ctx.globalAlpha = 0.18;
  ctx.fillStyle = state.glow;
  ctx.fillRect(px - 6, noteAreaY, 12, noteAreaH);
  ctx.globalAlpha = 1;
  ctx.strokeStyle = tokens.accent;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(px, noteAreaY);
  ctx.lineTo(px, noteAreaY + noteAreaH);
  ctx.stroke();

  ctx.restore();

  // ── Row labels (left gutter) ─────────────────────────────────────────
  // Note name (C3, Eb4 …) for pitched rows; sound name (bd, sd …) for
  // drum rows. Font size scales with row height so dense fold layouts
  // shrink gracefully; floor of 8px keeps labels readable.
  const gutterFontSize = Math.min(
    fontSize,
    Math.max(8, Math.floor(rowH * 0.65)),
  );
  if (tokens.gutterFontSize !== gutterFontSize) {
    tokens.gutterFontSize = gutterFontSize;
    tokens.gutterFont = `500 ${gutterFontSize}px ${tokens.fontMono}`;
  }
  ctx.font = tokens.gutterFont;
  ctx.textBaseline = "middle";
  ctx.textAlign = "right";
  ctx.globalAlpha = 1;

  const rowLabels = state.rowLabels;
  for (let i = 0; i < rows.length; i++) {
    const slot = slotCount - 1 - i;
    const y = noteAreaY + (slot / slotCount) * noteAreaH;
    const cy = y + rowH / 2;

    // Faint accent wash behind currently-playing rows so the "bright pill
    // = now" cue extends to the label axis.
    if (activeRows.has(rows[i])) {
      ctx.fillStyle = tokens.accent;
      ctx.globalAlpha = 0.12;
      ctx.fillRect(0, y, LEFT_GUTTER_W, rowH);
      ctx.globalAlpha = 1;
    }

    ctx.fillStyle = tokens.textDim;
    ctx.fillText(rowLabels[i], LEFT_GUTTER_W - 4, cy);
  }

  // Subtle separator between gutter and note area (matches beat gridline weight).
  ctx.strokeStyle = tokens.borderSoft;
  ctx.lineWidth = 1;
  ctx.globalAlpha = 0.5;
  ctx.beginPath();
  ctx.moveTo(noteAreaX - 0.5, noteAreaY);
  ctx.lineTo(noteAreaX - 0.5, noteAreaY + noteAreaH);
  ctx.stroke();
  ctx.globalAlpha = 1;
}

/**
 * Topmost hit rectangle containing the point, or null. `hits` is a pooled
 * array; only its first `count` entries belong to the current frame.
 */
export function hitTest(hits, count, cx, cy) {
  for (let i = count - 1; i >= 0; i--) {
    const hit = hits[i];
    if (
      cx >= hit.x &&
      cx <= hit.x + hit.w &&
      cy >= hit.y &&
      cy <= hit.y + hit.h
    ) {
      return hit;
    }
  }
  return null;
}

function bindInteraction(canvas, state) {
  // Click → jump to source location in the editor.
  canvas.addEventListener("click", (e) => {
    if (!state.view) return;
    const hit = hitTest(state.hits, state.hitCount, e.offsetX, e.offsetY);
    if (!hit) return;
    const { source, locStart, locEnd } = hit.info;
    try {
      // The note may belong to a pattern playing from another tab; let the
      // host bring that document into the editor first. It answers false
      // when the note's document cannot be shown, and the click is dropped.
      if (state.beforeLocate?.() === false) return;
      const view = state.view;
      const range = mapRangeThroughEdit(
        source.code,
        view.state.doc.toString(),
        locStart,
        locEnd,
      );
      if (!range) {
        // The code this note came from has been edited since it was
        // evaluated — there is no honest place to put the cursor.
        throw new Error("the source of this note was edited since the last evaluate");
      }
      view.dispatch({
        selection: { anchor: range.start, head: range.end },
        scrollIntoView: true,
      });
      view.focus?.();
    } catch (err) {
      console.warn("[strasbeat/piano-roll] dispatch failed:", err);
      // Visual flash so the user knows the click didn't just vanish.
      state.errorFlashUntil = performance.now() + 400;
      state.requestRepaint?.();
    }
  });

  // Mousemove → stash the pointer position so the renderer can re-hit-test
  // against the live pill layout each frame. The cursor flip happens here
  // against the most recent hits — good enough between frames, and the
  // next frame's render snaps the ring back into alignment. The canvas has
  // no border or padding, so offsetX/Y are already canvas CSS px (and cost
  // no layout read, unlike getBoundingClientRect).
  // Identified by the note, not the rectangle: hit entries are pooled.
  let hovered = null;
  canvas.addEventListener("mousemove", (e) => {
    const x = e.offsetX;
    const y = e.offsetY;
    if (state.mousePos) {
      state.mousePos.x = x;
      state.mousePos.y = y;
    } else {
      state.mousePos = { x, y };
    }
    const hit = hitTest(state.hits, state.hitCount, x, y);
    const cursor = hit ? "pointer" : "";
    if (canvas.style.cursor !== cursor) canvas.style.cursor = cursor;
    // While stopped no frame is coming to move the hover ring.
    const info = hit ? hit.info : null;
    if (info !== hovered) {
      hovered = info;
      state.requestRepaint?.();
    }
  });

  canvas.addEventListener("mouseleave", () => {
    state.mousePos = null;
    canvas.style.cursor = "";
    if (hovered) {
      hovered = null;
      state.requestRepaint?.();
    }
  });
}
