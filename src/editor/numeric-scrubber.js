// Inline numeric scrubber — Figma-style drag-to-change for numeric literals.
//
// Every numeric literal that's a *direct argument* to a function call becomes
// draggable: click-and-drag horizontally to change the value, hear the pattern
// re-evaluate in real time. The drag affordance is a 1px-wide invisible hit
// zone immediately to the right of the literal so clicking the literal text
// itself still places a cursor for type-editing (per design/work/03-numeric-
// scrubber.md).
//
// Implementation notes:
//
//   • AST, not regex. We walk syntaxTree(view.state) for `Number` nodes and
//     only decorate those whose immediate parent is `ArgList` of a
//     `CallExpression`. That's how we correctly skip:
//       – Numbers inside strings (mini-notation `"0 1 2 3"`)
//       – Numbers inside template literals
//       – Numbers inside comments
//       – Numbers inside arithmetic like `setcps(160/60/4)` (parent is
//         BinaryExpression, not ArgList — dragging would corrupt the formula).
//     The Lezer JS grammar parses string/comment/template-literal contents as
//     opaque tokens, so Number nodes never appear inside them in the first
//     place — the ArgList check is what excludes the BinaryExpression case.
//
//   • Leading unary minus is included: `gain(-0.5)` decorates the whole
//     `-0.5` so the scrub can step through zero.
//
//   • Drag dispatches are debounced to one per animation frame (rAF). Each
//     dispatch carries `userEvent: 'input.type.scrub'` — the `input.type`
//     prefix is what the @codemirror/commands history extension matches when
//     deciding whether to *join* adjacent transactions into a single undo
//     entry. So one drag = one Mod-z.
//
//   • The `evaluate` callback is called after every dispatch so the audio
//     responds in real time. We use the underlying repl.evaluate (skipping
//     StrudelMirror.evaluate) to avoid the visual flash that would otherwise
//     fire 60 times per second during a drag.
//
//   • The "active" overlay (chip + accent color on the dragged literal) is a
//     StateField. The base decorations (mark + handle widget) come from the
//     ViewPlugin. They're independent so the active overlay can update
//     without rebuilding the full decoration set.

import { syntaxTree } from '@codemirror/language';
import { StateEffect, StateField } from '@codemirror/state';
import {
  Decoration,
  EditorView,
  ViewPlugin,
  WidgetType,
} from '@codemirror/view';

// ─── Drag-handle widget (the invisible hit zone) ─────────────────────────

class HandleWidget extends WidgetType {
  constructor(from, to, value, isInteger) {
    super();
    this.from = from;
    this.to = to;
    this.value = value;
    this.isInteger = isInteger;
  }
  // CM6 reuses widget DOM nodes when eq() returns true. Compare the data
  // we serialise into the DOM so the node is recycled when nothing changed.
  eq(other) {
    return (
      other instanceof HandleWidget &&
      other.from === this.from &&
      other.to === this.to &&
      other.value === this.value &&
      other.isInteger === this.isInteger
    );
  }
  toDOM() {
    const el = document.createElement('span');
    el.className = 'cm-scrub-handle';
    // Stash the literal range + value as data attrs so the delegated
    // pointerdown handler can read them without bookkeeping per-widget JS
    // state. The handle widget gets recreated on every doc update; storing
    // the truth in the DOM means we don't have to thread state through.
    el.dataset.from = String(this.from);
    el.dataset.to = String(this.to);
    el.dataset.value = String(this.value);
    el.dataset.integer = this.isInteger ? '1' : '0';
    return el;
  }
  ignoreEvent() {
    // We *want* pointer events on this widget — that's its whole job.
    return false;
  }
}

// ─── Chip widget (the floating value readout shown during drag) ─────────

class ChipWidget extends WidgetType {
  constructor(text) {
    super();
    this.text = text;
  }
  eq(other) {
    return other instanceof ChipWidget && other.text === this.text;
  }
  toDOM() {
    // Outer span has `width: 0` so it takes no inline space; the inner
    // pop-out is absolutely positioned above the literal. CSS in
    // src/styles/scrubber.css.
    const wrap = document.createElement('span');
    wrap.className = 'cm-scrub-chip';
    const inner = document.createElement('span');
    inner.className = 'cm-scrub-chip__inner';
    inner.textContent = this.text;
    wrap.appendChild(inner);
    return wrap;
  }
  ignoreEvent() {
    return true;
  }
}

// ─── Active-drag StateField ──────────────────────────────────────────────
//
// Holds `{ from, to, text } | null`. When non-null, contributes a mark
// (accent colour on the literal) and a chip widget (live value readout).
// `null` is the resting state.

const setActive = StateEffect.define();

const activeField = StateField.define({
  create() {
    return null;
  },
  update(value, tr) {
    let next = value;
    // Keep our positions in sync with any external doc edits that happen
    // during a drag. Our own scrub dispatch carries a setActive effect with
    // the new positions, which overrides the mapping below — so this only
    // matters when somebody else mutates the doc mid-drag.
    if (next && tr.docChanged) {
      const from = tr.changes.mapPos(next.from, -1);
      const to = tr.changes.mapPos(next.to, 1);
      if (from < to) next = { ...next, from, to };
      else next = null;
    }
    for (const e of tr.effects) {
      if (e.is(setActive)) next = e.value;
    }
    return next;
  },
  provide: (f) =>
    EditorView.decorations.from(f, (state) => {
      if (!state) return Decoration.none;
      return Decoration.set(
        [
          Decoration.widget({
            widget: new ChipWidget(state.text),
            side: -1,
          }).range(state.from),
          Decoration.mark({ class: 'cm-scrub-literal-active' }).range(
            state.from,
            state.to,
          ),
        ],
        true,
      );
    }),
});

// ─── AST walk: which literals deserve a scrubber? ────────────────────────

function buildBaseDecorations(view) {
  const items = [];
  for (const { from, to } of view.visibleRanges) {
    syntaxTree(view.state).iterate({
      from,
      to,
      enter(node) {
        if (node.name !== 'Number') return;

        let literalFrom = node.from;
        let literalTo = node.to;
        let parent = node.node.parent;

        // Allow leading unary minus (`gain(-0.5)`). Only when the operator
        // is `-` — `+0.5` has no semantic effect and isn't worth special-
        // casing. We expand the decoration to cover the whole UnaryExpression
        // so the drag math sees -0.5 as the start value, not 0.5.
        if (parent && parent.name === 'UnaryExpression') {
          const opText = view.state.doc
            .sliceString(parent.from, node.from)
            .trim();
          if (opText !== '-') return;
          literalFrom = parent.from;
          literalTo = parent.to;
          parent = parent.parent;
        }

        // Direct argument check: parent must be ArgList AND grandparent must
        // be CallExpression. This is what excludes nested arithmetic
        // (parent = BinaryExpression), array literals (parent =
        // ArrayExpression), object values (parent = Property), bare
        // statements, etc.
        if (!parent || parent.name !== 'ArgList') return;
        if (!parent.parent || parent.parent.name !== 'CallExpression') return;

        const text = view.state.doc.sliceString(literalFrom, literalTo);
        const num = Number(text);
        if (!Number.isFinite(num)) return;
        // "Integer" for our purposes means "no decimal point and no
        // exponent" — i.e. the literal as written looks like an int. We
        // preserve that distinction in the output format unless the user
        // explicitly opts into fractional steps via shift-drag.
        const isInteger = !text.includes('.') && !/[eE]/.test(text);

        items.push(
          Decoration.mark({ class: 'cm-scrub-literal' }).range(
            literalFrom,
            literalTo,
          ),
        );
        items.push(
          Decoration.widget({
            widget: new HandleWidget(literalFrom, literalTo, num, isInteger),
            // side: 1 → place the widget *after* the literal in DOM order
            // so the hit zone sits to the right of the number, leaving
            // click-on-the-literal free to position a cursor.
            side: 1,
          }).range(literalTo),
        );
      },
    });
  }
  return Decoration.set(items, true);
}

// ─── Drag math ───────────────────────────────────────────────────────────
//
// Three modes per design/work/03-numeric-scrubber.md:
//   default        ~1%/px (floats) or +1/px (integers), snap 1 decimal
//   shift  (fine)  ~0.1%/px (floats) or +0.1/px (integers), snap 3 decimals
//   meta  (coarse) ~10%/px (floats) or +10/px (integers), snap to int >1 / 0.05

function modeFromEvent(e) {
  if (e.shiftKey) return 'fine';
  if (e.metaKey || e.ctrlKey) return 'coarse';
  return 'default';
}

function computeNewValue(startVal, dx, mode, isInteger) {
  if (isInteger) {
    const ratePerPx = mode === 'fine' ? 0.1 : mode === 'coarse' ? 10 : 1;
    return startVal + dx * ratePerPx;
  }
  // Floats: scale step by current magnitude so dragging a 0.5 has the same
  // *feel* as dragging a 50. The `base = 1 when 0` fallback prevents the
  // "stuck at zero" trap (`0 * anything = 0`) so a literal `gain(0)` can
  // still be dragged up.
  const factorPerPx =
    mode === 'fine' ? 0.001 : mode === 'coarse' ? 0.1 : 0.01;
  const base = Math.abs(startVal) > 0 ? Math.abs(startVal) : 1;
  return startVal + dx * factorPerPx * base;
}

function snapAndFormat(val, mode, isInteger) {
  if (!Number.isFinite(val)) val = 0;
  if (mode === 'coarse') {
    // Big-step mode. >1 → integer; otherwise 0.05 step (gain/room/delay
    // territory) so coarse drags still land on usable values.
    if (Math.abs(val) > 1) return String(Math.round(val));
    return (Math.round(val * 20) / 20).toFixed(2);
  }
  if (mode === 'fine') {
    // Fine mode: 3 decimals so the chip gives sub-millisecond control over
    // gains and times. Integer literals get a softer 1-decimal step so
    // shift-drag on `fast(4)` reads 4.0 → 4.1 → 4.2, not 4.000 → 4.100.
    if (isInteger) {
      const snapped = Math.round(val * 10) / 10;
      return Number.isInteger(snapped) ? String(snapped) : snapped.toFixed(1);
    }
    return (Math.round(val * 1000) / 1000).toFixed(3);
  }
  // default mode
  if (isInteger) return String(Math.round(val));
  return (Math.round(val * 10) / 10).toFixed(1);
}

// ─── ViewPlugin: walks the tree, attaches drag handlers ─────────────────

const DRAG_THRESHOLD_PX = 2; // Below this, treat as a click — see acceptance
                             // criterion "click without drag does NOT change
                             // the value".

function makeScrubberPlugin({ evaluate }) {
  return ViewPlugin.fromClass(
    class {
      constructor(view) {
        this.view = view;
        this.decorations = buildBaseDecorations(view);
        this.drag = null;
        this.rafId = null;

        this.handlePointerDown = this.handlePointerDown.bind(this);
        this.handlePointerMove = this.handlePointerMove.bind(this);
        this.handlePointerUp = this.handlePointerUp.bind(this);

        view.dom.addEventListener('pointerdown', this.handlePointerDown);
      }

      update(update) {
        // Map active drag positions through external changes (other CM
        // extensions, programmatic edits). Our own scrub dispatches arrive
        // here too — we explicitly fix `this.drag.to` after dispatching,
        // and the setActive effect on the same transaction overrides the
        // StateField mapping, so the explicit values always win.
        //
        // If the literal is gone (deleted by an external edit) we drop the
        // drag JS state but DON'T dispatch from here — CM6 disallows
        // dispatching during update, and the activeField StateField does
        // its own mapping and clears itself when its range collapses.
        if (this.drag && update.docChanged) {
          const from = update.changes.mapPos(this.drag.from, -1);
          const to = update.changes.mapPos(this.drag.to, 1);
          if (from < to) {
            this.drag.from = from;
            this.drag.to = to;
          } else {
            this.cleanupDrag();
          }
        }
        if (update.docChanged || update.viewportChanged) {
          this.decorations = buildBaseDecorations(update.view);
        }
      }

      destroy() {
        this.view.dom.removeEventListener('pointerdown', this.handlePointerDown);
        this.removeWindowListeners();
        if (this.rafId != null) cancelAnimationFrame(this.rafId);
      }

      removeWindowListeners() {
        window.removeEventListener('pointermove', this.handlePointerMove);
        window.removeEventListener('pointerup', this.handlePointerUp);
        window.removeEventListener('pointercancel', this.handlePointerUp);
      }

      handlePointerDown(e) {
        if (e.button !== 0) return; // left mouse only
        const handle = e.target?.closest?.('.cm-scrub-handle');
        if (!handle) return;
        // Block CM6 from interpreting this as a text selection click.
        e.preventDefault();
        e.stopPropagation();

        const from = Number(handle.dataset.from);
        const to = Number(handle.dataset.to);
        const startVal = Number(handle.dataset.value);
        if (!Number.isFinite(startVal) || !Number.isFinite(from) || !Number.isFinite(to)) {
          return;
        }
        this.drag = {
          from,
          to,
          startVal,
          startX: e.clientX,
          isInteger: handle.dataset.integer === '1',
          moved: false,
          mode: 'default',
          pendingText: null,
          pointerId: e.pointerId,
        };
        window.addEventListener('pointermove', this.handlePointerMove);
        window.addEventListener('pointerup', this.handlePointerUp);
        window.addEventListener('pointercancel', this.handlePointerUp);
      }

      handlePointerMove(e) {
        if (!this.drag) return;
        const dx = e.clientX - this.drag.startX;
        // Threshold gate: don't commit anything until the user has actually
        // dragged. A click that never moves leaves the doc untouched.
        if (!this.drag.moved && Math.abs(dx) < DRAG_THRESHOLD_PX) return;
        if (!this.drag.moved) {
          this.drag.moved = true;
          document.body.style.cursor = 'ew-resize';
          document.body.classList.add('cm-scrub-dragging');
        }

        const mode = modeFromEvent(e);
        this.drag.mode = mode;
        const newVal = computeNewValue(
          this.drag.startVal,
          dx,
          mode,
          this.drag.isInteger,
        );
        this.drag.pendingText = snapAndFormat(newVal, mode, this.drag.isInteger);

        // Coalesce multiple move events into one rAF tick. The pendingText
        // is overwritten on every move, so when rAF fires we always flush
        // the *latest* value — older intermediate values are dropped.
        if (this.rafId != null) return;
        this.rafId = requestAnimationFrame(() => {
          this.rafId = null;
          this.flushDrag(false);
        });
      }

      // `finalize=false` (the per-frame call) sets the active overlay to
      // the new value. `finalize=true` (the pointer-up call) sets it to
      // null in the same dispatch — one transaction tears down the chip
      // *and* commits the final value, so the user never sees a flicker
      // between "still scrubbing" and "drag is over".
      flushDrag(finalize) {
        if (!this.drag) return;
        const { from, to, pendingText } = this.drag;
        if (pendingText == null) {
          if (finalize) {
            this.view.dispatch({
              effects: setActive.of(null),
              scrollIntoView: false,
            });
          }
          return;
        }
        const current = this.view.state.doc.sliceString(from, to);
        const newTo = from + pendingText.length;
        const activeValue = finalize
          ? null
          : { from, to: newTo, text: pendingText };
        const effects = [setActive.of(activeValue)];
        if (current === pendingText) {
          // Snap landed on the same text we already have — keep the chip
          // in sync (or clear it on finalize) but don't churn the doc.
          this.view.dispatch({ effects, scrollIntoView: false });
          return;
        }
        this.view.dispatch({
          changes: { from, to, insert: pendingText },
          effects,
          // 'input.type.*' is the prefix the history extension recognises
          // for transaction joining — adjacent scrub dispatches collapse
          // into a single undo entry, satisfying "one drag = one undo step".
          userEvent: 'input.type.scrub',
          scrollIntoView: false,
        });
        this.drag.to = newTo;

        // Trigger an audio re-eval. We deliberately don't await: the next
        // rAF can supersede this one even if Strudel hasn't finished
        // processing yet, and Strudel's repl handles the overlap fine.
        if (typeof evaluate === 'function') {
          try {
            const ret = evaluate();
            if (ret && typeof ret.catch === 'function') {
              ret.catch((err) =>
                console.warn('[scrubber] eval rejected:', err),
              );
            }
          } catch (err) {
            console.warn('[scrubber] eval threw:', err);
          }
        }
      }

      handlePointerUp() {
        if (!this.drag) return;
        // Cancel any pending rAF — we're about to do a final synchronous
        // flush so the literal lands exactly where the user released.
        if (this.rafId != null) {
          cancelAnimationFrame(this.rafId);
          this.rafId = null;
        }
        if (this.drag.moved) {
          this.flushDrag(true);
        }
        this.cleanupDrag();
      }

      // JS-only teardown — safe to call from anywhere, including a
      // ViewPlugin update method (no view.dispatch). Use flushDrag(true)
      // first if you also need to push out a final transaction.
      cleanupDrag() {
        this.removeWindowListeners();
        if (this.rafId != null) {
          cancelAnimationFrame(this.rafId);
          this.rafId = null;
        }
        document.body.style.cursor = '';
        document.body.classList.remove('cm-scrub-dragging');
        this.drag = null;
      }
    },
    {
      decorations: (v) => v.decorations,
    },
  );
}

// ─── Public extension factory ────────────────────────────────────────────

/**
 * Build the inline numeric scrubber as a CodeMirror 6 extension.
 *
 * @param {object} [options]
 * @param {() => unknown} [options.evaluate] - Called after every committed
 *   scrub change so the audio can re-evaluate. Pass a thin wrapper around
 *   the underlying repl evaluate (skipping any visual flash) — the scrubber
 *   may call this up to once per animation frame.
 * @returns {import('@codemirror/state').Extension[]}
 */
export function numericScrubber({ evaluate } = {}) {
  return [makeScrubberPlugin({ evaluate }), activeField];
}
