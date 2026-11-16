import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
  chipReadout,
  formatChipLabel,
  hintAnchor,
  placeAbove,
} from "./keymap-chip-format.js";
import { formatShortcut, localizeShortcuts } from "./shortcut-format.js";
import { getProfile, KEYMAP_PROFILES } from "../editor/keymap-profiles.js";

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

describe("chipReadout(): the chip never names a keymap that is not in force", () => {
  test("a keymap still being fetched reads as loading, with no mode", () => {
    const vim = chipReadout(getProfile("vim"), null, "loading");
    assert.equal(vim.state, "loading");
    assert.equal(vim.text, "LOADING");
    assert.match(vim.title, /Vim keymap/);
    assert.doesNotMatch(formatChipLabel(getProfile("vim"), "NORMAL", "loading"), /NORMAL/);
    // Not modal, but just as absent until its code arrives.
    assert.equal(chipReadout(getProfile("emacs"), null, "loading").text, "LOADING");
    // Asked for nothing yet is not "in force" either.
    assert.equal(chipReadout(getProfile("vim"), null, "idle").state, "loading");
  });

  test("a failed fetch reads as failed and says how to retry", () => {
    const vim = chipReadout(getProfile("vim"), "INSERT", "failed");
    assert.equal(vim.state, "failed");
    assert.doesNotMatch(vim.text, /INSERT|NORMAL/);
    assert.match(vim.title, /try again/);
    assert.equal(chipReadout(getProfile("emacs"), null, "failed").state, "failed");
  });

  test("once in force: the mode for modal profiles, nothing for the rest", () => {
    assert.deepEqual(chipReadout(getProfile("vim"), "insert", "ready"), {
      state: "ready",
      text: "INSERT",
      title: null,
    });
    assert.equal(chipReadout(getProfile("emacs"), null, "ready").text, null);
    assert.equal(chipReadout(getProfile("strudel"), null).text, null);
  });
});

describe("placeAbove(): the first-run hint over the Play button", () => {
  const viewport = { width: 1440, height: 900 };
  const play = { left: 12, top: 662, right: 116, bottom: 690 };
  const size = { width: 280, height: 58 };

  test("sits fully above the anchor, never overlapping it", () => {
    const { left, top } = placeAbove({ anchor: play, size, viewport });
    assert.equal(left, 12);
    assert.ok(top + size.height <= play.top - 8);
  });

  test("stays inside a phone-width viewport", () => {
    const phone = { width: 390, height: 844 };
    const wide = { width: 374, height: 76 };
    const { left } = placeAbove({ anchor: { ...play, left: 200 }, size: wide, viewport: phone });
    assert.ok(left >= 8);
    assert.ok(left + wide.width <= phone.width - 8);
  });

  test("clears every row of a wrapped transport, not just Play's own", () => {
    const phone = { width: 390, height: 844 };
    const card = { width: 280, height: 95 };
    // Play sits on the second row here; the first row is 40px above it.
    const transport = { left: 0, top: 560, right: 390, bottom: 640 };
    const wrappedPlay = { left: 12, top: 604, right: 80, bottom: 632 };
    const { top } = placeAbove({
      anchor: hintAnchor(wrappedPlay, transport),
      size: card,
      viewport: phone,
    });
    assert.ok(top + card.height <= transport.top - 8);
    // Without a transport to measure, Play itself is the anchor.
    assert.deepEqual(hintAnchor(wrappedPlay, undefined), { left: 12, top: 604 });
  });

  test("never leaves the top of the viewport", () => {
    const { top } = placeAbove({
      anchor: { left: 12, top: 20 },
      size,
      viewport,
    });
    assert.equal(top, 8);
  });
});

describe("shortcut text is spelled one way per platform", () => {
  test("macOS uses modifier glyphs with no separators", () => {
    assert.equal(formatShortcut("Mod+Shift+P", true), "⌘⇧P");
    assert.equal(formatShortcut("Mod+Enter", true), "⌘↵");
    assert.equal(formatShortcut("Mod+Backspace", true), "⌘⌫");
    assert.equal(formatShortcut("Mod+D", true), "⌘D");
    assert.equal(formatShortcut("Enter", true), "↵");
    assert.equal(formatShortcut("F2", true), "F2");
  });

  test("other platforms spell the keys out, joined with +", () => {
    assert.equal(formatShortcut("Mod+Shift+P", false), "Ctrl+Shift+P");
    assert.equal(formatShortcut("Mod+Enter", false), "Ctrl+Enter");
    assert.equal(formatShortcut("Mod+Backspace", false), "Ctrl+Backspace");
    assert.equal(formatShortcut("Enter", false), "Enter");
    assert.equal(formatShortcut("F2", false), "F2");
  });

  test("profile descriptions are rewritten in place, prose untouched", () => {
    const strudel = getProfile("strudel").description;
    assert.equal(
      localizeShortcuts(strudel, true),
      "Matches strudel.cc · ⌃↵ play, ⌃. stop",
    );
    assert.equal(
      localizeShortcuts(strudel, false),
      "Matches strudel.cc · Ctrl+Enter play, Ctrl+. stop",
    );
    const vscode = getProfile("vscode").description;
    assert.equal(
      localizeShortcuts(vscode, true),
      "⌘D selectNext, ⌘⇧K delete line, ⌥↓ move",
    );
    assert.equal(
      localizeShortcuts(vscode, false),
      "Ctrl+D selectNext, Ctrl+Shift+K delete line, Alt+↓ move",
    );
  });

  test("no description mixes glyph and spelled-out modifiers", () => {
    for (const profile of KEYMAP_PROFILES) {
      assert.doesNotMatch(
        localizeShortcuts(profile.description, true),
        /\b(Cmd|Ctrl|Alt|Shift)\+/,
      );
      assert.doesNotMatch(
        localizeShortcuts(profile.description, false),
        /[⌘⌃⌥⇧]|\bCmd\+/,
      );
    }
  });

  test("Emacs chord notation is left alone", () => {
    const emacs = getProfile("emacs").description;
    assert.equal(localizeShortcuts(emacs, true), emacs);
    assert.equal(localizeShortcuts(emacs, false), emacs);
  });
});
