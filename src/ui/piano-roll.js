// Custom Canvas2D pianoroll renderer for strasbeat.
//
// Replaces @strudel/draw's drawPianoroll with one that fits the design
// system: dark background, subtle beat/cycle gridlines, accent playhead,
// per-layer note coloring, and click-to-locate via the CM6 EditorView.
//
// Called from main.js's onDraw callback every animation frame:
//
//   renderRoll({ haps, time, ctx, drawTime, view })
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
      hits: [],
      view: null,
      doc: null,
      code: "",
      labels: [],
      clickBound: false,
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
      // Hover state: the currently hovered hit-map entry, or null. Updated
      // by the mousemove listener, consumed by the renderer to draw a
      // highlight ring and by the cursor-style logic.
      hoveredHit: null,
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

function syncEditorState(state, view) {
  if (!view) return;
  if (state.doc === view.state.doc) return;
  state.doc = view.state.doc;
  state.code = view.state.doc.toString();
  state.labels = parseLabels(state.code);
}

function findLabelByOffset(labels, offset) {
  for (const label of labels) {
    if (offset >= label.blockStart && offset < label.blockEnd) {
      return label;
    }
  }
  return null;
}

function getLabelForHap(hap, labels) {
  // applyPatternTransforms() writes the label id into query-state controls,
  // but the haps arriving at onDraw do not surface that state, so we map
  // back to the owning label via source offsets instead.
  const loc = getFirstLocation(hap);
  if (!loc) return null;
  return findLabelByOffset(labels, loc[0]);
}

export function renderRoll({ haps, time, ctx, drawTime, view }) {
  const canvas = ctx.canvas;
  const state = ensureState(canvas);
  // Refresh the view ref every frame so the click handler always sees the
  // current EditorView (cheap; the click closure reads from `state`).
  state.view = view ?? state.view;
  syncEditorState(state, state.view);

  if (!state.clickBound) {
    bindInteraction(canvas, state);
    state.clickBound = true;
  }

  const dpr = window.devicePixelRatio || 1;
  const w = canvas.width / dpr;
  const h = canvas.height / dpr;

  // The backing store is sized in device pixels by main.js's resizeCanvas;
  // reset the transform every frame so the renderer can think in CSS px.
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
    state.hits.length = 0;
    return;
  }

  const labels = state.labels;

  // Reserve a strip at the bottom for cycle labels and one on the left for
  // row labels. Every x-coord (gridlines, pills, playhead, hit map, cycle
  // labels) flows through `timeToX`, so the note area shifts in lockstep.
  const noteAreaY = 0;
  const noteAreaH = Math.max(0, h - BOTTOM_LABEL_H);
  const noteAreaX = LEFT_GUTTER_W;
  const noteAreaW = Math.max(0, w - noteAreaX);
  const timeToX = (t) => noteAreaX + ((t - t0) / span) * noteAreaW;

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
      const x = Math.round(timeToX(bt)) + 0.5;
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
    const x = Math.round(timeToX(c)) + 0.5;
    ctx.moveTo(x, noteAreaY);
    ctx.lineTo(x, noteAreaY + noteAreaH);
  }
  ctx.stroke();

  // Cycle labels in the bottom strip.
  const fontSize = parseInt(tokens.textXs, 10) || 11;
  ctx.fillStyle = tokens.textDim;
  ctx.font = `500 ${fontSize}px ${tokens.fontSans}`;
  ctx.textBaseline = "alphabetic";
  ctx.textAlign = "left";
  const labelY = h - 3;
  for (let c = firstCycle; c <= t1 + 1e-9; c += 1) {
    const x = Math.round(timeToX(c));
    if (x < -20 || x > w) continue;
    ctx.fillText(`cyc ${c}`, x + 4, labelY);
  }

  // ── Note pills ───────────────────────────────────────────────────────
  // First pass: collect visible haps.
  const visibleHaps = [];
  for (const hap of haps) {
    if (!hap || !hap.whole) continue;
    const begin = Number(hap.whole.begin);
    const end = Number(hap.whole.end);
    if (!Number.isFinite(begin) || !Number.isFinite(end)) continue;
    if (end < t0 || begin > t1) continue; // off-screen
    const val = getValue(hap);
    visibleHaps.push({ hap, begin, end, val });
  }

  // Fold layout: rows are derived from a per-canvas cache that persists
  // across frames. Without this, the row set rebuilds from `visibleHaps`
  // every frame, which is unstable: the framer's slice is ~4 cycles wide,
  // patterns with masks or long periods don't show every value every frame,
  // and the labels would shuffle as values come and go. The cache holds the
  // most recent t1 each value was seen at; values not seen for
  // ROW_STABILITY_CYCLES are dropped, so genuinely-removed rows still decay
  // (e.g. after a pattern edit) without per-frame churn.
  if (t1 < state.lastT1 - 0.5) {
    // Time jumped backward: stop+play, scrub, or pattern eval reset.
    // Dropping the cache prevents stale rows from a previous run.
    state.valueLastSeen.clear();
  }
  state.lastT1 = t1;
  for (const item of visibleHaps) {
    if (item.val != null) state.valueLastSeen.set(item.val, t1);
  }
  const decayCutoff = t1 - ROW_STABILITY_CYCLES;
  for (const [val, lastT] of state.valueLastSeen) {
    if (lastT < decayCutoff) state.valueLastSeen.delete(val);
  }
  const uniqueValues = Array.from(state.valueLastSeen.keys());
  // strings (drum sounds) sort first so they anchor at the bottom of the
  // canvas after y-inversion; numbers (pitched notes) sort after, ascending.
  uniqueValues.sort((a, b) => {
    if (typeof a === "number" && typeof b === "number") return a - b;
    if (typeof a === "number") return 1; // numbers sort AFTER strings
    if (typeof b === "number") return -1; // strings sort BEFORE numbers
    return String(a).localeCompare(String(b));
  });

  const slotCount = Math.max(1, uniqueValues.length);
  const rowH = noteAreaH / slotCount;
  const pillH = Math.max(2, rowH - 2);

  // Build O(1) lookup for value → slot index (avoids indexOf per hap).
  const valueIndex = new Map();
  for (let i = 0; i < uniqueValues.length; i++) {
    valueIndex.set(uniqueValues[i], i);
  }

  const valueToY = (val) => {
    const idx = valueIndex.get(val) ?? 0;
    // Higher pitch = higher on screen → invert the slot index.
    const slot = slotCount - 1 - idx;
    return noteAreaY + (slot / slotCount) * noteAreaH;
  };

  // Reset hit map for this frame.
  state.hits.length = 0;

  // Track which row values have a currently-playing pill so the gutter
  // label loop (drawn after the clip block) can wash matching rows.
  const activeValues = new Set();

  for (const item of visibleHaps) {
    const { hap, begin, end, val } = item;
    if (val == null) continue; // truly empty haps have nowhere to land

    const xRaw = timeToX(begin);
    const wRaw = timeToX(end) - xRaw;
    const yRaw = valueToY(val);

    const x = Math.round(xRaw) + 0.5;
    const y = Math.round(yRaw) + 0.5;
    const pillW = Math.max(2, Math.round(wRaw) - 1);

    const label = getLabelForHap(hap, labels);
    const color = label
      ? PALETTE[labels.indexOf(label) % PALETTE.length]
      : colorForKey(state, getGroupKey(hap));
    const isActive = hap.whole.begin <= time && hap.endClipped > time;
    if (isActive) activeValues.add(val);
    const { velocity = 1, gain = 1 } = hap.value || {};
    const dynAlpha = Math.min(1, velocity * gain); // clamp — gain can exceed 1
    drawNotePill(ctx, x, y, pillW, pillH, color, isActive, dynAlpha);

    const loc = getFirstLocation(hap);
    if (loc) {
      state.hits.push({
        x: x - 0.5,
        y: y - 0.5,
        w: pillW + 1,
        h: pillH + 1,
        start: loc[0],
        end: loc[1],
      });
    }
  }

  // ── Hover highlight ───────────────────────────────────────────────────
  // Draw a subtle ring around the hovered pill so users know the roll is
  // clickable before they click. Only drawn when the cursor is over a pill.
  if (state.hoveredHit) {
    const hh = state.hoveredHit;
    const r = Math.max(
      0,
      Math.min(PILL_RADIUS + 1, (hh.h + 2) / 2, (hh.w + 2) / 2),
    );
    ctx.globalAlpha = 0.55;
    ctx.strokeStyle = tokens.text;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    if (typeof ctx.roundRect === "function") {
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
  }

  // ── Playhead ─────────────────────────────────────────────────────────
  const px = Math.round(timeToX(time)) + 0.5;
  // Subtle accent glow behind the line.
  const glow = ctx.createLinearGradient(px - 6, 0, px + 6, 0);
  glow.addColorStop(0, "transparent");
  glow.addColorStop(0.5, tokens.accent);
  glow.addColorStop(1, "transparent");
  ctx.globalAlpha = 0.18;
  ctx.fillStyle = glow;
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
  ctx.font = `500 ${gutterFontSize}px ${tokens.fontMono}`;
  ctx.textBaseline = "middle";
  ctx.textAlign = "right";
  ctx.globalAlpha = 1;

  for (let i = 0; i < uniqueValues.length; i++) {
    const val = uniqueValues[i];
    const y = valueToY(val);
    const cy = y + rowH / 2;

    // Faint accent wash behind currently-playing rows so the "bright pill
    // = now" cue extends to the label axis.
    if (activeValues.has(val)) {
      ctx.fillStyle = tokens.accent;
      ctx.globalAlpha = 0.12;
      ctx.fillRect(0, y, LEFT_GUTTER_W, rowH);
      ctx.globalAlpha = 1;
    }

    const label =
      typeof val === "number"
        ? midi2note(Math.round(val)) // 60 → "C4", 69 → "A4"
        : String(val).replace(/^_/, ""); // "_bd" → "bd"

    ctx.fillStyle = tokens.textDim;
    ctx.fillText(label, LEFT_GUTTER_W - 4, cy);
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

function drawNotePill(ctx, x, y, w, h, color, isActive, dynAlpha = 1) {
  const r = Math.max(0, Math.min(PILL_RADIUS, h / 2, w / 2));
  ctx.beginPath();
  if (typeof ctx.roundRect === "function") {
    ctx.roundRect(x, y, w, h, r);
  } else {
    // Defensive fallback — every modern target supports roundRect, but
    // failing back to a sharp rect is preferable to throwing.
    ctx.rect(x, y, w, h);
  }
  ctx.globalAlpha = (isActive ? 0.92 : 0.35) * dynAlpha;
  ctx.fillStyle = color;
  ctx.fill();
  ctx.globalAlpha = (isActive ? 1.0 : 0.5) * dynAlpha;
  ctx.strokeStyle = color;
  ctx.lineWidth = 1;
  ctx.stroke();

  // Active pill: subtle bright top-edge highlight to reinforce "playing now"
  // beyond the opacity change alone. Thin white line across the top of the
  // pill, low opacity so it reads as a sheen, not an outline.
  if (isActive && h >= 4 && w >= 4) {
    ctx.globalAlpha = 0.35 * dynAlpha;
    ctx.strokeStyle = "#fff";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x + r, y + 0.5);
    ctx.lineTo(x + w - r, y + 0.5);
    ctx.stroke();
  }
}

// Hit-test helper shared by click and mousemove. Returns the matched hit
// entry or null.
function hitTest(state, cx, cy) {
  for (let i = state.hits.length - 1; i >= 0; i--) {
    const hit = state.hits[i];
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
    const view = state.view;
    if (!view) return;
    const rect = canvas.getBoundingClientRect();
    const hit = hitTest(state, e.clientX - rect.left, e.clientY - rect.top);
    if (!hit) return;
    try {
      view.dispatch({
        selection: { anchor: hit.start, head: hit.end },
        scrollIntoView: true,
      });
      view.focus?.();
    } catch (err) {
      console.warn("[strasbeat/piano-roll] dispatch failed:", err);
      // Visual flash so the user knows the click didn't just vanish.
      state.errorFlashUntil = performance.now() + 400;
    }
  });

  // Mousemove → cursor affordance + hover highlight for clickable pills.
  canvas.addEventListener("mousemove", (e) => {
    const rect = canvas.getBoundingClientRect();
    const hit = hitTest(state, e.clientX - rect.left, e.clientY - rect.top);
    state.hoveredHit = hit;
    canvas.style.cursor = hit ? "pointer" : "";
  });

  canvas.addEventListener("mouseleave", () => {
    state.hoveredHit = null;
    canvas.style.cursor = "";
  });
}
