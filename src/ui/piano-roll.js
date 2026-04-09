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

import { noteToMidi, freqToMidi } from '@strudel/core';

// Ten-step palette of muted, distinguishable hues that read against
// `--surface-1`. Hand-tuned in OKLCH at uniform L=0.70 / C≈0.13 so no
// single color screams louder than its neighbours; the rose at the start
// matches the default `--accent` hue (358) so the primary layer feels
// continuous with the rest of the chrome. Not derived from `--accent` at
// runtime: an accent override is one user signature, this palette is ten.
const PALETTE = [
  'oklch(0.70 0.16 358)', // rose (default accent hue)
  'oklch(0.70 0.13 28)',  // coral
  'oklch(0.70 0.12 58)',  // amber
  'oklch(0.70 0.12 98)',  // olive
  'oklch(0.70 0.13 138)', // sage
  'oklch(0.70 0.13 178)', // teal
  'oklch(0.70 0.13 218)', // sky
  'oklch(0.70 0.13 258)', // indigo
  'oklch(0.70 0.13 298)', // lavender
  'oklch(0.70 0.13 328)', // mauve
];

// strasbeat patterns assume 4 beats / cycle (matches transport.js's
// BEATS_PER_CYCLE — see the note there for why this is a project-wide
// convention rather than something Strudel tracks).
const BEATS_PER_CYCLE = 4;
const BOTTOM_LABEL_H = 14;   // reserved strip at the bottom for cycle labels
const PILL_RADIUS = 3;       // ≈ --radius-sm minus a hair so corners stay crisp
const MIN_PX_PER_BEAT = 8;   // hide beat lines below this density

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
      clickBound: false,
      // First-sight → palette index. Persistent across frames so a layer's
      // color never re-flips when other layers appear or disappear.
      colorForKey: new Map(),
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
  if (typeof value !== 'object') {
    value = { value };
  }
  let { note, n, freq, s } = value;
  if (freq) {
    return freqToMidi(freq);
  }
  note = note ?? n;
  if (typeof note === 'string') {
    try {
      return noteToMidi(note);
    } catch {
      return 0;
    }
  }
  if (typeof note === 'number') {
    return note;
  }
  if (s) {
    return '_' + s;
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
    if (first && typeof first.start === 'number') return `loc:${first.start}`;
  }
  const v = hap?.value;
  if (v && typeof v === 'object') {
    if (typeof v.s === 'string') return `s:${v.s}`;
    if (v.note != null) return `note:${v.note}`;
  }
  return 'default';
}

// Returns the [start, end] char range of the first location, or null. Used
// for click-to-locate; missing locs → no hit registered for that note.
function getFirstLocation(hap) {
  const locs = hap?.context?.locations;
  if (Array.isArray(locs) && locs.length > 0) {
    const first = locs[0];
    if (first && typeof first.start === 'number' && typeof first.end === 'number') {
      return [first.start, first.end];
    }
  }
  return null;
}

// Read design-token values off the canvas's computed style each frame so
// any user override of `--accent` / `--surface-1` / etc. flows through
// without a renderer rebuild.
function readTokens(canvas) {
  const cs = getComputedStyle(canvas);
  const get = (name, fallback) => {
    const v = cs.getPropertyValue(name).trim();
    return v || fallback;
  };
  return {
    bg:         get('--surface-1', '#1f1f1f'),
    border:     get('--border', '#4d4d4d'),
    borderSoft: get('--border-soft', '#2e2e2e'),
    accent:     get('--accent', '#cf418d'),
    textDim:    get('--text-dim', '#666'),
    fontSans:   get('--font-sans', 'system-ui, sans-serif'),
    textXs:     get('--text-xs', '11px'),
  };
}

function colorForKey(state, key) {
  const map = state.colorForKey;
  if (!map.has(key)) {
    map.set(key, PALETTE[map.size % PALETTE.length]);
  }
  return map.get(key);
}

export function renderRoll({ haps, time, ctx, drawTime, view }) {
  const canvas = ctx.canvas;
  const state = ensureState(canvas);
  // Refresh the view ref every frame so the click handler always sees the
  // current EditorView (cheap; the click closure reads from `state`).
  state.view = view ?? state.view;

  if (!state.clickBound) {
    bindClick(canvas, state);
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

  // Reserve a strip at the bottom for cycle labels.
  const noteAreaH = Math.max(0, h - BOTTOM_LABEL_H);
  const timeToX = (t) => ((t - t0) / span) * w;

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
      ctx.moveTo(x, 0);
      ctx.lineTo(x, noteAreaH);
    }
    ctx.stroke();
  }

  // Cycle lines: integer cycles, always drawn (heavier).
  ctx.strokeStyle = tokens.border;
  ctx.beginPath();
  const firstCycle = Math.ceil(t0);
  for (let c = firstCycle; c <= t1 + 1e-9; c += 1) {
    const x = Math.round(timeToX(c)) + 0.5;
    ctx.moveTo(x, 0);
    ctx.lineTo(x, noteAreaH);
  }
  ctx.stroke();

  // Cycle labels in the bottom strip.
  const fontSize = parseInt(tokens.textXs, 10) || 11;
  ctx.fillStyle = tokens.textDim;
  ctx.font = `500 ${fontSize}px ${tokens.fontSans}`;
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'left';
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

  // Fold layout: collect all unique values and map each to a slot index.
  // strings (drum sounds) sort first so they anchor at the bottom of the
  // canvas after y-inversion; numbers (pitched notes) sort after, ascending.
  const uniqueValues = [];
  const seenValues = new Set();
  for (const item of visibleHaps) {
    const val = item.val;
    if (val != null && !seenValues.has(val)) {
      seenValues.add(val);
      uniqueValues.push(val);
    }
  }
  uniqueValues.sort((a, b) => {
    if (typeof a === 'number' && typeof b === 'number') return a - b;
    if (typeof a === 'number') return 1;  // numbers sort AFTER strings
    if (typeof b === 'number') return -1; // strings sort BEFORE numbers
    return String(a).localeCompare(String(b));
  });

  const slotCount = Math.max(1, uniqueValues.length);
  const rowH = noteAreaH / slotCount;
  const pillH = Math.max(2, rowH - 2);

  const valueToY = (val) => {
    const idx = uniqueValues.indexOf(val);
    // Higher pitch = higher on screen → invert the slot index.
    const slot = (slotCount - 1) - (idx >= 0 ? idx : 0);
    return (slot / slotCount) * noteAreaH;
  };

  // Reset hit map for this frame.
  state.hits.length = 0;

  for (const item of visibleHaps) {
    const { hap, begin, end, val } = item;
    if (val == null) continue; // truly empty haps have nowhere to land

    const xRaw = timeToX(begin);
    const wRaw = timeToX(end) - xRaw;
    const yRaw = valueToY(val);

    const x = Math.round(xRaw) + 0.5;
    const y = Math.round(yRaw) + 0.5;
    const pillW = Math.max(2, Math.round(wRaw) - 1);

    const color = colorForKey(state, getGroupKey(hap));
    const isActive = hap.whole.begin <= time && hap.endClipped > time;
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

  // ── Playhead ─────────────────────────────────────────────────────────
  const px = Math.round(timeToX(time)) + 0.5;
  // Subtle accent glow behind the line.
  const glow = ctx.createLinearGradient(px - 6, 0, px + 6, 0);
  glow.addColorStop(0, 'transparent');
  glow.addColorStop(0.5, tokens.accent);
  glow.addColorStop(1, 'transparent');
  ctx.globalAlpha = 0.18;
  ctx.fillStyle = glow;
  ctx.fillRect(px - 6, 0, 12, noteAreaH);
  ctx.globalAlpha = 1;
  ctx.strokeStyle = tokens.accent;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(px, 0);
  ctx.lineTo(px, noteAreaH);
  ctx.stroke();
}

function drawNotePill(ctx, x, y, w, h, color, isActive, dynAlpha = 1) {
  const r = Math.max(0, Math.min(PILL_RADIUS, h / 2, w / 2));
  ctx.beginPath();
  if (typeof ctx.roundRect === 'function') {
    ctx.roundRect(x, y, w, h, r);
  } else {
    // Defensive fallback — every modern target supports roundRect, but
    // failing back to a sharp rect is preferable to throwing.
    ctx.rect(x, y, w, h);
  }
  ctx.globalAlpha = (isActive ? 0.9 : 0.35) * dynAlpha;
  ctx.fillStyle = color;
  ctx.fill();
  ctx.globalAlpha = (isActive ? 1.0 : 0.5) * dynAlpha;
  ctx.strokeStyle = color;
  ctx.lineWidth = 1;
  ctx.stroke();
}

function bindClick(canvas, state) {
  canvas.addEventListener('click', (e) => {
    const view = state.view;
    if (!view) return;
    const rect = canvas.getBoundingClientRect();
    const cx = e.clientX - rect.left;
    const cy = e.clientY - rect.top;
    // Iterate from the end so the most recently drawn pill (top z-order)
    // wins ties. O(n) over visible hits is fine — typically a few dozen.
    for (let i = state.hits.length - 1; i >= 0; i--) {
      const hit = state.hits[i];
      if (
        cx >= hit.x &&
        cx <= hit.x + hit.w &&
        cy >= hit.y &&
        cy <= hit.y + hit.h
      ) {
        try {
          view.dispatch({
            selection: { anchor: hit.start, head: hit.end },
            scrollIntoView: true,
          });
          view.focus?.();
        } catch (err) {
          console.warn('[strasbeat/piano-roll] dispatch failed:', err);
        }
        return;
      }
    }
  });
}
