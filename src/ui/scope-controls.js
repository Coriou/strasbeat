// Scope controls — a small strip mounted alongside the bottom-panel mode
// switcher. Visible only while Scope mode is active; hidden otherwise so
// it doesn't clutter the Roll / Beat grid views. Every control writes
// through to the shared scope instance via setConfig(), and the merged
// config is persisted to localStorage so the next page load restores the
// last-used shape.
//
// Controls:
//   mode     — Time / Freq segmented pill
//   scale    — y-axis zoom (range 0.1 – 4)
//   smear    — 3-state cycle button (Off / Low / High → 0 / 0.3 / 0.7)
//   trigger  — threshold for time-mode alignment (range -1 – 1). Only
//              visible when mode = Time; collapses out of the strip in
//              Freq mode where it has no effect.
//
// The strip's look (spacing, dividers, hover states, exact shape of the
// Smear button) is functional-level only — visual polish is a follow-up
// /polish pass, per design/work/20-scope-upgrades.md §Notes.

const STORAGE_KEY = "strasbeat:scope-config";

const SMEAR_CYCLE = [
  { label: "Off", value: 0 },
  { label: "Low", value: 0.3 },
  { label: "High", value: 0.7 },
];

const MODE_OPTIONS = [
  { id: "time", label: "Time" },
  { id: "freq", label: "Freq" },
];

export function mountScopeControls({ container, scope, modes }) {
  // Restore persisted config before any UI reads getConfig(). setConfig
  // clamps, so a hand-edited localStorage blob can't push the scope into
  // a broken state.
  const stored = readStored();
  if (stored) scope.setConfig(stored);

  const strip = document.createElement("div");
  strip.className = "scope-controls";
  strip.hidden = modes.getMode() !== "scope";

  const initial = scope.getConfig();

  // ─── Mode pill (Time / Freq) ──────────────────────────────────────────
  const modePill = document.createElement("div");
  modePill.className = "scope-controls__modes";
  modePill.setAttribute("role", "tablist");
  modePill.setAttribute("aria-label", "Scope mode");

  const modeButtons = new Map();
  for (const opt of MODE_OPTIONS) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "scope-controls__mode-btn";
    btn.dataset.mode = opt.id;
    btn.setAttribute("role", "tab");
    btn.textContent = opt.label;
    btn.addEventListener("click", () => {
      scope.setConfig({ mode: opt.id });
      refresh();
      save();
    });
    modePill.appendChild(btn);
    modeButtons.set(opt.id, btn);
  }
  strip.appendChild(modePill);

  // ─── Scale slider ─────────────────────────────────────────────────────
  const scaleField = makeSlider({
    label: "Scale",
    min: 0.1,
    max: 4,
    step: 0.1,
    value: initial.scale,
    format: (v) => v.toFixed(1) + "×",
    onInput: (v) => {
      scope.setConfig({ scale: v });
      save();
    },
  });
  strip.appendChild(scaleField.el);

  // ─── Smear cycle ──────────────────────────────────────────────────────
  const smearBtn = document.createElement("button");
  smearBtn.type = "button";
  smearBtn.className = "scope-controls__smear";
  smearBtn.setAttribute("aria-label", "Scope trail length");
  const smearLabelEl = document.createElement("span");
  smearLabelEl.className = "scope-controls__label";
  smearLabelEl.textContent = "Smear";
  const smearValueEl = document.createElement("span");
  smearValueEl.className = "scope-controls__value";
  smearBtn.appendChild(smearLabelEl);
  smearBtn.appendChild(smearValueEl);
  smearBtn.addEventListener("click", () => {
    const current = smearIndexFor(scope.getConfig().smear);
    const next = (current + 1) % SMEAR_CYCLE.length;
    scope.setConfig({ smear: SMEAR_CYCLE[next].value });
    refresh();
    save();
  });
  strip.appendChild(smearBtn);

  // ─── Trigger slider (Time mode only) ──────────────────────────────────
  const triggerField = makeSlider({
    label: "Trigger",
    min: -1,
    max: 1,
    step: 0.02,
    value: initial.trigger,
    format: (v) => v.toFixed(2),
    onInput: (v) => {
      scope.setConfig({ trigger: v });
      save();
    },
  });
  strip.appendChild(triggerField.el);

  container.appendChild(strip);

  // ─── Mode subscription ────────────────────────────────────────────────
  // Visibility follows the bottom-panel mode. When the user flips back to
  // Scope after being on Roll / Beats, force a hard clear on the next
  // frame so the other mode's last paint doesn't smear through.
  modes.setOnChange((m) => {
    const isScope = m === "scope";
    strip.hidden = !isScope;
    if (isScope) scope.markDirty();
  });

  // Initial sync so the UI matches the current config.
  refresh();

  // ─── Persistence ─────────────────────────────────────────────────────
  // Coalesce writes to one per animation frame so dragging a slider
  // doesn't hammer localStorage 60x per second.
  let saveFrame = null;
  function save() {
    if (saveFrame != null) return;
    saveFrame = requestAnimationFrame(() => {
      saveFrame = null;
      writeStored(scope.getConfig());
    });
  }

  function refresh() {
    const cfg = scope.getConfig();
    for (const [id, btn] of modeButtons) {
      const active = id === cfg.mode;
      btn.classList.toggle("is-active", active);
      btn.setAttribute("aria-selected", active ? "true" : "false");
    }
    scaleField.setValue(cfg.scale);
    const smearIdx = smearIndexFor(cfg.smear);
    smearValueEl.textContent = SMEAR_CYCLE[smearIdx].label;
    smearBtn.dataset.level = SMEAR_CYCLE[smearIdx].label.toLowerCase();
    triggerField.setValue(cfg.trigger);
    triggerField.el.hidden = cfg.mode !== "time";
  }

  return { refresh };
}

// ─── DOM helpers ──────────────────────────────────────────────────────

function makeSlider({ label, min, max, step, value, format, onInput }) {
  const wrap = document.createElement("label");
  wrap.className = "scope-controls__field";

  const labelEl = document.createElement("span");
  labelEl.className = "scope-controls__label";
  labelEl.textContent = label;
  wrap.appendChild(labelEl);

  const input = document.createElement("input");
  input.type = "range";
  input.className = "scope-controls__slider";
  input.min = String(min);
  input.max = String(max);
  input.step = String(step);
  input.value = String(value);

  const valueEl = document.createElement("span");
  valueEl.className = "scope-controls__value";
  valueEl.textContent = format(Number(value));

  input.addEventListener("input", () => {
    const n = Number(input.value);
    valueEl.textContent = format(n);
    onInput(n);
  });

  wrap.appendChild(input);
  wrap.appendChild(valueEl);

  return {
    el: wrap,
    setValue(v) {
      if (input.value !== String(v)) input.value = String(v);
      valueEl.textContent = format(Number(v));
    },
  };
}

// Map a continuous smear value back onto the 3-state cycle by picking
// whichever preset is closest. This makes the control forgiving if the
// config ever ends up at an in-between value (via external code or a
// schema bump).
function smearIndexFor(value) {
  let best = 0;
  let bestDist = Infinity;
  for (let i = 0; i < SMEAR_CYCLE.length; i++) {
    const d = Math.abs(SMEAR_CYCLE[i].value - value);
    if (d < bestDist) {
      bestDist = d;
      best = i;
    }
  }
  return best;
}

// ─── Storage ──────────────────────────────────────────────────────────

function readStored() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    const out = {};
    if (parsed.mode === "time" || parsed.mode === "freq") out.mode = parsed.mode;
    if (Number.isFinite(parsed.scale)) out.scale = parsed.scale;
    if (Number.isFinite(parsed.smear)) out.smear = parsed.smear;
    if (Number.isFinite(parsed.trigger)) out.trigger = parsed.trigger;
    return out;
  } catch {
    return null;
  }
}

function writeStored(config) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
  } catch {
    /* quota / private mode — ignore */
  }
}
