# strasbeat — Impeccable Design Context

## Design Context

### Users

Developer-musicians and the wider Strudel community. The tool must be super powerful for power users and DAW-experienced musicians, while remaining immediately accessible to beginners through great UI/UX — the interface itself teaches the tool. Primary context is solo composition: headphones on, late night or weekend, deep in a creative session. The browser is the only window that matters.

### Brand Personality

**Futuristic, elegant, musical.** The crossover point where code meets music — not a code editor that happens to make sound, and not a DAW that happens to show text. If strasbeat were a physical object it would be a matte-black instrument panel with backlit controls: precise, quiet until you touch it, then responsive and alive.

### Aesthetic Direction

- **Theme**: Dark. This is a headphones-at-night music tool. Dark is the correct choice for the viewing context and the emotional register.
- **Visual tone**: Figma's tight, deliberate chrome grammar — not its look. ~95% greyscale surfaces with a single configurable accent (rose pink default, OKLCH). Color is signal, never decoration.
- **Typography**: Geist Sans (UI) + Geist Mono (code), already in place. The mono/sans contrast is the genre signal: _this is code, that is chrome_.
- **References**: Figma (spatial discipline, panel grammar, floating contextual actions). Ableton's _confidence_ — every control is where you expect it — but not its density or visual age.
- **Anti-references**: Strudel.cc (too playful/educational/rainbow), VS Code (too general-purpose/busy/chrome-heavy), GarageBand (skeuomorphic), generic SaaS dashboards (cards-on-cards, hero metrics, gradient text).
- **Existing design system**: Fully codified in `design/SYSTEM.md` — OKLCH palette, 4px spacing grid, two-level elevation, Lucide icons, strict motion budget. All tokens live in `src/styles/tokens.css`. The accent is user-configurable via an in-app OKLCH hue/lightness picker persisted to localStorage.

### Design Principles

1. **The canvas is king.** The editor is the instrument. Chrome surrounds it but never crowds it; panels collapse when not in use. Every pixel of chrome must justify its existence.
2. **Flow over features.** The interface should disappear during composition. No modal interruptions, no surprising layout shifts, no decoration that pulls attention from the music. Optimize for the state where the user forgets they're in a browser.
3. **Signal, not noise.** Color means something (selection, recording, active state, error). One accent, used sparingly. Greyscale does the heavy lifting. If something is colorful, the user should instinctively know _why_.
4. **Power through progressive disclosure.** Beginners see a clean, approachable surface. Power users discover depth through interaction — hover states, keyboard shortcuts, expandable panels, contextual affordances near the cursor.
5. **Futuristic restraint.** The aesthetic is forward-looking — clean geometry, precise spacing, subtle motion — but never flashy. No glow effects, no gradients-for-gradients-sake, no ambient animation. The music is the show; the interface is the stage.
