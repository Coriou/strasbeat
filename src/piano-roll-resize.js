// ─── Collapsible piano roll ──────────────────────────────────────────────
// Click the transport's roll-toggle button to collapse/expand. The shell
// grid animates `--roll-h` between 0 and the current expanded value, so
// the editor reclaims the freed vertical space.
const STORAGE_KEY = "strasbeat:roll-collapsed";
const HEIGHT_KEY = "strasbeat:roll-height";
const TOGGLE_DEBOUNCE_MS = 200; // matches --t-panel transition duration

export function mountPianoRollResize({
  shellEl,
  rollToggleBtn,
  rollDivider,
  resizeCanvas,
}) {
  let rollCollapsed = localStorage.getItem(STORAGE_KEY) === "true";
  let rollExpandedPx = Number(localStorage.getItem(HEIGHT_KEY)) || 180;
  let lastToggleTime = 0;

  // Apply persisted state on mount.
  if (rollCollapsed) {
    shellEl.classList.add("shell--roll-collapsed");
    rollToggleBtn.setAttribute("aria-expanded", "false");
  }

  rollToggleBtn.addEventListener("click", toggleRoll);
  function toggleRoll() {
    const now = performance.now();
    if (now - lastToggleTime < TOGGLE_DEBOUNCE_MS) return;
    lastToggleTime = now;

    rollCollapsed = !rollCollapsed;
    shellEl.classList.toggle("shell--roll-collapsed", rollCollapsed);
    rollToggleBtn.setAttribute("aria-expanded", String(!rollCollapsed));
    localStorage.setItem(STORAGE_KEY, String(rollCollapsed));
    if (!rollCollapsed) {
      shellEl.style.setProperty("--roll-h", `${rollExpandedPx}px`);
    }
    // Keep the canvas backing-store sized to its new visible area.
    requestAnimationFrame(resizeCanvas);
  }

  // Drag the divider to resize the roll. Click on a collapsed divider
  // expands. Tracks pointer events directly so it works on touch and
  // trackpad without extra plumbing.
  let dragStartY = null;
  let dragStartHeight = null;
  const ROLL_MIN_PX = 80;
  const ROLL_MAX_PX = 360;
  rollDivider.addEventListener("pointerdown", (e) => {
    if (rollCollapsed) {
      toggleRoll();
      return;
    }
    dragStartY = e.clientY;
    dragStartHeight = rollExpandedPx;
    rollDivider.setPointerCapture(e.pointerId);
    e.preventDefault();
    document.body.style.cursor = "ns-resize";
    document.addEventListener("pointerup", endRollDrag);
    document.addEventListener("pointercancel", endRollDrag);
  });
  rollDivider.addEventListener("pointermove", (e) => {
    if (dragStartY == null) return;
    const dy = dragStartY - e.clientY; // dragging up = bigger roll
    const h = Math.min(
      ROLL_MAX_PX,
      Math.max(ROLL_MIN_PX, dragStartHeight + dy),
    );
    rollExpandedPx = h;
    shellEl.style.setProperty("--roll-h", `${h}px`);
  });
  function endRollDrag(e) {
    if (dragStartY == null) return;
    dragStartY = null;
    document.body.style.cursor = "";
    if (e?.pointerId != null && rollDivider.hasPointerCapture?.(e.pointerId)) {
      rollDivider.releasePointerCapture(e.pointerId);
    }
    document.removeEventListener("pointerup", endRollDrag);
    document.removeEventListener("pointercancel", endRollDrag);
    localStorage.setItem(HEIGHT_KEY, String(rollExpandedPx));
    requestAnimationFrame(resizeCanvas);
  }
  rollDivider.addEventListener("pointerup", endRollDrag);
  rollDivider.addEventListener("pointercancel", endRollDrag);

  return { toggleRoll };
}
