/**
 * Fire a one-shot audition of a sound through the live audio context.
 * Mirrors the MIDI bridge's superdough call shape (src/midi-bridge.js)
 * with a tuned envelope that works for both melodic sounds and one-shots.
 *
 * Unlike the MIDI bridge (which receives MIDI events that aren't user
 * gestures), this is always called from a mousedown handler — a real user
 * gesture. So we can (and must) resume a suspended AudioContext here
 * rather than just bailing out. The upstream initAudioOnFirstClick
 * listener sits on `document` and fires *after* the sound item's handler
 * (event bubbling goes inner → outer), so on the first interaction the
 * context is still suspended when we get here.
 */
export async function previewSoundName(name, ctx) {
  const { getAudioContext, getSound, superdough, setStatus } = ctx;
  const audioCtx = getAudioContext();
  if (!audioCtx) {
    setStatus("no audio context — try reloading the page");
    return;
  }
  // Resume on first user gesture if the context is still suspended.
  if (audioCtx.state === "suspended") {
    try {
      await audioCtx.resume();
    } catch (err) {
      console.warn("[strasbeat/sound-browser] ctx.resume() failed:", err);
    }
  }
  if (audioCtx.state !== "running") {
    setStatus("click the page once to enable audio, then preview again");
    return;
  }
  if (!getSound(name)) {
    console.warn(`[strasbeat/sound-browser] sound "${name}" is not loaded`);
    return;
  }
  const value = {
    s: name,
    note: 60, // middle C — ignored by drum hits, used by melodic sounds
    gain: 0.8,
    attack: 0.005,
    decay: 0.4,
    sustain: 0,
    release: 0.3,
  };
  // 10ms latency cushion — superdough warns and skips events scheduled in
  // the past, same as the MIDI bridge.
  Promise.resolve(
    superdough(value, audioCtx.currentTime + 0.01, 0.5),
  ).catch((err) =>
    console.warn(`[strasbeat/sound-browser] preview "${name}" failed:`, err),
  );
}

/**
 * Insert a sound name into the editor at the cursor. Context-aware: if
 * the cursor sits inside an existing `s("…")` / `sound("…")` literal,
 * we replace just the inner string contents; otherwise we drop a fresh
 * `s("name")` at the cursor (or over the current selection).
 */
export function insertSoundName(name, view) {
  if (!view) return;
  const { state } = view;
  const cursor = state.selection.main.head;
  const doc = state.doc.toString();

  // Detect "cursor inside an s("…") / sound("…") literal":
  //   - look backwards for `s(` or `sound(` followed by a quote and any
  //     non-quote/paren/newline run that ends at the cursor
  //   - look forwards for the matching close quote on the same line
  // If both halves match, replace the entire inner string.
  const before = doc.slice(0, cursor);
  const after = doc.slice(cursor);
  const openMatch = before.match(/\b(?:s|sound)\(\s*(["'])([^"'\n)]*)$/);
  if (openMatch) {
    const quote = openMatch[1];
    const innerSoFar = openMatch[2];
    // Match a same-line run up to the matching close quote.
    const closeRe = new RegExp(`^([^"'\\n)]*)${quote === '"' ? '"' : "'"}`);
    const tail = after.match(closeRe);
    if (tail) {
      const innerStart = cursor - innerSoFar.length;
      const innerEnd = cursor + tail[1].length;
      view.dispatch({
        changes: { from: innerStart, to: innerEnd, insert: name },
        selection: { anchor: innerStart + name.length },
      });
      view.focus();
      return;
    }
  }

  // Fallback: insert a new s("name") call at the cursor (or replace the
  // current selection if there is one).
  const sel = state.selection.main;
  const insert = `s("${name}")`;
  view.dispatch({
    changes: { from: sel.from, to: sel.to, insert },
    selection: { anchor: sel.from + insert.length },
  });
  view.focus();
}

/**
 * Try a reference panel example: replace the editor buffer with the
 * given code and evaluate it. If the buffer differs from the loaded
 * pattern (i.e. has unsaved edits), confirm via the modal system before
 * destroying the user's work.
 */
export async function tryReferenceExample(code, ctx) {
  const { editor, patterns, getCurrentName, confirm } = ctx;
  const currentName = getCurrentName();
  const loaded = patterns[currentName];
  const isDirty = loaded == null || editor.code !== loaded;
  if (isDirty) {
    const ok = await confirm({
      title: "Replace current buffer with example?",
      message: "Unsaved changes will be lost.",
      confirmLabel: "Replace",
      cancelLabel: "Keep editing",
      destructive: true,
    });
    if (!ok) return;
  }
  editor.setCode(code);
  try {
    await editor.evaluate();
  } catch (err) {
    console.warn("[strasbeat/reference-panel] try evaluate failed:", err);
  }
}

/**
 * Insert a function-call template at the editor cursor, placing the
 * caret between the parens. Same dispatch shape as insertSoundName but
 * dumber: no context detection, no replacement of existing content.
 */
export function insertFunctionTemplate(name, template, view) {
  if (!view) return;
  const { state } = view;
  const sel = state.selection.main;
  const cursorOffset = template.indexOf("(") + 1; // between the parens
  view.dispatch({
    changes: { from: sel.from, to: sel.to, insert: template },
    selection: { anchor: sel.from + cursorOffset },
  });
  view.focus();
}
