// .piano() — the Pattern method strudel.cc's REPL defines next to its piano
// sample map (upstream website/src/repl/prebake.mjs). It lives in the REPL
// rather than in a published package, so pasted snippets that call it need
// it defined here. The `piano` samples themselves are registered at boot
// (src/default-samples.js).

import { Pattern, noteToMidi, valueToMidi } from "@strudel/core";

const maxPan = noteToMidi("C8");
const panwidth = (pan, width) => pan * width + (1 - width) / 2;

/**
 * Plays the pattern on the sampled grand piano: selects the `piano` sound,
 * holds each note for its full step (`clip(1)` unless clip is already set),
 * adds a short release, and pans by pitch — low notes to the left, high notes
 * to the right, like sitting at the keyboard.
 *
 * @name piano
 * @example
 * note("c3 e3 g3 <b3 c4>").piano()
 * @example
 * n("0 2 4 <6 7>").scale("C4:minor").piano().room(0.3)
 */
Pattern.prototype.piano = function () {
  return this.fmap((v) => ({ ...v, clip: v.clip ?? 1 }))
    .s("piano")
    .release(0.1)
    .fmap((value) => {
      const midi = valueToMidi(value);
      const pan = panwidth(Math.min(Math.round(midi) / maxPan, 1), 0.5);
      return { ...value, pan: (value.pan || 1) * pan };
    });
};
