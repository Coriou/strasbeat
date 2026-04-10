// DOM track bar: a persistent strip between the transport and the piano roll
// that shows per-track labels with click-to-mute and shift+click-to-solo.
//
// Mounted once from main.js after the editor is fully set up:
//
//   mountTrackBar({ container, view, onEvaluate })
//
// The strip auto-hides (via container.hidden) when the pattern has no named
// labels, causing the auto-sized grid row to collapse to 0 height. It
// reappears as soon as labels are detected on the next doc change.
//
// Palette color assignment uses the label's index in source order
// (PALETTE[i % 10]), which matches the insertion-order behavior of the piano
// roll's colorForKey Map when labels are not reordered mid-session.

import { StateEffect } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { parseLabels, toggleMute, toggleSolo } from '../editor/track-labels.js';
import { computeNewSelection } from '../editor/format.js';
import { PALETTE } from './palette.js';

export function mountTrackBar({ container, view, onEvaluate }) {
  function rebuild() {
    const code = view.state.doc.toString();
    const labels = parseLabels(code);

    // Clear previous children without innerHTML to avoid unnecessary reflow.
    while (container.firstChild) container.removeChild(container.firstChild);

    if (labels.length === 0) {
      container.hidden = true;
      return;
    }

    container.hidden = false;

    for (let i = 0; i < labels.length; i++) {
      const label = labels[i];
      const color = PALETTE[i % PALETTE.length];
      const displayName = label.displayName;

      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'track-bar__entry';
      if (label.muted) btn.classList.add('track-bar__entry--muted');
      if (label.soloed) btn.classList.add('track-bar__entry--soloed');
      btn.title = label.muted
        ? `${displayName} (muted) — click to unmute, Shift+click to solo`
        : `${displayName} — click to mute, Shift+click to solo`;

      const dot = document.createElement('span');
      dot.className = 'track-bar__dot';
      dot.style.backgroundColor = color;
      dot.setAttribute('aria-hidden', 'true');

      const labelEl = document.createElement('span');
      labelEl.className = 'track-bar__label';
      labelEl.textContent = displayName;

      btn.appendChild(dot);
      btn.appendChild(labelEl);

      btn.addEventListener('click', (e) => {
        const currentCode = view.state.doc.toString();
        const oldSelection = view.state.selection;
        const oldDoc = view.state.doc;
        const toggle = e.shiftKey ? toggleSolo : toggleMute;
        const userEvent = e.shiftKey ? 'input.track-solo' : 'input.track-mute';
        const nextCode = toggle(currentCode, displayName);
        if (nextCode === currentCode) return;
        try {
          view.dispatch({
            changes: { from: 0, to: currentCode.length, insert: nextCode },
            selection: computeNewSelection(oldSelection, oldDoc, nextCode),
            userEvent,
          });
          view.focus?.();
          onEvaluate?.();
        } catch (err) {
          console.warn('[strasbeat/track-bar] toggle failed:', err);
        }
      });

      container.appendChild(btn);
    }
  }

  // Initial render from whatever is already in the editor.
  rebuild();

  // Re-render whenever the doc changes: mute/solo toggles, pattern loads, edits.
  view.dispatch({
    effects: StateEffect.appendConfig.of(
      EditorView.updateListener.of((update) => {
        if (update.docChanged) rebuild();
      }),
    ),
  });
}
