import { isExportRunning } from "./export.js";

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
export async function previewSoundName(name, ctx, opts = {}) {
  const { getAudioContext, getSound, superdough, setStatus } = ctx;
  // While an export renders, the audio context is the offline one being
  // rendered: an audition would be written into the WAV.
  if (isExportRunning()) {
    setStatus("Export in progress — preview again when it finishes");
    return;
  }
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
  // With a bank, superdough plays `${bank}_${name}` — that is the name that
  // has to be registered, not the bare suffix (`bd` under RolandTR909 is
  // RolandTR909_bd; many bank sounds have no standalone counterpart).
  const resolvedName = opts.bank ? `${opts.bank}_${name}` : name;
  if (!getSound(resolvedName)) {
    console.warn(
      `[strasbeat/sound-browser] sound "${resolvedName}" is not loaded`,
    );
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
  // Phase 3: variant + bank context for sample-variant auditions.
  // `n` selects the sample index inside a kit-style sound; `bank` rewrites
  // the sound name as `${bank}_${name}` upstream of superdough.
  if (opts.n != null) value.n = opts.n;
  if (opts.bank) value.bank = opts.bank;
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

// The user pattern "Try" opens examples in. Examples never land in whatever
// pattern happens to be open: every buffer autosaves, so replacing it would
// overwrite the user's work a second later.
export const SCRATCH_PATTERN_NAME = "try-example";
const LAST_EXAMPLE_KEY = "strasbeat:try-example-code";

function readLastExample() {
  try {
    return localStorage.getItem(LAST_EXAMPLE_KEY);
  } catch {
    return null;
  }
}

function writeLastExample(code) {
  try {
    localStorage.setItem(LAST_EXAMPLE_KEY, code);
  } catch {
    /* storage unavailable — the next Try just asks before replacing */
  }
}

/**
 * Try a Learn / Reference example: put it in the scratch pattern, bring
 * that pattern to the front and play it. The pattern the user was working
 * on is left exactly as it was.
 *
 * The scratch pattern is reused from one Try to the next. If the user
 * edited it in between (its code is no longer the last example loaded),
 * they're asked before those edits are replaced.
 *
 * `ctx.scratch` is the host's access to that pattern:
 *   - name:               pattern name (defaults to SCRATCH_PATTERN_NAME)
 *   - read(name):         stored code, or null when the pattern doesn't exist
 *   - write(name, code):  replace the stored code of an existing pattern
 *   - create(name, code): create the pattern and open it; resolves { ok }
 *   - open(name):         open or focus the pattern's tab
 *
 * Resolves true when the example was loaded, false when the user declined.
 */
export async function tryReferenceExample(code, ctx) {
  const { editor, getCurrentName, confirm, scratch } = ctx;
  const name = scratch.name ?? SCRATCH_PATTERN_NAME;
  const isActive = getCurrentName() === name;
  const existing = isActive ? (editor.code ?? "") : scratch.read(name);

  const hasUserEdits =
    existing != null &&
    existing.trim() !== "" &&
    existing !== code &&
    existing !== readLastExample();
  if (hasUserEdits) {
    const ok = await confirm({
      title: `Replace the contents of "${name}"?`,
      message:
        `Examples open in the scratch pattern "${name}", and it has changed ` +
        "since the last example was loaded. Replacing it discards those " +
        "edits. Your other patterns aren't touched.",
      confirmLabel: "Replace",
      cancelLabel: "Keep my edits",
      destructive: true,
    });
    if (!ok) return false;
  }

  if (isActive) {
    editor.setCode(code);
  } else if (existing != null) {
    scratch.write(name, code);
    scratch.open(name);
  } else {
    const result = await scratch.create(name, code);
    if (!result?.ok) {
      throw new Error(
        `couldn't create "${name}": ${result?.error ?? "unknown error"}`,
      );
    }
  }
  writeLastExample(code);

  // Start playback, but don't make the caller wait for it: the example is
  // loaded at this point, and a first evaluate can sit on sample loading
  // for seconds.
  const onEvalError = (err) =>
    console.warn("[strasbeat/reference-panel] try evaluate failed:", err);
  try {
    Promise.resolve(editor.evaluate()).catch(onEvalError);
  } catch (err) {
    onEvalError(err);
  }
  return true;
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
