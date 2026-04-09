# strasbeat design system

This is the source of truth for visual and interaction design in strasbeat.
Every design or UI work item should align with this document; if you find
yourself wanting to deviate, propose an update to this file in the same PR
as the deviation.

## 1. Vision recap

strasbeat is a version-controlled, IDE-quality workspace for making music
with [Strudel](https://strudel.cc) (TidalCycles ported to JavaScript).
Today it's a small Vite app wrapping a Strudel editor with the developer-
comforts a daily-driver tool needs: pattern files on disk, an offline WAV
exporter, a MIDI bridge, a console with debug helpers.

The vision (see `../CLAUDE.md` § "Vision the user is steering toward") is
that it grows — without losing Strudel's "code is the source of truth"
ethos — into a DAW-shaped tool that's powerful for veterans and gentle
for beginners.

The design system therefore needs to **work beautifully today at v1** *and*
**still hold up** when 10× more features land on it. Every decision in this
file is made with both horizons in mind.

## 2. Design principles (stolen from Figma's grammar, not its look)

We're not copying Figma's appearance. We're stealing the *grammar* that
made Figma scale from a vector tool to a multiplayer design platform
without ever feeling cramped:

1. **The canvas is king. The chrome is staff.**
   The editor is our canvas. UI surrounds it but never crowds it; panels
   collapse when not in use.

2. **Left = "what exists." Right = "what is this thing."**
   Left rail holds the world (patterns library; eventually instruments,
   samples, capture history). Right rail (collapsible, hidden by default
   in v1) holds properties of the current selection (hover docs, function
   signatures; eventually: track properties).

3. **Tight, deliberate spacing on a strict grid.**
   Everything snaps to a 4px subgrid and an 8px primary grid. Row heights
   are predictable. Hit targets are consistent.

4. **Restrained color, one accent.**
   ~95% greys + one accent. Color is meaningful (selection, recording,
   active state), never decorative.

5. **One soft elevation language.**
   Popovers, autocomplete, dropdowns, modals all share the same shadow
   vocabulary. Once it's set, every new floating UI is consistent for
   free.

6. **Floating contextual actions near the cursor.**
   When something is happening (recording, evaluating, errored), the
   relevant affordance floats *near where the user is looking*, not in a
   far corner of the chrome.

7. **No native dropdowns or modals — ever.**
   They break the spell. Every `<select>`, every `window.prompt()`, every
   browser-default control is replaced by a custom one. (The existing
   `window.prompt()` calls in `main.js` are tracked for replacement but
   are not blocking on the design pass.)

8. **Numerical drag-to-scrub.**
   Figma's signature gesture. For a music tool — where every gain/room/
   delay/cps is a number — this isn't a polish item, it's a *core
   interaction*. See `work/03-numeric-scrubber.md`.

## 3. Layout grammar

The shell that every feature plugs into:

```
┌────────────────────────────────────────────────────────────────┐
│ ◆ Strasbeat   05-chords ▾                       ↗ share  ⚙    │  ← top bar (40px)
├──────┬─────────────────────────────────────────────┬───────────┤
│      │                                             │           │
│ left │                                             │  right    │
│ rail │              EDITOR (the canvas)            │  rail     │
│      │                                             │           │
│ pat- │                                             │  hidden   │
│ terns│                                             │  in v1;   │
│      │                                             │  reserved │
│      │                                             │  for v2   │
├──────┴─────────────────────────────────────────────┴───────────┤
│ ▶ ■  ● capture   •   120 bpm   cycle 3.2   ────●────  midi ✓   │  ← transport bar (32px)
├────────────────────────────────────────────────────────────────┤
│                    piano roll / timeline                       │  ← collapsible bottom (~160px)
└────────────────────────────────────────────────────────────────┘
```

Why this shape:

- **Top bar is minimal.** Brand, current pattern name (clickable → opens
  the pattern menu), `share`, and a settings/menu drawer. That's it.
  This is the only place that doesn't have to scale — it's always going
  to be a thin strip.
- **Left rail is the patterns library.** Replaces today's native
  `<select>` dropdown. Searchable, supports new pattern, eventually grows
  to host other collections (instruments, samples, captured phrases).
  This is *exactly* the shape that scales when the project grows: more
  collections → more sections in the left rail. No layout refactor
  required.
- **Editor center.** No panels overlapping it. No status text crowding
  it. Always full-bleed.
- **Right rail exists in the structure but is hidden by default in v1.**
  When intellisense/hover docs land, they slide out from this side. When
  the project becomes DAW-shaped, this is where track properties live.
  Reserve the column structurally; render nothing in it for now.
- **Transport bar is its own dedicated row** below the editor. It holds
  play/stop/capture, the **cps/bpm readout** (currently absent — must
  exist), the **cycle/beat readout**, the **playhead**, and the MIDI
  status indicator. *Always visible*, *always one place*. The current
  status-message text also lives here, replacing the two cramped status
  spans in the top bar today.
- **Piano roll is collapsible.** Click the divider to hide it. When
  collapsed, the editor reclaims the vertical space. When expanded, it's
  worth looking at (see `work/05-piano-roll.md`).

This layout is **DAW-ready by design**: when tracks land, the left rail
becomes the track list, the right rail becomes track properties, and the
bottom panel becomes the arrangement view. Nothing has to move. See
`work/06-future.md` for more.

## 4. Type system

**Geist Sans** for UI labels. **Geist Mono** for code.

- Both are free, open-source, designed as a pair (so they sit together).
- Both are variable fonts — use weight as a design tool (see scale below).
- Self-host via `@fontsource-variable/geist-sans` and
  `@fontsource-variable/geist-mono` (or `@fontsource/...` if the variable
  packages aren't available). No CDN runtime cost.
- The mono/sans contrast is a small but important signal: *this is code,
  that is chrome*.

### Scale

| Token        | Size | Line height | Default weight | Use                                |
| ------------ | ---- | ----------- | -------------- | ---------------------------------- |
| `text-xs`    | 11px | 16px        | 500            | small status, tiny labels          |
| `text-sm`    | 12px | 18px        | 500            | UI labels, button text, metadata   |
| `text-base`  | 13px | 20px        | 500            | body UI text                       |
| `text-md`    | 14px | 22px        | 500            | section headings, brand wordmark   |
| `code-sm`    | 13px | 22px        | 400            | inline code in chrome (e.g. status) |
| `code-base`  | 15px | 24px        | 400            | the editor itself                  |

(Tune Geist's stylistic sets via `font-feature-settings` in implementation
— `"ss01"`, `"cv11"` etc. — to taste.)

### Weight discipline

- **400** — code only.
- **500** — default UI weight.
- **600** — actively-emphasised labels (current selection, active tab,
  focused control).
- **700** — sparingly. Brand wordmark only.

## 5. Color tokens

Palette is built in **OKLCH** so greys are perceptually even and the
accent hue is stable across lightness levels.

```css
:root {
  /* Surfaces — pure greyscale */
  --surface-0:   oklch(0.16 0 0);   /* page background */
  --surface-1:   oklch(0.20 0 0);   /* panels: left rail, transport, roll */
  --surface-2:   oklch(0.24 0 0);   /* elevated: buttons, dropdowns, popovers */
  --surface-3:   oklch(0.28 0 0);   /* hover states */
  --border:      oklch(0.30 0 0);   /* visible hairlines, ~1px */
  --border-soft: oklch(0.24 0 0);   /* subtle dividers */

  /* Text */
  --text:        oklch(0.96 0 0);
  --text-mut:    oklch(0.65 0 0);
  --text-dim:    oklch(0.45 0 0);

  /* Accent — rose pink. Configurable; see § 5.1 */
  --accent:      oklch(0.63 0.19 358);          /* ≈ #CF418D */
  --accent-hi:   oklch(0.70 0.20 358);          /* hover/active */
  --accent-lo:   oklch(0.42 0.12 358);          /* deep, ≈ #842B54 */
  --accent-wash: oklch(0.63 0.19 358 / 0.12);   /* tinted backgrounds */

  /* Semantic — used only when meaningful */
  --rec:         oklch(0.65 0.22 25);   /* recording, errors */
  --ok:          oklch(0.78 0.16 150);  /* MIDI connected, success */
}
```

### 5.1 Configurability of the accent

The accent is the user's signature, so it must be **trivially user-
configurable**. Two tiers:

1. **CSS-variable override (v1, mandatory).** The user can drop a
   `:root { --accent: …; --accent-hi: …; … }` block in `src/style.css`
   (or eventually a `user.css`) and the entire UI updates instantly.
   **All accent uses must reference the variables — *no hard-coded
   accent hex anywhere in CSS or JS***. Grep for `#CF` and `#84` in the
   codebase before merging — only the SYSTEM.md file should mention
   them, as explanatory comments.

2. **In-app theme picker (v2, deferred).** Eventually a small settings
   drawer with a hue slider + lightness slider that writes the live
   values into a `<style>` tag. Out of scope for v1; just make sure step
   1 holds so this is a drop-in addition later.

The **default accent is rose pink, ≈ #CF418D**, with the deep variant
≈ #842B54. This is chosen — do not change the default without explicit
user instruction.

## 6. Spacing scale

```css
--space-0: 0;
--space-1: 4px;
--space-2: 8px;
--space-3: 12px;
--space-4: 16px;
--space-5: 24px;
--space-6: 32px;
--space-7: 48px;
--space-8: 64px;
```

Conventions:

- Padding inside controls and cells: `--space-2` to `--space-3`.
- Gaps between control groups: `--space-3` to `--space-4`.
- Major panel padding: `--space-4`.
- Whitespace between sections in the left rail: `--space-5`.
- Don't use ad-hoc px values; if you need a new step, add it here.

## 7. Elevation

Two levels, no more:

```css
--shadow-low:  0 1px 2px oklch(0 0 0 / 0.4);
--shadow-pop:  0 2px 4px oklch(0 0 0 / 0.4),
               0 8px 24px oklch(0 0 0 / 0.5);
```

- `--shadow-low` for buttons on hover, persistent floating bars, subtle
  separation between adjacent surfaces of the same color.
- `--shadow-pop` for dropdowns, autocomplete popovers, modals — anything
  that pops *over* the canvas.

## 8. Borders & radii

```css
--radius-sm: 4px;   /* inputs, small chips, gutter widgets */
--radius-md: 6px;   /* buttons, cards, popovers */
--radius-lg: 8px;   /* modals, large surfaces */
```

- Buttons, dropdowns, cards, popovers: `--radius-md`.
- Inputs and chips: `--radius-sm`.
- The shell panels themselves (left rail, transport, roll) are **flush**
  — no border radius. Sharp seams between panes are part of the Figma
  grammar.
- Borders are 1px solid `--border` for visible separation, 1px solid
  `--border-soft` for subtle dividers.

## 9. Motion

Motion exists to **explain change**, not to entertain.

- Hover transitions: `120ms ease-out`.
- Panel show/hide: `200ms cubic-bezier(0.16, 1, 0.3, 1)`.
- Popover enter: `120ms ease-out`. Exit: `80ms ease-in`.
- No spring physics. No bouncing. No ambient idle animations.
- The recording pulse on the capture button (existing in `style.css`
  today) is the **only** ambient animation in v1. Match its 1.2s easing
  if you need similar attention-pulling animations elsewhere.

## 10. Iconography

- Use a single icon set throughout. Recommendation: **Lucide** (free,
  consistent, large library, MIT, tree-shakable). Self-host via the
  `lucide` npm package.
- Icon sizes:
  - Top bar: 16px.
  - Transport bar: 14px.
  - Inline / gutter widgets: 12px.
- Icons render in `currentColor` so they inherit the text token of their
  container.
- Buttons that today use Unicode glyphs (`▶`, `■`, `⤓`, `↗`, `●`) should
  be replaced with Lucide equivalents (`play`, `square`, `download`,
  `share-2`, `circle`/`disc`). Keep the text label *next* to the icon
  for the toolbar; transport buttons can be icon-only with a tooltip.

## 11. Off-limits during the design pass

The design pass touches DOM structure, CSS, the editor's CodeMirror
extensions, and small UI components. **It does not touch the core
Strudel wiring** in `src/main.js`. Specifically:

| Region in `src/main.js`                  | Status                              |
| ---------------------------------------- | ----------------------------------- |
| Imports of `@strudel/*`                  | **off-limits**                      |
| `prebake` + audio init                   | **off-limits**                      |
| `renderPatternToBuffer` + WAV export     | **off-limits**                      |
| `audioBufferToWav16`, `downloadWav`      | **off-limits**                      |
| `MidiBridge` setup + capture handler     | **off-limits**                      |
| `import.meta.glob` of `/patterns`        | **off-limits**                      |
| Share-link encode/decode                 | **off-limits**                      |
| `editor.updateSettings({...})` block     | **fair game** (extend it freely)    |
| The editor's CodeMirror `extensions`     | **fair game** (add CM6 extensions)  |
| DOM event listeners on toolbar buttons   | **fair game** (rewire to new shell) |
| `window.strasbeat` console helpers       | **off-limits** (don't break them)   |
| `window.editor`, `window.midi` exports   | **off-limits** (don't break them)   |

If a design task seems to require touching off-limits code, **stop and
ask** — it likely means the task scope is wrong, not that the rule
should bend.

Also off-limits:
- Anything in `strudel-source/` (read-only upstream reference; patches
  belong upstream).
- `vite.config.js` server middleware (the `/api/save` and `strudel.cc`
  proxy).

## 12. References

Mental anchors when in doubt:

- **Figma** — the grammar. Spacing discipline, rail-based layout,
  contextual popovers, restraint with color, drag-to-scrub.
- **Linear** — type rhythm, the way it makes a dense product feel calm.
- **Vercel** — monochrome surfaces with one accent doing all the work.
- **Bitwig Studio** — what a music tool can look like when it takes
  "dark and technical" seriously.
- **Arc browser** — the soft, trustworthy elevation language for popovers.

We're a sibling, not a clone, of any of these.
