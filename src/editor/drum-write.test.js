import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { parseDrumLanes } from "./drum-parse.js";
import {
  buildAddLaneText,
  changeForAddLane,
  changeForBankSet,
  changeForCellOff,
  changeForCellOn,
  changeForCycleVariant,
  changeForDeleteLane,
  changeForDuplicateLane,
  changeForMuteToggle,
  changeForNormaliseShortcut,
  changeForMoveLane,
  changeForReorderLanes,
  changeForSoloToggle,
  changeForSoundSwap,
  changeForUpgradeResolution,
  changeForVariant,
  changesForPaint,
  defaultSoundFor,
  expandShortcut,
  formatStepToken,
  getSampleCount,
  laneUsesExplicitVariants,
  resolveSoundKey,
} from "./drum-write.js";

// Helper: parse + apply a computed change, return the resulting source.
function apply(code, change) {
  if (!change) return null;
  return (
    code.slice(0, change.from) + change.insert + code.slice(change.to)
  );
}

// Apply an array of changes — expects them sorted ascending by `from`.
function applyMany(code, changes) {
  if (!changes || changes.length === 0) return code;
  let next = code;
  for (let i = changes.length - 1; i >= 0; i--) {
    next = apply(next, changes[i]);
  }
  return next;
}

// ─── formatStepToken ─────────────────────────────────────────────────────

describe("formatStepToken()", () => {
  test("rest → ~", () => {
    assert.equal(formatStepToken({ kind: "rest" }), "~");
  });

  test("hit with no variant → bare sound", () => {
    assert.equal(
      formatStepToken({ kind: "hit", sound: "bd", variant: null }),
      "bd",
    );
  });

  test("hit with variant 0 → bare sound (suffix suppressed)", () => {
    assert.equal(
      formatStepToken({ kind: "hit", sound: "bd", variant: 0 }),
      "bd",
    );
  });

  test("hit with variant 2 → sound:2", () => {
    assert.equal(
      formatStepToken({ kind: "hit", sound: "bd", variant: 2 }),
      "bd:2",
    );
  });
});

// ─── laneUsesExplicitVariants ────────────────────────────────────────────

describe("laneUsesExplicitVariants()", () => {
  test("false for lane with no variant suffixes", () => {
    const [lane] = parseDrumLanes('$: s("bd ~ sd ~")');
    assert.equal(laneUsesExplicitVariants(lane), false);
  });

  test("true when any hit carries :N", () => {
    const [lane] = parseDrumLanes('$: s("bd:2 ~ sd ~")');
    assert.equal(laneUsesExplicitVariants(lane), true);
  });

  test("false for all-rest lane", () => {
    const [lane] = parseDrumLanes('$: s("~ ~ ~ ~")');
    assert.equal(laneUsesExplicitVariants(lane), false);
  });
});

// ─── defaultSoundFor ─────────────────────────────────────────────────────

describe("defaultSoundFor()", () => {
  test("returns primarySound when present", () => {
    const [lane] = parseDrumLanes('$: s("hh hh hh hh hh hh oh hh")');
    assert.equal(defaultSoundFor(lane), "hh");
  });

  test("falls back to first hit when tied", () => {
    const [lane] = parseDrumLanes('$: s("bd sd bd sd")');
    // primarySound is whichever appears first with the max count.
    assert.equal(defaultSoundFor(lane), "bd");
  });

  test("returns null for all-rest lane", () => {
    const [lane] = parseDrumLanes('$: s("~ ~ ~ ~")');
    assert.equal(defaultSoundFor(lane), null);
  });
});

// ─── changeForCellOn ─────────────────────────────────────────────────────

describe("changeForCellOn()", () => {
  test("rest → primarySound on a bare-sound lane", () => {
    const code = '$: s("bd ~ sd ~")';
    const [lane] = parseDrumLanes(code);
    const change = changeForCellOn(lane, 1); // the first rest at index 1
    assert.ok(change);
    assert.equal(change.insert, "bd"); // lane has no explicit variants
    assert.equal(apply(code, change), '$: s("bd bd sd ~")');
  });

  test("rest → sound:0 when lane already uses explicit variants", () => {
    const code = '$: s("bd:2 ~ sd:1 ~")';
    const [lane] = parseDrumLanes(code);
    const change = changeForCellOn(lane, 1);
    assert.ok(change);
    assert.equal(change.insert, "bd:0");
  });

  test("caller can override sound and variant", () => {
    const code = '$: s("bd ~ sd ~")';
    const [lane] = parseDrumLanes(code);
    const change = changeForCellOn(lane, 1, { sound: "cp", variant: 3 });
    assert.ok(change);
    assert.equal(change.insert, "cp:3");
    assert.equal(apply(code, change), '$: s("bd cp:3 sd ~")');
  });

  test("returns null on all-rest lane with no fallback sound", () => {
    const code = '$: s("~ ~ ~ ~")';
    const [lane] = parseDrumLanes(code);
    assert.equal(changeForCellOn(lane, 0), null);
  });

  test("caller-supplied sound wins even on all-rest lane", () => {
    const code = '$: s("~ ~ ~ ~")';
    const [lane] = parseDrumLanes(code);
    const change = changeForCellOn(lane, 0, { sound: "bd" });
    assert.ok(change);
    assert.equal(change.insert, "bd");
  });

  test("out-of-range stepIndex returns null", () => {
    const code = '$: s("bd ~ sd ~")';
    const [lane] = parseDrumLanes(code);
    assert.equal(changeForCellOn(lane, 99), null);
  });
});

// ─── changeForCellOff ────────────────────────────────────────────────────

describe("changeForCellOff()", () => {
  test("hit → ~ preserves surrounding whitespace", () => {
    const code = '$: s("bd ~ sd ~")';
    const [lane] = parseDrumLanes(code);
    const change = changeForCellOff(lane, 0);
    assert.equal(apply(code, change), '$: s("~ ~ sd ~")');
  });

  test("variant hit → ~ drops the :N suffix", () => {
    const code = '$: s("bd:2 ~ sd ~")';
    const [lane] = parseDrumLanes(code);
    const change = changeForCellOff(lane, 0);
    assert.equal(apply(code, change), '$: s("~ ~ sd ~")');
  });

  test("out-of-range stepIndex returns null", () => {
    const [lane] = parseDrumLanes('$: s("bd ~ sd ~")');
    assert.equal(changeForCellOff(lane, 99), null);
  });
});

// ─── changeForVariant ────────────────────────────────────────────────────

describe("changeForVariant()", () => {
  test("set :2 on bare sound", () => {
    const code = '$: s("bd ~ sd ~")';
    const [lane] = parseDrumLanes(code);
    const change = changeForVariant(lane, 0, 2);
    assert.equal(apply(code, change), '$: s("bd:2 ~ sd ~")');
  });

  test("set :0 collapses to bare sound", () => {
    const code = '$: s("bd:2 ~ sd ~")';
    const [lane] = parseDrumLanes(code);
    const change = changeForVariant(lane, 0, 0);
    assert.equal(apply(code, change), '$: s("bd ~ sd ~")');
  });

  test("refuses to set variant on a rest cell", () => {
    const code = '$: s("bd ~ sd ~")';
    const [lane] = parseDrumLanes(code);
    assert.equal(changeForVariant(lane, 1, 2), null);
  });

  test("replaces an existing variant", () => {
    const code = '$: s("bd:3 ~ sd ~")';
    const [lane] = parseDrumLanes(code);
    const change = changeForVariant(lane, 0, 7);
    assert.equal(apply(code, change), '$: s("bd:7 ~ sd ~")');
  });
});

// ─── changeForCycleVariant ───────────────────────────────────────────────

describe("changeForCycleVariant()", () => {
  test("bare sound → :1 (cycle from implicit 0)", () => {
    const code = '$: s("bd ~ sd ~")';
    const [lane] = parseDrumLanes(code);
    const change = changeForCycleVariant(lane, 0, 3);
    assert.equal(apply(code, change), '$: s("bd:1 ~ sd ~")');
  });

  test(":1 → :2 within range", () => {
    const code = '$: s("bd:1 ~ sd ~")';
    const [lane] = parseDrumLanes(code);
    const change = changeForCycleVariant(lane, 0, 3);
    assert.equal(apply(code, change), '$: s("bd:2 ~ sd ~")');
  });

  test("wraps back to 0 at max", () => {
    const code = '$: s("bd:3 ~ sd ~")';
    const [lane] = parseDrumLanes(code);
    const change = changeForCycleVariant(lane, 0, 3);
    assert.equal(apply(code, change), '$: s("bd ~ sd ~")');
  });

  test("at-max also wraps when current variant exceeds reported max", () => {
    const code = '$: s("bd:9 ~ sd ~")';
    const [lane] = parseDrumLanes(code);
    const change = changeForCycleVariant(lane, 0, 3);
    assert.equal(apply(code, change), '$: s("bd ~ sd ~")');
  });

  test("refuses to cycle on a rest cell", () => {
    const [lane] = parseDrumLanes('$: s("bd ~ sd ~")');
    assert.equal(changeForCycleVariant(lane, 1, 3), null);
  });

  test("maxVariant of 0 is a no-op cycle (0 → 0)", () => {
    const code = '$: s("bd ~ sd ~")';
    const [lane] = parseDrumLanes(code);
    const change = changeForCycleVariant(lane, 0, 0);
    // 0 → 0 cycles but should still produce a valid change
    // (the UI will skip no-ops before dispatch).
    assert.ok(change);
    assert.equal(change.insert, "bd");
  });
});

// ─── changesForPaint ─────────────────────────────────────────────────────

describe("changesForPaint()", () => {
  test("builds a sorted, de-duplicated changes array", () => {
    const code = '$: s("bd ~ sd ~ bd ~ sd ~")';
    const [lane] = parseDrumLanes(code);
    const ops = [
      { stepIndex: 5, action: "on", sound: "hh" },
      { stepIndex: 1, action: "on", sound: "hh" },
      // Duplicate stepIndex — second occurrence dropped.
      { stepIndex: 1, action: "off" },
      { stepIndex: 3, action: "on", sound: "hh" },
    ];
    const changes = changesForPaint(lane, ops);
    assert.equal(changes.length, 3);
    // Ascending order by `from`.
    for (let i = 1; i < changes.length; i++) {
      assert.ok(changes[i].from > changes[i - 1].from);
    }
  });

  test("skips no-op changes (cell already in target state)", () => {
    const code = '$: s("bd ~ sd ~")';
    const [lane] = parseDrumLanes(code);
    const changes = changesForPaint(lane, [
      { stepIndex: 0, action: "on", sound: "bd" }, // already on as "bd"
      { stepIndex: 1, action: "off" }, // already off
      { stepIndex: 2, action: "on", sound: "hh" }, // meaningful change
    ]);
    assert.equal(changes.length, 1);
    assert.equal(changes[0].insert, "hh");
  });

  test("changes apply cleanly in a single dispatch", () => {
    const code = '$: s("~ ~ ~ ~ ~ ~ ~ ~")';
    const [lane] = parseDrumLanes(code);
    const changes = changesForPaint(lane, [
      { stepIndex: 0, action: "on", sound: "bd" },
      { stepIndex: 2, action: "on", sound: "bd" },
      { stepIndex: 4, action: "on", sound: "bd" },
      { stepIndex: 6, action: "on", sound: "bd" },
    ]);
    // Apply in reverse so offsets stay stable.
    let next = code;
    for (let i = changes.length - 1; i >= 0; i--) {
      next = apply(next, changes[i]);
    }
    assert.equal(next, '$: s("bd ~ bd ~ bd ~ bd ~")');
  });
});

// ─── getSampleCount ──────────────────────────────────────────────────────

describe("getSampleCount()", () => {
  const fakeMap = {
    bd: { data: { samples: ["a.wav"] } },
    RolandTR909_bd: { data: { samples: ["a.wav", "b.wav", "c.wav"] } },
    gm_piano: {
      data: { samples: { c4: ["a.wav"], c5: ["b.wav", "c.wav"] } },
    },
    empty: { data: {} },
  };

  test("plain sound with array samples", () => {
    assert.equal(getSampleCount(fakeMap, null, "bd"), 1);
  });

  test("bank-prefixed sound prefers the banked entry", () => {
    assert.equal(getSampleCount(fakeMap, "RolandTR909", "bd"), 3);
  });

  test("object samples sum across keys", () => {
    assert.equal(getSampleCount(fakeMap, null, "gm_piano"), 3);
  });

  test("missing sound falls back to 1 (no variants to cycle)", () => {
    assert.equal(getSampleCount(fakeMap, null, "not_real"), 1);
  });

  test("entry without samples treats as 1", () => {
    assert.equal(getSampleCount(fakeMap, null, "empty"), 1);
  });

  test("null soundMap is handled defensively", () => {
    assert.equal(getSampleCount(null, null, "bd"), 1);
  });
});

// ─── resolveSoundKey ─────────────────────────────────────────────────────

describe("resolveSoundKey()", () => {
  const fakeMap = {
    bd: { data: {} },
    RolandTR909_bd: { data: {} },
  };

  test("returns plain sound without bank", () => {
    assert.equal(resolveSoundKey(fakeMap, null, "bd"), "bd");
  });

  test("returns banked key when it exists", () => {
    assert.equal(resolveSoundKey(fakeMap, "RolandTR909", "bd"), "RolandTR909_bd");
  });

  test("falls back to plain sound when banked key is missing", () => {
    assert.equal(resolveSoundKey(fakeMap, "UnknownBank", "bd"), "bd");
  });

  test("returns null for missing sound", () => {
    assert.equal(resolveSoundKey(fakeMap, null, null), null);
  });
});

// ─── changeForMuteToggle ─────────────────────────────────────────────────

describe("changeForMuteToggle()", () => {
  test("plain $ → _$", () => {
    const code = '$: s("bd ~ sd ~")';
    const [lane] = parseDrumLanes(code);
    const change = changeForMuteToggle(lane);
    assert.equal(apply(code, change), '_$: s("bd ~ sd ~")');
  });

  test("_$ → $ (round-trip)", () => {
    const code = '_$: s("bd ~ sd ~")';
    const [lane] = parseDrumLanes(code);
    const change = changeForMuteToggle(lane);
    assert.equal(apply(code, change), '$: s("bd ~ sd ~")');
  });

  test("preserves solo: S$ → S$_ (suffix style when no prefix mute)", () => {
    const code = 'S$: s("bd ~ sd ~")';
    const [lane] = parseDrumLanes(code);
    const change = changeForMuteToggle(lane);
    // When solo is present, mute goes to the suffix — matches track-labels.js.
    assert.equal(apply(code, change), 'S$_: s("bd ~ sd ~")');
  });

  test("S$_ → S$ (unmute with solo intact)", () => {
    const code = 'S$_: s("bd ~ sd ~")';
    const [lane] = parseDrumLanes(code);
    const change = changeForMuteToggle(lane);
    assert.equal(apply(code, change), 'S$: s("bd ~ sd ~")');
  });
});

// ─── changeForSoloToggle ─────────────────────────────────────────────────

describe("changeForSoloToggle()", () => {
  test("plain $ → S$", () => {
    const code = '$: s("bd ~ sd ~")';
    const [lane] = parseDrumLanes(code);
    const change = changeForSoloToggle(lane);
    assert.equal(apply(code, change), 'S$: s("bd ~ sd ~")');
  });

  test("S$ → $ (round-trip)", () => {
    const code = 'S$: s("bd ~ sd ~")';
    const [lane] = parseDrumLanes(code);
    const change = changeForSoloToggle(lane);
    assert.equal(apply(code, change), '$: s("bd ~ sd ~")');
  });

  test("preserves mute prefix: _$ → S_$?  (prefix mute blocks solo → we fold into S$_ variant)", () => {
    const code = '_$: s("bd ~ sd ~")';
    const [lane] = parseDrumLanes(code);
    const change = changeForSoloToggle(lane);
    // Solo turns on. The mute style in `_$` is prefix; since `S` takes
    // the prefix slot, the label promotes to `S$_` so both decorations
    // coexist without confusing the parser.
    assert.equal(apply(code, change), 'S$_: s("bd ~ sd ~")');
  });
});

// ─── changeForBankSet ────────────────────────────────────────────────────

describe("changeForBankSet()", () => {
  test("insert new .bank(\"…\") when lane has no bank", () => {
    const code = '$: s("bd ~ sd ~")';
    const [lane] = parseDrumLanes(code);
    const change = changeForBankSet(lane, "RolandTR909", code);
    assert.equal(apply(code, change), '$: s("bd ~ sd ~").bank("RolandTR909")');
  });

  test("replace existing bank arg", () => {
    const code = '$: s("bd ~ sd ~").bank("RolandTR909")';
    const [lane] = parseDrumLanes(code);
    const change = changeForBankSet(lane, "RolandTR808", code);
    assert.equal(apply(code, change), '$: s("bd ~ sd ~").bank("RolandTR808")');
  });

  test("delete .bank(…) call when bankName is null", () => {
    const code = '$: s("bd ~ sd ~").bank("RolandTR909")';
    const [lane] = parseDrumLanes(code);
    const change = changeForBankSet(lane, null, code);
    assert.equal(apply(code, change), '$: s("bd ~ sd ~")');
  });

  test("preserves other chain calls when deleting bank", () => {
    const code = '$: s("bd ~ sd ~").bank("RolandTR909").gain(0.9)';
    const [lane] = parseDrumLanes(code);
    const change = changeForBankSet(lane, null, code);
    assert.equal(apply(code, change), '$: s("bd ~ sd ~").gain(0.9)');
  });

  test("preserves other chain calls when replacing bank", () => {
    const code = '$: s("bd ~ sd ~").bank("RolandTR909").gain(0.9)';
    const [lane] = parseDrumLanes(code);
    const change = changeForBankSet(lane, "RolandTR808", code);
    assert.equal(
      apply(code, change),
      '$: s("bd ~ sd ~").bank("RolandTR808").gain(0.9)',
    );
  });

  test("no-op when no bank and clearing", () => {
    const code = '$: s("bd ~ sd ~")';
    const [lane] = parseDrumLanes(code);
    assert.equal(changeForBankSet(lane, null, code), null);
  });
});

// ─── changeForSoundSwap ──────────────────────────────────────────────────

describe("changeForSoundSwap()", () => {
  test("swaps every matching hit's sound, preserving variants", () => {
    const code = '$: s("bd ~ bd:2 ~").bank("RolandTR909")';
    const [lane] = parseDrumLanes(code);
    const changes = changeForSoundSwap(lane, "bd", "cp");
    assert.equal(changes.length, 2);
    assert.equal(
      applyMany(code, changes),
      '$: s("cp ~ cp:2 ~").bank("RolandTR909")',
    );
  });

  test("preserves mixed-sound rows (sd cells left alone)", () => {
    // :0 collapses to bare sound via formatStepToken — matches the rule
    // documented in formatStepToken() and changeForVariant().
    const code = '$: s("bd:0 sd:1 bd:0 sd:1")';
    const [lane] = parseDrumLanes(code);
    const changes = changeForSoundSwap(lane, "bd", "cp");
    assert.equal(changes.length, 2);
    assert.equal(applyMany(code, changes), '$: s("cp sd:1 cp sd:1")');
  });

  test("no-op when from === to", () => {
    const code = '$: s("bd ~ bd ~")';
    const [lane] = parseDrumLanes(code);
    assert.deepEqual(changeForSoundSwap(lane, "bd", "bd"), []);
  });

  test("empty changes when sound not present", () => {
    const code = '$: s("bd ~ bd ~")';
    const [lane] = parseDrumLanes(code);
    assert.deepEqual(changeForSoundSwap(lane, "hh", "cp"), []);
  });
});

// ─── buildAddLaneText + changeForAddLane ─────────────────────────────────

describe("buildAddLaneText()", () => {
  test("16-step lane, sound on step 0, no bank", () => {
    assert.equal(
      buildAddLaneText("hh", null),
      '$: s("hh ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~")',
    );
  });

  test("applies bank when given", () => {
    assert.equal(
      buildAddLaneText("bd", "RolandTR909"),
      '$: s("bd ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~").bank("RolandTR909")',
    );
  });

  test("custom step count", () => {
    assert.equal(buildAddLaneText("sd", null, 4), '$: s("sd ~ ~ ~")');
  });

  test("returns null when no sound", () => {
    assert.equal(buildAddLaneText(null, "RolandTR909"), null);
  });
});

describe("changeForAddLane()", () => {
  test("inserts after last `$:` lane with a blank separator", () => {
    const code = '$: s("bd ~ bd ~")\n\n$: s("~ sd ~ sd")\n';
    const lanes = parseDrumLanes(code);
    const text = buildAddLaneText("hh", "RolandTR909");
    const change = changeForAddLane(code, lanes, text);
    assert.ok(change);
    const after = apply(code, change);
    assert.match(
      after,
      /\$: s\("~ sd ~ sd"\)[\s\S]*\$: s\("hh ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~"\)\.bank\("RolandTR909"\)/,
    );
  });

  test("appends at EOF when there are no existing lanes", () => {
    const code = 'setcpm(120/4)';
    const lanes = parseDrumLanes(code);
    const text = buildAddLaneText("bd", null);
    const change = changeForAddLane(code, lanes, text);
    assert.ok(change);
    const after = apply(code, change);
    assert.ok(
      after.includes('$: s("bd ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~")'),
    );
  });

  test("empty buffer → insertion at 0 with no leading blank", () => {
    const code = '';
    const lanes = parseDrumLanes(code);
    const change = changeForAddLane(code, lanes, buildAddLaneText("bd", null));
    assert.ok(change);
    assert.equal(change.from, 0);
    assert.ok(change.insert.startsWith('$: s("bd'));
  });
});

// ─── changeForDeleteLane ─────────────────────────────────────────────────

describe("changeForDeleteLane()", () => {
  test("removes a $:: line and its trailing newline", () => {
    const code = '$: s("bd ~ bd ~")\n$: s("~ sd ~ sd")\n';
    const lanes = parseDrumLanes(code);
    const change = changeForDeleteLane(code, lanes[0]);
    assert.equal(apply(code, change), '$: s("~ sd ~ sd")\n');
  });

  test("removes middle lane without orphaning blank lines", () => {
    const code =
      '$: s("bd ~ bd ~")\n\n$: s("~ sd ~ sd")\n\n$: s("hh hh hh hh")\n';
    const lanes = parseDrumLanes(code);
    const change = changeForDeleteLane(code, lanes[1]);
    const after = apply(code, change);
    assert.ok(after.includes('bd ~ bd ~'));
    assert.ok(after.includes('hh hh hh hh'));
    assert.ok(!after.includes('sd ~ sd'));
  });

  test("EOF lane with no trailing newline", () => {
    const code = '$: s("bd ~ bd ~")\n$: s("~ sd ~ sd")';
    const lanes = parseDrumLanes(code);
    const change = changeForDeleteLane(code, lanes[1]);
    // The first lane keeps its trailing newline.
    assert.equal(apply(code, change), '$: s("bd ~ bd ~")\n');
  });
});

// ─── changeForDuplicateLane ──────────────────────────────────────────────

describe("changeForDuplicateLane()", () => {
  test("copies a lane verbatim directly below", () => {
    const code = '$: s("bd ~ bd ~").bank("RolandTR909")\n';
    const lanes = parseDrumLanes(code);
    const change = changeForDuplicateLane(code, lanes[0]);
    assert.equal(
      apply(code, change),
      '$: s("bd ~ bd ~").bank("RolandTR909")\n$: s("bd ~ bd ~").bank("RolandTR909")\n',
    );
  });

  test("round-trips multi-line chain blocks", () => {
    const code = '$: s("bd ~ bd ~")\n  .bank("RolandTR909")\n';
    const lanes = parseDrumLanes(code);
    const change = changeForDuplicateLane(code, lanes[0]);
    const after = apply(code, change);
    const count = (after.match(/RolandTR909/g) || []).length;
    assert.equal(count, 2);
  });
});

// ─── changeForReorderLanes ───────────────────────────────────────────────

describe("changeForReorderLanes()", () => {
  test("swaps two adjacent lanes", () => {
    const code = '$: s("bd ~ bd ~")\n$: s("~ sd ~ sd")\n';
    const lanes = parseDrumLanes(code);
    const change = changeForReorderLanes(code, lanes[0], lanes[1]);
    assert.equal(
      apply(code, change),
      '$: s("~ sd ~ sd")\n$: s("bd ~ bd ~")\n',
    );
  });

  test("swaps non-adjacent lanes, preserving between-content", () => {
    const code =
      '$: s("bd ~ bd ~")\n\n$: s("~ sd ~ sd")\n\n$: s("hh hh hh hh")\n';
    const lanes = parseDrumLanes(code);
    const change = changeForReorderLanes(code, lanes[0], lanes[2]);
    const after = apply(code, change);
    assert.match(after, /^\$: s\("hh hh hh hh"\)/);
    assert.match(after, /\$: s\("bd ~ bd ~"\)\n$/);
  });

  test("null on self-swap", () => {
    const code = '$: s("bd ~ bd ~")\n';
    const [lane] = parseDrumLanes(code);
    assert.equal(changeForReorderLanes(code, lane, lane), null);
  });
});

// ─── changeForMoveLane ───────────────────────────────────────────────────

describe("changeForMoveLane()", () => {
  test("moving DOWN from 0 to 2 pushes 1 and 2 up, source lands at 2", () => {
    const code =
      '$: s("A")\n$: s("B")\n$: s("C")\n';
    const lanes = parseDrumLanes(code);
    const change = changeForMoveLane(code, lanes[0], lanes[2]);
    assert.equal(apply(code, change), '$: s("B")\n$: s("C")\n$: s("A")\n');
  });

  test("moving UP from 2 to 0 puts source at 0, shifts others down", () => {
    const code =
      '$: s("A")\n$: s("B")\n$: s("C")\n';
    const lanes = parseDrumLanes(code);
    const change = changeForMoveLane(code, lanes[2], lanes[0]);
    assert.equal(apply(code, change), '$: s("C")\n$: s("A")\n$: s("B")\n');
  });

  test("moving DOWN by one (swap-equivalent for adjacents)", () => {
    const code = '$: s("A")\n$: s("B")\n';
    const lanes = parseDrumLanes(code);
    const change = changeForMoveLane(code, lanes[0], lanes[1]);
    assert.equal(apply(code, change), '$: s("B")\n$: s("A")\n');
  });

  test("null on self-move", () => {
    const code = '$: s("A")\n';
    const [lane] = parseDrumLanes(code);
    assert.equal(changeForMoveLane(code, lane, lane), null);
  });

  test("preserves blank lines between lanes when moving across them", () => {
    const code = '$: s("A")\n\n$: s("B")\n\n$: s("C")\n';
    const lanes = parseDrumLanes(code);
    const change = changeForMoveLane(code, lanes[0], lanes[2]);
    const after = apply(code, change);
    // B must still be first, C second, A last — whatever the gap topology.
    const order = [...after.matchAll(/\$: s\("([A-C])"\)/g)].map((m) => m[1]);
    assert.deepEqual(order, ["B", "C", "A"]);
  });
});

// ─── expandShortcut + changeForNormaliseShortcut ─────────────────────────

describe("expandShortcut()", () => {
  test("hh*8 → 8 space-separated hh tokens", () => {
    assert.equal(expandShortcut("hh*8"), "hh hh hh hh hh hh hh hh");
  });

  test("bd:2*4 → 4 bd:2 tokens", () => {
    assert.equal(expandShortcut("bd:2*4"), "bd:2 bd:2 bd:2 bd:2");
  });

  test("caps at 32", () => {
    const expanded = expandShortcut("hh*128");
    assert.equal(expanded.split(" ").length, 32);
  });

  test("null for non-shortcut strings", () => {
    assert.equal(expandShortcut("bd ~ sd ~"), null);
    assert.equal(expandShortcut("hh*8 sd"), null); // not just a shortcut
  });
});

describe("changeForNormaliseShortcut()", () => {
  test("rewrites a `hh*8` lane to flat form", () => {
    const code = '$: s("hh*8").bank("RolandTR909")';
    const [lane] = parseDrumLanes(code);
    const change = changeForNormaliseShortcut(lane, code);
    assert.ok(change);
    assert.equal(
      apply(code, change),
      '$: s("hh hh hh hh hh hh hh hh").bank("RolandTR909")',
    );
  });

  test("null when the lane isn't a simple sound*N shortcut", () => {
    const code = '$: s("bd [~ sd] bd sd").bank("RolandTR909")';
    const [lane] = parseDrumLanes(code);
    assert.equal(changeForNormaliseShortcut(lane, code), null);
  });
});

// ─── changeForUpgradeResolution ──────────────────────────────────────────

describe("changeForUpgradeResolution()", () => {
  test("4-step → 8-step interleaves rests", () => {
    const code = '$: s("bd ~ sd ~")';
    const [lane] = parseDrumLanes(code);
    const change = changeForUpgradeResolution(lane, 8);
    assert.equal(apply(code, change), '$: s("bd ~ ~ ~ sd ~ ~ ~")');
  });

  test("8-step → 16-step interleaves rests", () => {
    const code = '$: s("bd ~ sd ~ bd ~ sd ~")';
    const [lane] = parseDrumLanes(code);
    const change = changeForUpgradeResolution(lane, 16);
    assert.equal(
      apply(code, change),
      '$: s("bd ~ ~ ~ sd ~ ~ ~ bd ~ ~ ~ sd ~ ~ ~")',
    );
  });

  test("preserves variants", () => {
    const code = '$: s("bd:2 sd:1 bd:2 sd:1")';
    const [lane] = parseDrumLanes(code);
    const change = changeForUpgradeResolution(lane, 8);
    assert.equal(
      apply(code, change),
      '$: s("bd:2 ~ sd:1 ~ bd:2 ~ sd:1 ~")',
    );
  });

  test("returns null when target is already reached or beyond", () => {
    const code = '$: s("bd ~ ~ ~ sd ~ ~ ~ bd ~ ~ ~ sd ~ ~ ~")';
    const [lane] = parseDrumLanes(code);
    assert.equal(changeForUpgradeResolution(lane, 16), null);
    assert.equal(changeForUpgradeResolution(lane, 8), null);
  });

  test("only 8 and 16 are accepted targets", () => {
    const code = '$: s("bd ~ sd ~")';
    const [lane] = parseDrumLanes(code);
    assert.equal(changeForUpgradeResolution(lane, 4), null);
    assert.equal(changeForUpgradeResolution(lane, 32), null);
  });
});
