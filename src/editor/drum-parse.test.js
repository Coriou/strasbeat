import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { parseDrumLanes, READ_ONLY_REASONS } from "./drum-parse.js";

// ─── Canonical editable lanes ────────────────────────────────────────────

describe("parseDrumLanes() — editable lanes", () => {
  test("bare $: with no chain", () => {
    const code = '$: s("bd ~ sd ~")';
    const [lane] = parseDrumLanes(code);
    assert.ok(lane);
    assert.equal(lane.editable, true);
    assert.equal(lane.readOnlyReason, null);
    assert.equal(lane.callName, "s");
    assert.equal(lane.stepCount, 4);
    assert.deepEqual(
      lane.steps.map((s) => ({ kind: s.kind, sound: s.sound, variant: s.variant })),
      [
        { kind: "hit", sound: "bd", variant: null },
        { kind: "rest", sound: null, variant: null },
        { kind: "hit", sound: "sd", variant: null },
        { kind: "rest", sound: null, variant: null },
      ],
    );
    assert.equal(lane.bank, null);
    assert.equal(lane.primarySound, "bd"); // tied 1-1, returns first inserted
    assert.equal(lane.line, 1);
  });

  test("recognises sound() as well as s()", () => {
    const code = '$: sound("bd sd bd sd")';
    const [lane] = parseDrumLanes(code);
    assert.ok(lane);
    assert.equal(lane.callName, "sound");
    assert.equal(lane.stepCount, 4);
    assert.equal(lane.editable, true);
  });

  test("8-step lane is editable", () => {
    const code = '$: s("bd ~ ~ ~ sd ~ ~ ~")';
    const [lane] = parseDrumLanes(code);
    assert.equal(lane.editable, true);
    assert.equal(lane.stepCount, 8);
  });

  test("16-step lane is editable", () => {
    const code = '$: s("bd ~ bd ~ sd ~ bd ~ bd ~ bd ~ sd ~ bd ~")';
    const [lane] = parseDrumLanes(code);
    assert.equal(lane.editable, true);
    assert.equal(lane.stepCount, 16);
  });

  test("dash rest is parsed as rest", () => {
    const code = '$: s("bd - sd -")';
    const [lane] = parseDrumLanes(code);
    assert.equal(lane.editable, true);
    assert.equal(lane.steps[1].kind, "rest");
    assert.equal(lane.steps[3].kind, "rest");
  });

  test("sample variant (sound:N) is captured", () => {
    const code = '$: s("bd:2 ~ sd:1 ~")';
    const [lane] = parseDrumLanes(code);
    assert.equal(lane.editable, true);
    assert.equal(lane.steps[0].variant, 2);
    assert.equal(lane.steps[2].variant, 1);
    assert.equal(lane.steps[1].variant, null);
  });

  test("step token offsets point into the original buffer", () => {
    const code = '$: s("bd ~ sd ~")';
    const [lane] = parseDrumLanes(code);
    for (const step of lane.steps) {
      assert.equal(
        code.slice(step.tokenStart, step.tokenEnd),
        step.kind === "rest" ? (step.sound === null ? "~" : "~") : (step.variant != null ? `${step.sound}:${step.variant}` : step.sound),
      );
    }
  });

  test("primarySound is the most-common hit", () => {
    const code = '$: s("hh hh hh hh hh hh oh hh")';
    const [lane] = parseDrumLanes(code);
    assert.equal(lane.primarySound, "hh");
  });

  test("primarySound is null when every step is a rest", () => {
    const code = '$: s("~ ~ ~ ~")';
    const [lane] = parseDrumLanes(code);
    assert.equal(lane.primarySound, null);
  });

  test("bank() call is captured with arg offsets", () => {
    const code = '$: s("bd ~ sd ~").bank("RolandTR909")';
    const [lane] = parseDrumLanes(code);
    assert.ok(lane.bank);
    assert.equal(lane.bank.name, "RolandTR909");
    // Arg slice should contain the *quoted* string itself.
    assert.equal(
      code.slice(lane.bank.argStart, lane.bank.argEnd),
      '"RolandTR909"',
    );
  });

  test("missing bank returns null + insertBankAt right after s(...)", () => {
    const code = '$: s("bd ~ sd ~").gain(0.9)';
    const [lane] = parseDrumLanes(code);
    assert.equal(lane.bank, null);
    // insertBankAt should sit just after the closing paren of s("…").
    const insertAt = lane.insertBankAt;
    assert.equal(code.slice(insertAt - 1, insertAt + 5), ").gain");
  });

  test("multi-line trailing chain is preserved verbatim in otherChain", () => {
    const code = [
      '$: s("bd ~ sd ~")',
      '  .bank("RolandTR909")',
      "  .gain(0.9)",
      "  .room(0.4)",
    ].join("\n");
    const [lane] = parseDrumLanes(code);
    assert.equal(lane.editable, true);
    assert.equal(lane.bank?.name, "RolandTR909");
    // bank stripped, .gain + .room preserved with their leading whitespace.
    assert.match(lane.otherChain, /\.gain\(0\.9\)/);
    assert.match(lane.otherChain, /\.room\(0\.4\)/);
    assert.doesNotMatch(lane.otherChain, /\.bank/);
  });
});

// ─── Mute / solo label decoration ────────────────────────────────────────

describe("parseDrumLanes() — mute/solo label", () => {
  test("_$: is recognised as muted", () => {
    const code = '_$: s("bd ~ sd ~")';
    const [lane] = parseDrumLanes(code);
    assert.equal(lane.muted, true);
    assert.equal(lane.soloed, false);
    assert.equal(lane.labelName, "$");
  });

  test("$_: suffix-style mute is recognised", () => {
    const code = '$_: s("bd ~ sd ~")';
    const [lane] = parseDrumLanes(code);
    assert.equal(lane.muted, true);
  });

  test("S$: solo prefix is recognised", () => {
    const code = 'S$: s("bd ~ sd ~")';
    const [lane] = parseDrumLanes(code);
    assert.equal(lane.soloed, true);
    assert.equal(lane.muted, false);
  });
});

// ─── Read-only shapes (each maps to a specific readOnlyReason) ───────────

describe("parseDrumLanes() — read-only shapes", () => {
  test("`*N` shortcut → shortcut", () => {
    const code = '$: s("hh*8")';
    const [lane] = parseDrumLanes(code);
    assert.equal(lane.editable, false);
    assert.equal(lane.readOnlyReason, READ_ONLY_REASONS.shortcut);
  });

  test("`!N` repeat → shortcut", () => {
    const code = '$: s("bd!4")';
    const [lane] = parseDrumLanes(code);
    assert.equal(lane.editable, false);
    assert.equal(lane.readOnlyReason, READ_ONLY_REASONS.shortcut);
  });

  test("`@N` elongation → elongation", () => {
    const code = '$: s("bd@2 sd")';
    const [lane] = parseDrumLanes(code);
    assert.equal(lane.editable, false);
    assert.equal(lane.readOnlyReason, READ_ONLY_REASONS.elongation);
  });

  test("`<a b>` alternation → alternation", () => {
    const code = '$: s("bd <sd sd:1> bd sd")';
    const [lane] = parseDrumLanes(code);
    assert.equal(lane.editable, false);
    assert.equal(lane.readOnlyReason, READ_ONLY_REASONS.alternation);
  });

  test("`[a b]` subdivision → subdivision", () => {
    const code = '$: s("bd [~ sd] bd sd")';
    const [lane] = parseDrumLanes(code);
    assert.equal(lane.editable, false);
    assert.equal(lane.readOnlyReason, READ_ONLY_REASONS.subdivision);
  });

  test("polyrhythm comma → polyrhythm", () => {
    const code = '$: s("bd*2, hh*8")';
    const [lane] = parseDrumLanes(code);
    assert.equal(lane.editable, false);
    // shortcut wins over polyrhythm in the priority order; both indicate non-editability.
    assert.ok(
      lane.readOnlyReason === READ_ONLY_REASONS.polyrhythm ||
        lane.readOnlyReason === READ_ONLY_REASONS.shortcut,
    );
  });

  test(".struct(...) wrapping a flat string → struct", () => {
    const code = '$: s("bd:6").struct("x - x - x x - x")';
    const [lane] = parseDrumLanes(code);
    assert.equal(lane.editable, false);
    assert.equal(lane.readOnlyReason, READ_ONLY_REASONS.struct);
    // The step string itself is still flat-parseable, so steps[] is populated
    // (the readOnlyReason flips it to read-only because struct() supersedes).
    assert.equal(lane.steps.length, 1);
    assert.equal(lane.steps[0].sound, "bd");
  });

  test("non-standard step count (e.g. 5) → badStepCount", () => {
    const code = '$: s("bd ~ sd ~ hh")';
    const [lane] = parseDrumLanes(code);
    assert.equal(lane.editable, false);
    assert.equal(lane.readOnlyReason, READ_ONLY_REASONS.badStepCount);
    // Steps still parsed for read-only display.
    assert.equal(lane.steps.length, 5);
  });
});

// ─── Lines we ignore entirely ────────────────────────────────────────────

describe("parseDrumLanes() — skipped lines", () => {
  test("$: stack(...) is skipped", () => {
    const code = '$: stack(s("bd"), s("sd"))';
    assert.deepEqual(parseDrumLanes(code), []);
  });

  test('$: note(...) is skipped', () => {
    const code = '$: note("c3 e3 g3").s("piano")';
    assert.deepEqual(parseDrumLanes(code), []);
  });

  test("$: chord(...) is skipped", () => {
    const code = '$: chord("<Cm7 F7>").voicing().s("gm_epiano1")';
    assert.deepEqual(parseDrumLanes(code), []);
  });

  test("$: progression(...) is skipped", () => {
    const code = "$: progression('Cm7 F7', { rhythm: 'arp-up' })";
    assert.deepEqual(parseDrumLanes(code), []);
  });

  test("named labels (drums:, kick:) are skipped per spec", () => {
    const code = 'drums: s("bd ~ sd ~").bank("RolandTR909")';
    assert.deepEqual(parseDrumLanes(code), []);
  });

  test("`$:` inside a string literal is not picked up", () => {
    const code = `var msg = "tip: use $: prefix"\n$: s("bd ~ sd ~")`;
    const lanes = parseDrumLanes(code);
    assert.equal(lanes.length, 1);
    assert.equal(lanes[0].line, 2);
  });

  test("`$:` inside a line comment is not picked up", () => {
    const code = `// $: s("bd")\n$: s("sd ~ sd ~")`;
    const lanes = parseDrumLanes(code);
    assert.equal(lanes.length, 1);
    assert.equal(lanes[0].steps[0].sound, "sd");
  });
});

// ─── Multiple lanes in one buffer ────────────────────────────────────────

describe("parseDrumLanes() — multi-lane buffers", () => {
  test("returns lanes in source order", () => {
    const code = [
      "setcpm(120/4)",
      "",
      '$: s("bd ~ bd ~").bank("RolandTR909")',
      '$: s("~ sd ~ sd").bank("RolandTR909")',
      '$: s("hh hh hh hh hh hh oh hh").bank("RolandTR909")',
    ].join("\n");
    const lanes = parseDrumLanes(code);
    assert.equal(lanes.length, 3);
    assert.deepEqual(
      lanes.map((l) => ({ line: l.line, primary: l.primarySound, n: l.stepCount })),
      [
        { line: 3, primary: "bd", n: 4 },
        { line: 4, primary: "sd", n: 4 },
        { line: 5, primary: "hh", n: 8 },
      ],
    );
  });

  test("editable and read-only lanes coexist in source order", () => {
    const code = [
      '$: s("bd ~ sd ~")',
      '$: s("hh*8")',
      '$: s("bd:6").struct("x - x -")',
    ].join("\n");
    const lanes = parseDrumLanes(code);
    assert.equal(lanes.length, 3);
    assert.equal(lanes[0].editable, true);
    assert.equal(lanes[1].editable, false);
    assert.equal(lanes[1].readOnlyReason, READ_ONLY_REASONS.shortcut);
    assert.equal(lanes[2].editable, false);
    assert.equal(lanes[2].readOnlyReason, READ_ONLY_REASONS.struct);
  });
});

// ─── Robustness ──────────────────────────────────────────────────────────

describe("parseDrumLanes() — robustness", () => {
  test("unterminated string does not throw, just skips the lane", () => {
    const code = '$: s("bd ~ sd ~';
    assert.doesNotThrow(() => parseDrumLanes(code));
    assert.deepEqual(parseDrumLanes(code), []);
  });

  test("missing closing paren does not throw, skips the lane", () => {
    const code = '$: s("bd ~ sd ~"';
    assert.doesNotThrow(() => parseDrumLanes(code));
    assert.deepEqual(parseDrumLanes(code), []);
  });

  test("empty buffer", () => {
    assert.deepEqual(parseDrumLanes(""), []);
  });

  test("buffer with only whitespace", () => {
    assert.deepEqual(parseDrumLanes("   \n\n  \n"), []);
  });

  test("template literals and block comments are skipped", () => {
    const code = `/* $: s("bd") */\n\`\`\`$: s("sd")\`\`\`\n$: s("hh hh hh hh")`;
    const lanes = parseDrumLanes(code);
    assert.equal(lanes.length, 1);
    assert.equal(lanes[0].primarySound, "hh");
  });

  test("leading whitespace before $: is tolerated", () => {
    const code = '   $: s("bd ~ sd ~")';
    const [lane] = parseDrumLanes(code);
    assert.ok(lane);
    assert.equal(lane.editable, true);
  });

  test("interior comment between chain methods is preserved in otherChain", () => {
    const code = [
      '$: s("bd ~ sd ~")',
      "  // turn it down a touch",
      "  .gain(0.5)",
    ].join("\n");
    const [lane] = parseDrumLanes(code);
    assert.ok(lane);
    assert.match(lane.otherChain, /turn it down/);
    assert.match(lane.otherChain, /\.gain\(0\.5\)/);
  });
});

// ─── Range / offset sanity ───────────────────────────────────────────────

describe("parseDrumLanes() — offsets", () => {
  test("stepStart/stepEnd bracket the step text without quotes", () => {
    const code = '$: s("bd ~ sd ~").bank("RolandTR909")';
    const [lane] = parseDrumLanes(code);
    assert.equal(code.slice(lane.stepStart, lane.stepEnd), "bd ~ sd ~");
    assert.equal(code.slice(lane.stringStart, lane.stringEnd), '"bd ~ sd ~"');
  });

  test("lineStart points at the label's first char", () => {
    const code = "// header\n$: s(\"bd ~ sd ~\")";
    const [lane] = parseDrumLanes(code);
    assert.equal(code.slice(lane.lineStart, lane.lineStart + 2), "$:");
  });

  test("lineEnd extends across multi-line chain", () => {
    const code = [
      '$: s("bd ~ sd ~")',
      "  .gain(0.5)",
      "next: 1",
    ].join("\n");
    const [lane] = parseDrumLanes(code);
    // lineEnd should be the EOL after `.gain(0.5)`, not after the first line.
    const tail = code.slice(0, lane.lineEnd);
    assert.match(tail, /\.gain\(0\.5\)\s*$/);
  });
});
