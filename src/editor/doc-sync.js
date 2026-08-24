// One doc-change signal for every view that renders the buffer.
//
// WHY THIS EXISTS (design/work/27 BUG-2). The bottom bars — track bar, arrange
// bar, beat grid — each used to install their own updateListener from their
// mount function via `StateEffect.appendConfig`. That happens *after* main.js
// captures `cleanBaseState`, the boot-time EditorState every fresh tab is
// derived from (see build-editor-state.js). Config appended to the live state
// is not in the clean base, so those three listeners existed in exactly one
// tab's config and were dead in every other one — measured 8 listeners in the
// tab that was live at mount time, 5 in every tab opened afterwards. The
// user-visible result was a track bar showing the previous tab's tracks, whose
// buttons were dead no-ops (or worse: toggled the wrong track when the two
// patterns happened to share a name).
//
// The fix is to stop putting per-mount listeners in CodeMirror's config at all.
// `sync.extension` goes into the editor's base config once, before the clean
// base is captured, so it is present in every state that will ever exist. The
// subscriber list lives in this closure — plain JS, not CM config — so mounts
// can register at any later point and still be reached from every tab.
//
// The second half of BUG-2: `view.setState()` (the tab swap) does not fire
// updateListeners *at all*, so the swap path has to call `notify()` itself.
// That call passes `immediate: true` — a swap must repaint before the user's
// next click, whereas an ordinary keystroke can coalesce into the next frame.

import { EditorView } from "@codemirror/view";

/**
 * @returns {{
 *   subscribe: (fn: (opts: { immediate: boolean }) => void) => () => void,
 *   notify: (opts?: { immediate?: boolean }) => void,
 *   extension: import("@codemirror/state").Extension,
 * }}
 */
export function createDocSync() {
  const subscribers = new Set();

  function subscribe(fn) {
    subscribers.add(fn);
    return () => subscribers.delete(fn);
  }

  // Iterate a copy so a subscriber that subscribes/unsubscribes during the fan-
  // out can't disturb this pass, and isolate throws: one bar failing on a
  // malformed buffer must not take the other two offline for the session.
  function notify({ immediate = false } = {}) {
    for (const fn of [...subscribers]) {
      try {
        fn({ immediate });
      } catch (err) {
        console.warn("[strasbeat/doc-sync] subscriber failed:", err);
      }
    }
  }

  const extension = EditorView.updateListener.of((update) => {
    if (update.docChanged) notify();
  });

  return { subscribe, notify, extension };
}
