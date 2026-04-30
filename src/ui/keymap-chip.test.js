import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { formatChipLabel } from "./keymap-chip-format.js";
import { getProfile } from "../editor/keymap-profiles.js";

describe("formatChipLabel()", () => {
  test("non-modal profiles show only the label + dropdown caret", () => {
    assert.equal(formatChipLabel(getProfile("strudel"), null), "Strudel ▾");
    assert.equal(formatChipLabel(getProfile("vscode"), null), "VSCode ▾");
    assert.equal(formatChipLabel(getProfile("emacs"), null), "Emacs ▾");
  });

  test("modal profiles append the active mode in uppercase", () => {
    assert.equal(formatChipLabel(getProfile("vim"), "NORMAL"), "Vim · NORMAL ▾");
    assert.equal(formatChipLabel(getProfile("vim"), "INSERT"), "Vim · INSERT ▾");
    assert.equal(formatChipLabel(getProfile("helix"), "SELECT"), "Helix · SELECT ▾");
  });

  test("modal profiles fall back to the first mode when current mode is unknown", () => {
    // Defensive — if the mode subscription hasn't fired yet, show NORMAL
    // (the first declared mode) rather than a blank pill.
    assert.equal(formatChipLabel(getProfile("vim"), null), "Vim · NORMAL ▾");
    assert.equal(formatChipLabel(getProfile("helix"), undefined), "Helix · NORMAL ▾");
  });

  test("modal profiles uppercase any input mode they receive", () => {
    assert.equal(formatChipLabel(getProfile("vim"), "insert"), "Vim · INSERT ▾");
  });
});
