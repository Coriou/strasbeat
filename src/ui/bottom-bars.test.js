// Run with: node --import ./scripts/test-register.mjs --test src/ui/bottom-bars.test.js
//
// The track bar and the arrange bar re-run on every keystroke and keep
// whatever DOM still matches. These signatures are that "still matches" test.

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { entrySignature } from "./track-bar.js";
import { rowSignature } from "./arrange-bar.js";
import { parseLabels } from "../editor/track-labels.js";
import { parseArrangements } from "../editor/arrange-parse.js";

describe("track bar entrySignature()", () => {
  const code = 'drums: s("bd sd")\nbass: note("c2")\n';
  const sigs = (text) => parseLabels(text).map(entrySignature);

  test("survives edits that only move the track", () => {
    assert.deepEqual(sigs("// intro\n\n" + code), sigs(code));
    assert.deepEqual(sigs(code.replace("bd sd", "bd sd hh")), sigs(code));
  });

  test("changes with the name and with mute / solo", () => {
    const base = sigs(code);
    assert.notEqual(sigs(code.replace("drums:", "kit:"))[0], base[0]);
    assert.notEqual(sigs(code.replace("drums:", "_drums:"))[0], base[0]);
    assert.notEqual(sigs(code.replace("drums:", "Sdrums:"))[0], base[0]);
    assert.equal(sigs(code.replace("drums:", "_drums:"))[1], base[1]);
  });
});

describe("arrange bar rowSignature()", () => {
  const code = 'arrange(\n  [4, s("bd")],\n  [2, s("hh")],\n)';
  const spec = (text, over = {}) => {
    const parsed = parseArrangements(text)[0];
    return {
      entry: {
        sections: parsed.sections.map((s) => ({ cycles: s.cycles, label: s.label, sourceStart: s.start })),
        totalCycles: parsed.totalCycles,
        sourceLine: parsed.line,
      },
      arrangeIndex: 0,
      usingParser: true,
      previewReason: "not yet played",
      showLineNumber: false,
      trailingTransform: null,
      mutedByTrack: false,
      ...over,
    };
  };

  test("survives edits that only move the arrangement", () => {
    const moved = "// intro\n" + code;
    assert.notEqual(spec(moved).entry.sections[0].sourceStart, spec(code).entry.sections[0].sourceStart);
    assert.equal(rowSignature(spec(moved), null), rowSignature(spec(code), null));
  });

  test("the line number counts only when it is displayed", () => {
    const moved = "// intro\n" + code;
    assert.notEqual(
      rowSignature(spec(moved, { showLineNumber: true }), null),
      rowSignature(spec(code, { showLineNumber: true }), null),
    );
  });

  test("changes with section lengths, preview state, mute, transform and solo", () => {
    const base = rowSignature(spec(code), null);
    assert.notEqual(rowSignature(spec(code.replace("[4,", "[8,")), null), base);
    assert.notEqual(rowSignature(spec(code, { usingParser: false, previewReason: null }), null), base);
    assert.notEqual(rowSignature(spec(code, { previewReason: "edited since last play" }), null), base);
    assert.notEqual(rowSignature(spec(code, { mutedByTrack: true }), null), base);
    assert.notEqual(
      rowSignature(spec(code, { trailingTransform: { method: "fast", argText: "2" } }), null),
      base,
    );
    assert.notEqual(rowSignature(spec(code), { arrangeIndex: 0, sectionIndex: 1 }), base);
    // A solo in another arrangement does not concern this row.
    assert.equal(rowSignature(spec(code), { arrangeIndex: 3, sectionIndex: 1 }), base);
  });
});
