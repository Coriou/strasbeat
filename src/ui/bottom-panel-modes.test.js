// Run with: node --import ./scripts/test-register.mjs --test src/ui/bottom-panel-modes.test.js
//
// The mode switcher is a plain state machine until mountToggle() gives it DOM,
// so availability / fallback / resume rules are testable headlessly.

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { createBottomPanelModes } from "./bottom-panel-modes.js";

describe("Visuals mode availability", () => {
  test("appearing does not switch to it — the user opts in", () => {
    const m = createBottomPanelModes();
    m.setVisualsAvailable(true);
    assert.equal(m.getMode(), "roll");
  });

  test("is not selectable while unavailable", () => {
    const m = createBottomPanelModes();
    m.setMode("visuals");
    assert.equal(m.getMode(), "roll");
  });

  test("stop → play returns to Visuals if that is where the user was", () => {
    const m = createBottomPanelModes();
    m.setVisualsAvailable(true);
    m.setMode("visuals");
    m.setVisualsAvailable(false); // stop tears the visuals down
    assert.equal(m.getMode(), "roll", "falls back while there is nothing to show");
    m.setVisualsAvailable(true); // play again
    assert.equal(m.getMode(), "visuals");
  });

  test("picking another mode while stopped cancels the return", () => {
    const m = createBottomPanelModes();
    m.setVisualsAvailable(true);
    m.setMode("visuals");
    m.setVisualsAvailable(false);
    m.setMode("scope");
    m.setVisualsAvailable(true);
    assert.equal(m.getMode(), "scope");
  });

  test("a user who was not in Visuals is never moved there", () => {
    const m = createBottomPanelModes();
    m.setVisualsAvailable(true);
    m.setVisualsAvailable(false);
    m.setVisualsAvailable(true);
    assert.equal(m.getMode(), "roll");
  });

  test("repeated availability notifications are idempotent", () => {
    const m = createBottomPanelModes();
    const seen = [];
    m.setOnChange((mode) => seen.push(mode));
    m.setVisualsAvailable(true);
    m.setMode("visuals");
    m.setVisualsAvailable(true);
    m.setVisualsAvailable(true);
    assert.deepEqual(seen, ["visuals"]);
  });
});
