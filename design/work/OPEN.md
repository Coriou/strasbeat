# Open items

What the November 2026 quality audit left open: work deferred on purpose,
calls only the maintainer can make, and behaviour nobody has yet checked
in a real browser. Lifted from the audit record, which is now in
`archive/28-upgrade-session.md` (about 200 kB: search it for a finding ID
such as `TR-19`, never read it whole). Section numbers such as §3 or §4
below refer to that record; §6, §7 and §8 are the three sections of this
file.

Keep this file current: remove a row when it is done, write the answer on
a `Decision:` line when it is given, tick a box when it has been checked.

Contents: [Deferred](#6-deferred) ·
[Decisions for the maintainer](#7-decisions-for-the-maintainer) ·
[Needs human verification](#8-needs-human-verification)

## 6. Deferred

Items the audits flagged as large or product-level, plus what the four
batches left behind on purpose. Rows that named a later batch and were
then fixed in it have been removed; the status lines in §4 are the record.

| ID | Why deferred | Recommendation |
|---|---|---|
| SC-9 | Folder sample import is a feature (folder picker, blobs in IndexedDB, live registration), not a fix; medium effort | Fix the cheap part now under PN-13 (name matching, overwrite confirm, reload banner, `samples(url)` so `github:` and base URLs work); spec the folder picker separately |
| SC-11 | Audio-device, multichannel and polyphony settings are a new Settings section; matters to live performers, not beginners | Set an explicit `maxPolyphony` now (MX-16); spec an Audio section later; SuperDirt target is optional |
| SC-12 | `.pianoroll()`, `.scope()`, `.tscope()`, `.fscope()`, `.spectrum()` and `.pitchwheel()` still draw on Strudel's unmanaged full-page canvas; a managed home for them needs a decision on where those visuals live | The Hydra/shader host (`src/strudel-ext/visuals-host.js`) and the bottom canvas's "Custom" mode now exist: route the full-page context through one of them so all canvases share a clip / full-window mechanism; finish `feedStrudel` (SC-18 rest) with it |
| SC-14 (rest) | gamepad, motion, mqtt and mondo are new dependencies and niche; tidal, edo and dough are unreleased. The soundfont globals are in scope (5daf860) | Add the four published packages as opt-in rows in Settings when asked for — a maintainer call, since each is a new dependency |
| MX-18 | Worker-based WAV encode changes the export pipeline and needs transferables plus a byte-for-byte equivalence test | Do the retention and yield fixes in Batch 1; move encoding to a Worker when long renders become a real workflow |
| ED-14 | Whether "Insert sound" should replace the whole string is a product call (the docstring says intended) | Decide in §7; the token-level replacement is small once decided |
| ED-8 (= SC-20) | Inline sliders lost and highlight bleed on tab switch need per-tab storage of mini-locations and widgets; not attempted in Batch 1 and not picked up with the render-loop work | Its own change: store `{miniLocations, widgets}` per tab, clear mini-locations unless the incoming tab is the playing one |
| ED-17 | "x is not a function" locator misses `foo(1)` / `foo(x)`; not attempted | Small; do with the next error-message change (UX-28 is in the same file) |
| ED-20 (rest) | Keyboard scrubbing (Alt+Up/Down nudge) is a new feature, not a fix | Spec separately |
| ED-16 (rest) | Digit-leading sample names (`808bd`) are still rejected by the drum-lane parser; not picked up | Small |
| ED-21 (rest) | Bank chip not refreshed on tab switch; not picked up | Small; refresh it from the tab install hook |
| TR-22 (rest) | The four 15 s boot timeout timers are never cleared (`src/boot.js` `withTimeout`); harmless, they fire once into a settled race | Clear the timer when its phase settles |
| TR-19 (rest) | Arrange-bar solo still starts playback when stopped; the keymap, track bar and palette paths are fixed | Gate `handleSoloClick`'s evaluate on the scheduler running, once §7 item 5 is confirmed |
| TR-21 (rest) | Single-token raw rhythms such as `'0*4'` are rejected; `comp` doubles a note on three-note voicings | Small; do with the next `progression()` change |
| MX-10 | Closing the live context while decodes are in flight could cache a rejected promise; not reproduced | Leave until it is seen; the fix is to await or re-issue pending decodes before the swap |
| MX-16 (rest) | True steal-oldest for live MIDI is impossible from the bridge: superdough returns no voice handle | Tapering is in place; decide in §7 |
| MX-19 (rest) | Tail seconds, cancel, dither/normalise for export | Feature-sized; spec with MX-18 |
| MX-21 (rest) | Metronome is still a `setInterval`; capture buffer unbounded | Schedule clicks on the audio clock when capture is next touched |
| MX-6 (gap) | The node-pool flush probes wavetable pools only with the sounds the rendered pattern uses, so a wavetable voice pooled by a different pattern is not flushed | Acceptable; revisit if dropped first notes reappear after a wavetable pattern |
| PS-17 (rest) | Dirty-set caching; quota handling in the folder-delete "unfile" branch; not picked up | Small; the caching is a per-render cost of the tab strip |
| PS (residual) | Two windows editing the same pattern inside the 1 s autosave debounce: the last writer wins (a status message is shown). A Revert of non-transpiling demo code in one window is undone if another window has that pattern active | Accept; a merge UI is out of scope |
| PN-26 (rest) | Dead popover code in `settings-drawer.js`, export cancel | Delete the dead code with the Setup files (§7 item 1); export cancel with MX-18 |
| SC-4, SC-17 | Resetting tempo, voicings and default controls when a different tab is first played (and honouring `// @version`) was implemented and then withdrawn after review. It ran before the new tab's code, so a slow first evaluate left the still-playing tab at 0.5 cps; a late failure of a cancelled evaluate could rewind a newer tab's tempo; and it wiped defaults set by the user's setup script. Until it is redone, "tempo carries over between tabs" is documented in `STRUDEL.md` as a known difference from strudel.cc | A correct version must: decide "owner changed" before evaluating but apply nothing until the new pattern is installed; default the tempo to the boot-time baseline (after the setup script), not a literal 0.5, and only when the code set none; treat voicings and default controls the same way; and key everything to one evaluate token so a cancelled or late-failing evaluate cannot touch a newer one. `// @version` goes through the same path |
| SC-15 | The BPM readout assumes 4 beats per cycle (`setcpm(90)` shows 360 bpm) | Show cpm beside bpm; parsing the `setcpm(x/y)` denominator is the fragile alternative |
| SC-18 (rest) | Hydra's `feedStrudel` is accepted but does nothing useful; the piano-roll half (`hap.value.color`) is done | With SC-12 |
| RD-10, UX-11 (rest) | Stopping while a different tab is focused leaves the playing tab's last frame on the roll (a click on it is a no-op). The scope has no stopped empty state | Clear the roll (or re-query the focused tab's first frame) when the frame's owner is not the focused tab; add a "Press play to see the scope" state |
| BD-4 | Lazy-loading the MIDI import path: only ≈10 kB is left to move now that `@tonejs/midi` is gone | Not worth a lazy boundary on its own; fold into BD-8 if that happens |
| BD-7 (rest) | A cache header for the `/strudel-cc` proxy could cache an upstream error for a day | Leave; BD-9 is the right place to cache manifests |
| BD-8 | A vendor `manualChunks` split would evaluate before `storage-guard.js` (which must run first) and forms a cycle with the top-level-await entry | Only with an explicit allow-list of leaf packages, after moving the entry's top-level await and the storage guard into a chunk the vendors do not depend on; measure parallel-compile gain on the runner first |
| BD-9 | Caching the sample manifests: `samples(url)` fetches internally, so there is nothing to hook | Fetch the manifests through Cache Storage with stale-while-revalidate, then register with `samples(json, base)` (boot already does `fetchJson` → `samples(json)` for the maps in `src/default-samples.js`); the first play before a bank lands must still be reported |
| UX-3 (rest) | The editor's bracket colour (2.14:1) comes from the Strudel theme, not from strasbeat's tokens | Override it in the theme extension or pick it per theme; a design-polish call |
| UX-15 (rest) | Sub-11 px font sizes in the panel stylesheets, native `<select>` and range inputs, `theme-color` (#1c1c1c vs the rendered background) | Panel sizes with the next panel pass; the select replacement is a component, spec it |
| UX-19 (rest) | The palette and the Stop tooltip still say `Ctrl+.` on macOS; no shortcuts were rebound or added (mute on `⌘M`, tab navigation, `F1`) | Render through `src/ui/shortcut-format.js`; rebinding is a maintainer call |
| UX-22 (rest) | The accent picker's lightness slider can still produce a focus ring below 3:1 | Clamp `--focus-ring` lightness independently of the accent |
| UX-30 (rest) | The roll still animates its grid row; several off-token durations remain | Polish pass |
| Light theme | Dark-only; no `prefers-color-scheme` rules | §7 item 4 |
| PF-3, and the un-re-measured §3 rows | A slow heap rise over 30 evaluate→stop cycles needs a 300+ cycle soak; playing-frame cost, leak slopes and typing under CPU throttle were not re-measured after the fixes | The performance lane: build the measurement rig on runners, re-run the §3 scenarios against `03ba08c` and the final tree |

### Findings still open

Findings whose status is `open` at the end of the session — nothing else
is. Neither was attempted.

- **UX-28** (P3) — an unclosed paren is reported at the parser's position
  (a later, empty line) with no pointer to the line where it was opened.
- **UX-31** (P3) — the beat grid is cramped in the default 180 px pane.

## 7. Decisions for the maintainer

Taste and strategy calls the audits and the four batches raised. Each
states the behaviour on `upgrade` today and a recommendation; the answer
goes on the `Decision:` line. Items 1–13 date from Batch 1 (updated where
later work changed them); 14–21 are new.

1. **Delete the unused Setup panel files (PN-14).** Setup is not a
   right-rail panel: its package and sample controls live in Settings. The
   palette command and the copy that pointed at a Setup tab were removed in
   Batch 1; `src/ui/setup-panel.js` and `src/styles/setup.css` are still in
   the tree with no importer. Recommended: delete both, along with the dead
   popover code in `src/ui/settings-drawer.js`.
   - Decision: deleted (`src/ui/setup-panel.js`, `src/styles/setup.css`);
     the two messages that still pointed at a "Setup panel" now say
     Settings. The dead popover code in `settings-drawer.js` is left.
2. **"Try" opens examples in a scratch pattern (PN-4, PN-18, UX-26) —
   confirm.** Implemented as the audit recommended: Try in Learn and
   Reference puts the example in a user pattern named `try-example`,
   brings it to the front and plays it; the pattern that was open is not
   touched. The scratch pattern is reused, and Try asks before replacing it
   only if it was edited since the last example. Alternative not taken:
   keep replacing the open pattern behind a confirm.
   - Decision: —
3. **Unreleased upstream API stays out of the docs index (SC-8) —
   confirm.** Implemented as recommended: `pnpm gen:docs` takes the
   callable names from the installed packages' runtime scope, so hover
   docs, signature hints, autocomplete and the Reference panel offer only
   what runs. Functions that exist on upstream `main` but are not
   published (`cycleStruct`, `flux`, `juxFlip`, `edoScale`, `stackCenter`,
   `onSchedule`, …) are absent until a release ships them; a test fails
   if the committed index names something that cannot be called. The
   alternative not taken: list them, marked "unreleased". Recommended:
   keep. Six callable names have no upstream JSDoc to scrape and so have
   no entry: `setcps`, `onPaint`, `_pianoroll`, `loadSoundfont`, `csound`,
   `xen` — hand-written entries would be a small follow-up.
   - Decision: —
4. **Light theme (UX audit scope note).** The app is dark-only
   (`color-scheme: dark`, no `prefers-color-scheme` rules). Is a light
   theme in scope, or is dark-only a deliberate constraint to record in
   `design/SYSTEM.md`? Not touched in Batch 1.
   - Decision: —
5. **Starting playback from non-play controls (TR-19, RD-14).** Today:
   mute/solo from the keymap, the track bar and the palette edit the code
   and do not start audio when stopped, matching the beat grid; scrubbing a
   number while stopped no longer evaluates either. The arrange bar's solo
   still starts playback when stopped. A beat-grid edit in a non-playing
   tab no longer takes over playback (RD-14, 1f34df6); the track bar's
   `isPlaying` does not use that tab-aware predicate yet, so a mute or
   solo there while another tab plays still re-evaluates the focused
   buffer. Recommended: confirm "only Play starts audio", gate the arrange
   solo the same way, and give the track bar the beat grid's predicate.
   - Decision: fix the track bar. Done: it and the beat grid now share one
     predicate (`isTabPlaying`, `src/tabs.js`), so a mute or solo in a tab
     that is not playing only edits that tab's code. Still open: the arrange
     bar's solo starting playback when stopped, and the mute/solo keys and
     palette commands, which check only that the scheduler runs.
6. **"Insert sound" (ED-14).** Today it replaces the whole mini-notation
   string under the cursor, as its docstring says. The audit recommends
   replacing only the token under the cursor (`tokenAtOffset` exists).
   Unchanged in Batch 1.
   - Decision: —
7. **Ending a capture preview stops playback (MX-1).** The preview now
   plays the take through the repl without touching the buffer, and stops
   playback on every exit path — including the user's own pattern if it was
   playing when the capture started. Alternative: resume what was playing.
   Recommended: keep (simple and predictable) unless it is annoying in
   practice.
   - Decision: —
8. **Reduced motion and visuals (RD-25).** With `prefers-reduced-motion`
   set, Hydra and shader layers render one still frame instead of
   animating. `localStorage['strasbeat:visuals-motion'] = 'full'` opts
   out; there is no UI for it. Decide whether the opt-out deserves a
   Settings toggle.
   - Decision: —
9. **Double-quoted `rhythm:` in two shipped patterns (TR-21).**
   `patterns/ben-tag.js` and `patterns/mellow.js` pass a double-quoted
   `rhythm:` value, which the transpiler turns into a Pattern, so the
   option has never applied. They sound as before but now raise the
   warning badge. Switching them to single quotes silences the warning and
   **changes how they sound**, because the rhythm starts applying. The
   alternative is to delete the option from both.
   - Decision: —
10. **Warning badge colour (TR-20).** Unknown-sound, silent-pattern and
    helper-misuse warnings raise the transport badge, which reuses the red
    error style. An amber variant would read better; that is a design-token
    choice for the polish pass.
    - Decision: —
11. **Arrange solo across tabs (TR-13).** Solo is cleared on every tab
    switch, so it no longer leaks into another tab — and is lost when you
    return to the tab that had it. Alternative: key solo by tab.
    - Decision: —
12. **Live MIDI voice budget (MX-16).** superdough hands back no voice
    handle, so the bridge cannot steal the oldest voice. Instead holds
    taper: from 24 sounding voices the sustain pedal stops extending
    notes, and past 48 each new note's hold shrinks in proportion.
    Accept tapering, or pursue real stealing (which means patching or
    bypassing superdough)?
    - Decision: —
13. **Mod wheel direction (MX-2).** At rest the wheel now leaves the sound
    unfiltered and pushing it up closes the low-pass — the reverse of the
    old mapping, where rest meant a 200 Hz filter on every note. Confirm by
    feel on a real keyboard.
    - Decision: —
14. **Which kit owns `bd`, `sd`, `hh`… (SC-1/SC-5 follow-on).** Several
    default sample maps define the same names. Today dirt-samples wins
    every name it shares with another map — `bd sd hh cp cb cr ht lt mt`
    (also in uzu-drumkit) and `sax` (also in VCSL) — whatever order the
    manifests arrive in; before, the drum names were a network race that
    dirt-samples usually won. strudel.cc itself never loads the full
    dirt-samples, so `bd` there is uzu-drumkit: a pasted pattern plays a
    different kick here. Pinning to dirt-samples keeps existing strasbeat
    patterns sounding the same, including ones that index its larger
    folders (`bd:7`). Recommended: keep dirt-samples. Flipping it is a
    one-line move of the `claim` in `src/boot.js`.
    - Decision: keep dirt-samples as the default, tell the user once, and
      make switching easy. The first time a playing pattern uses one of
      those names without a `.bank(...)` a small non-modal card says which
      kit it is and offers "Switch to the strudel.cc kit" / "Keep classic";
      Settings → Samples has a "Default drum kit" control. The choice is
      stored, applies at once, and covers WAV export (`src/drum-kit.js`).
15. **Piano, VCSL, wavetables and mridangam load by default (SC-1,
    SC-5).** Boot now fetches those four manifests (a few kB to ≈180 kB of
    JSON; audio still loads on first use), as strudel.cc does, and the two
    opt-in rows in Settings — with their wrong "~60MB" label — are gone.
    Registered sounds went from 1,060 to 1,853. The cost is four more
    requests during boot, each with its own timeout and a named warning if
    it fails. Recommended: keep; pasted patterns resolving matters more
    than ≈190 kB of JSON.
    - Decision: —
16. **Reduced motion and the playheads (RD-25, UX-24).** With
    `prefers-reduced-motion` set, the chrome's CSS animations and
    transitions are off and visuals render one still frame (item 8). The
    JS-driven playheads — transport fill and dot, arrange bar, beat grid —
    still move, as does the piano roll: they show position, not
    decoration. Recommended: keep them moving; if that is wrong, step them
    once per cycle or per beat instead of every frame.
    - Decision: —
17. **Brighter secondary text (UX-3).** `--text-dim` went from 2.0–2.6:1
    to 4.0–5.3:1 and `--text-mut` from 4.5–6.0:1 to 6.3–8.4:1 across the
    four surfaces (lightness only; `design/SYSTEM.md` has the values).
    Because the tokens are used everywhere, all secondary text is
    brighter and the gap between primary and secondary text is narrower;
    transport micro-labels also grew from 9–10 px to 11 px. `--text-dim`
    on surface-3 is 4.01:1, still under 4.5. Recommended: accept for
    readability and review the hierarchy by eye in the polish pass.
    - Decision: —
18. **Keymap chip hidden below 600 px (UX-1).** On a phone-width window
    the transport has no room for it, so the chip is hidden; the keymap
    can still be changed in Settings. Recommended: keep — modal keymaps
    on a touch keyboard are rare.
    - Decision: —
19. **48 px bars on touch devices (UX-21).** Under `pointer: coarse` the
    top bar and the transport are 48 px tall and icon buttons, tabs and
    list rows get larger hit areas, at the cost of two rows of code on a
    phone. Separately, the roll is capped at 30dvh on windows 640 px tall
    or less. Recommended: keep; check on a real tablet.
    - Decision: —
20. **"Custom" mode selects itself for painter patterns (SC-3).** When an
    evaluated pattern registers a draw function that uses the canvas it
    is handed (`.punchcard()`, `.spiral()`, `.wordfall()`, `.onPaint()`),
    the bottom panel offers a "Custom" mode and switches to it once.
    Switching back to Roll is respected until the painters go away and
    come back. The alternative is to offer the mode and never switch.
    Recommended: keep the automatic switch — otherwise a pasted
    `.punchcard()` appears to do nothing.
    - Decision: —
21. **Keep the headless smoke workflow?** The 49-check Playwright run
    behind §3.10 lives on a throwaway branch outside `upgrade`; nothing
    in the repository runs a browser. Recommended: commit it as an opt-in
    workflow that runs only on `ci/smoke-*` branches (so ordinary CI stays
    fast), when the performance lane lands and can share its runner
    setup.
    - Decision: committed now as an opt-in workflow
      (`.github/workflows/smoke.yml`, `.github/smoke/smoke.mjs`): `ci/smoke-*`
      pushes and manual runs only. `AGENTS.md` § Verify says how to run it.

## 8. Needs human verification

Nothing below could be signed off by tests or review. Tick each on a real
machine; anything that fails becomes a new finding.

**Already verified in headless Chromium on a runner** (the smoke run in
§3.10, final tree, production build) and therefore removed from the lists
below: boot to "Ready to play" with no load warnings or console errors;
`tr909_bd`, `piano` and `gm_piano` are registered; no animation frames at
idle or after stop; play and stop; the outcome of `editor.evaluate()`; the
unknown-sound warning in the status line; all six panels render; function
completion and the signature hint; the command palette keeps Tab inside
and closes on Escape; the Hydra and shader demos render in the Visuals
panel without painting over the left rail, are removed by `editor.stop()`
and stay gone when a non-visual pattern is evaluated next; `.punchcard()`
draws in Custom mode; a stored Vim profile is active after boot; the
editor is usable, Play is visible and nothing scrolls sideways at 390, 768
and 1024 px.

That run is Chromium with software GL and no audio device. What remains
for a person: audio by ear, MIDI hardware, how visuals look on a real GPU,
screen readers, Safari and Firefox, touch devices, and everything listed
here.

**Audio, by ear**

- [ ] Export a pattern with filters twice in a row: the first notes of
      each WAV are present, and live playback straight after the export
      has no dropped notes (MX-6).
- [ ] Export a visual (Hydra or shader) pattern: the WAV is correct and no
      visuals start during the render (RD-2).
- [ ] Break the code, press WAV: the export refuses with the error instead
      of rendering the previous pattern (TR-3).
- [ ] First play from the keyboard (Cmd/Ctrl+Enter, no click on Play):
      worklet-based sounds work on that first play (SC-10).
- [ ] Press stop during a slow start (`await samples(...)`, first
      `await initHydra()`): it stays stopped (TR-1).
- [ ] `progression()` with `@2` and `*2`, with block and arpeggiated
      rhythms: held cycles play the full figure, repeats fit in one cycle
      (TR-5).
- [ ] `patterns/ben-tag.js` and `patterns/mellow.js` sound as before
      (they will show the warning badge; §7 item 9).
- [ ] Capture a phrase, preview it, save or discard: the open pattern is
      untouched; note that playback stops when the preview ends (§7
      item 7).
- [ ] The new default sounds are audible, not just registered:
      `s("bd*4").bank("tr909")`, `note("c e g").s("piano")`,
      `note("c3 e3 g3").piano()` (pans by pitch), `s("kalimba")`,
      `note("c e g").s("wt_digital")`, `s("mridangam_gumki")`.
- [ ] `bd`, `sd`, `hh` and `sax` sound as they did before, and `bd:7`
      still indexes dirt-samples (§7 item 14). Reload a few times: the
      kick does not change between loads.
- [ ] A slider drag (`slider(0.5, 0, 1)`) changes the sound and logs no
      "not registered" warning.

**MIDI hardware**

- [ ] Fresh browser profile: no permission prompt on load; the pill reads
      "Connect MIDI"; clicking it prompts and connects. Returning visit:
      connects with no click. Chrome and Firefox.
- [ ] Deny the prompt, then allow it in site settings: connects without a
      reload.
- [ ] Mod wheel feel: unfiltered at rest, closes as it goes up (§7
      item 13).
- [ ] Voice budget: organ preset with the pedal down and many notes — the
      tapering is acceptable and nothing runs away (§7 item 12).
- [ ] Output selector with two real devices: a bare `.midi()` follows the
      selection; `.midi('name')` still wins; unplugging the selected device
      warns once and falls back.
- [ ] Play the keyboard, the metronome and a sound preview while a WAV
      export renders: nothing lands in the file, and all three work again
      afterwards.
- [ ] Drums preset capture is saved as drums.
- [ ] Import a real multi-track MIDI file with a tempo change and a
      channel-10 drum track; try the per-track drums override.

**Visuals, on a real GPU**

- [ ] The shader demo looks right and its uniforms pulse on the beat
      rather than two cycles early (placement and teardown were verified
      on the runner; timing against the sound was not).
- [ ] Switch tab and evaluate a non-visual pattern while a visual one
      plays: the old canvas is gone.
- [ ] Reload with a visual pattern as the last-open tab: no render loop
      until Play.
- [ ] First play of a visual pattern after load: the layer survives the
      gap between evaluate and scheduler start (the hold added after
      review).
- [ ] 10× play/stop: no accumulating canvases or "too many WebGL contexts"
      warning.
- [ ] Full-window mode: renders behind the editor, does not cover the left
      rail; stop → play keeps it visible.
- [ ] Collapse, expand and drag the roll divider while visuals play: the
      clip follows without lag.
- [ ] With the OS "reduce motion" setting on: one still frame (§7 item 8).

**Multi-window and storage**

- [ ] Two windows on the same pattern: save in one, the other follows if
      it has no edits of its own and keeps its buffer if it has.
- [ ] Both windows editing the same pattern within a second: last writer
      wins and a status message says so.
- [ ] Fill localStorage (or use a tiny quota): the "Not saving" notice
      appears, stays, and clears once a write succeeds again.
- [ ] Safari with site data blocked (and a private window): the app boots
      and shows the notice.
- [ ] Open a share link: it arrives as `shared-<name>`, the hash is
      cleared, and a reload shows your edits, not the original. Open the
      same link twice.
- [ ] Type, then close the tab's × within a second; reopen: the edit is
      there. Same for backgrounding the tab on a phone.
- [ ] Put a pattern in a folder, edit it, reload: still in the folder.
- [ ] Dev server: ⤓ save over an existing pattern name asks first.

**Panels**

- [ ] Export panel: filename follows a pattern switch; the waveform draws
      when the render finishes while the panel is hidden; a peak over 0 dB
      reads as clipped; the download works a second time.
- [ ] Import samples from a real manifest URL: they appear under "User",
      and deleting a bank shows a readable confirm.
- [ ] Sounds panel with the full sound set: scrolling, search and the
      audition buttons feel right after the chunked rendering.
- [ ] Right rail: the last-used tab is restored on reload; Escape clears a
      search first and returns to the editor second; Cmd/Ctrl+B does not
      strand focus.
- [ ] Command palette: a right click or a touch scroll does not run a
      command.
- [ ] Offline (or with the network throttled hard), open a panel for the
      first time: the slot says it could not load and offers Retry; click
      WAV while offline, go back online, open Export — no render starts
      by itself.
- [ ] On a slow connection, hover docs and function completions start
      working by themselves once the docs index arrives.
- [ ] Try in Learn and Reference opens `try-example` and leaves the open
      pattern alone (§7 item 2); "Copy to new pattern" works.
- [ ] Import a library over open tabs: the tabs show the imported code.

**Bottom panel**

- [ ] `.spiral()`, `.wordfall()`, a hand-written `.onPaint()` and the
      inline `._punchcard()` widget draw; the panel switches to Custom
      once, and choosing Roll again is respected (§7 item 20).
- [ ] `.color("cyan magenta")` colours the notes in the roll.
- [ ] Click a note in the roll after editing above it: the cursor lands
      on the right text. With another tab playing, the click brings that
      tab forward (or does nothing if the frame is stale).
- [ ] While stopped: resize the window, drag the divider, open the right
      rail — the roll keeps its last frame. Collapse the pane while
      playing, expand it: the roll comes back full, with no doubled
      notes.
- [ ] Drag the window between a 2× and a 1× display: the roll stays sharp
      and clicks still hit (RD-15; never run in a browser).
- [ ] Transport fill and dot, the arrange playhead and the status pulse
      move smoothly on a real GPU; the readouts follow play and stop at
      once.
- [ ] Beat grid: typing in the editor while the grid is hidden, then
      showing it — it is current. Enter / Space on Mute, Solo, the bank
      chip and "+ Add drum" act on that button, not on a cell. Toggle a
      cell and press Stop straight away: playback stays stopped.
- [ ] Track and arrange bars follow edits and tab switches; a pattern
      with `arrange()` open and stopped costs nothing at idle.

**Phones, tablets and zoom**

- [ ] A real phone and a real tablet: the editor is usable, an opened
      rail floats over it behind a scrim, tapping the scrim or pressing
      Escape closes it, the top bar's pattern button opens the library.
- [ ] A rail left open on a desktop does not cover the editor when the
      same profile opens on a phone-width window, and closing a rail
      there does not close it on the desktop.
- [ ] 48 px bars and the larger touch targets feel right; the keymap chip
      is absent below 600 px (§7 items 18, 19).
- [ ] 200% browser zoom on a laptop (real zoom, not a small viewport).
- [ ] The first-run hint sits above the transport, points at Play and
      covers nothing at 390 px.

**Keyboard and screen readers**

- [ ] Patterns library with VoiceOver and NVDA: announced as a tree, one
      Tab stop, arrows / Home / End / type-to-find, Enter opens, F2
      renames, Shift+F10 opens a menu that is itself keyboard-operable;
      "modified" is announced.
- [ ] Tab strip: arrows move between tabs, Delete closes the focused one,
      the name carries modified and playing state, focus survives a
      play / stop re-render, and a mouse click on a tab leaves focus in
      the editor.
- [ ] Beat grid announced as a grid with row headers; Tab reaches a cell.
- [ ] Landmarks, the heading outline and the "Skip to editor" link.
- [ ] Focus ring visible on every control, including with a custom
      accent at low lightness (§6, UX-22 rest).
- [ ] Windows High Contrast (forced colours) and "increase contrast":
      active and pressed states are still distinguishable.
- [ ] OS "reduce motion": chrome animations are off; the playheads still
      move (§7 item 16).
- [ ] The new text contrast reads well and the hierarchy still holds
      (§7 item 17).

**Editor keymaps**

- [ ] Vim: `:w` evaluates once, `:q` stops, `gc` toggles a comment; the
      chip shows the mode only once the keymap is really active.
- [ ] Emacs profile loads and works (the runner checked Vim only).
- [ ] Select Vim while offline: the chip shows RETRY, typing still
      works in the default keymap, and retrying online applies it.
- [ ] Ctrl+hover over a function shows nothing odd (upstream's tooltip no
      longer has data; strasbeat's hover docs are the replacement).

**Other browsers**

- [ ] Safari and Firefox: boot, play, the lazy panels, the three layouts
      and the visuals. Everything automated this session ran in Chromium.

**Not measured**

- [ ] Playing-frame cost in each bottom-panel mode, leak slopes over
      repeated cycles, and typing latency under CPU throttle were not
      re-measured after the fixes (§3). The runner comparison in §3.10
      shows no typing regression on fast hardware and nothing else.

**Added after the independent review**

- [ ] Reload after leaving a syntax error in an edited Demo: the Demo opens
      on its original, the status line names `<name>-recovered`, and that
      pattern is in the library with the edits.
- [ ] Open the Hydra demo, press Play, Stop and Play again quickly on first
      load (and press Play while "Loading sounds…" is still showing): the
      drums are not doubled or louder than on a normal play.
- [ ] Stop during a start that hangs (`await new Promise(() => {})` above
      some `$:` lines), then Play a different pattern: it starts after a
      pause of about three seconds, not never.
- [ ] Import a multi-track MIDI file in which one part ends early: that
      part stays silent until the others finish, then all loop together.
      Import a drum track with a ride cymbal: the ride is audible.
- [ ] With a fresh profile, play a pattern with `s("bd sd hh")`: the drum
      kit card appears once playback has started, does not take focus and
      does not get in the way of typing; its timing feels right. Play a
      pattern with `.bank("tr909")` first: no card.
- [ ] Hear both kits: switch with the card, then back and forth in
      Settings → Samples while a `bd`/`sd`/`hh` pattern plays. The sound
      changes within a bar each time, and the choice survives a reload.
- [ ] Export a WAV with each kit selected: each file has the kit that was
      playing.
- [ ] Tab to the card from the transport, press Escape: it closes and focus
      is on Play. With a screen reader, the card's text is announced
      without interrupting.
