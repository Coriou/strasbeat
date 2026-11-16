import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  OVERLAY_MAX_WIDTH,
  COMPACT_MAX_WIDTH,
  NARROW_QUERY,
  layoutMode,
  resolveRailExpanded,
  expandedToPersist,
  watchNarrow,
  EDITOR_MIN_WIDTH,
  OVERLAY_GUTTER,
  rightRailMaxPanelWidth,
  resizedRailWidth,
  railTakesEscape,
  pickFocusReturn,
} from "./responsive.js";

describe("layoutMode(): which shell grammar a viewport gets", () => {
  test("phones are compact", () => {
    assert.equal(layoutMode(320), "compact");
    assert.equal(layoutMode(390), "compact");
    assert.equal(layoutMode(599), "compact");
  });

  test("tablets and a zoomed laptop float the rails over the editor", () => {
    assert.equal(layoutMode(600), "overlay");
    assert.equal(layoutMode(720), "overlay"); // 1440px at 200% zoom
    assert.equal(layoutMode(768), "overlay");
    assert.equal(layoutMode(899), "overlay");
  });

  test("from 900px the rails are docked", () => {
    assert.equal(layoutMode(900), "docked");
    assert.equal(layoutMode(1024), "docked");
    assert.equal(layoutMode(1440), "docked");
  });

  test("a missing width is treated as the smallest layout", () => {
    assert.equal(layoutMode(NaN), "compact");
  });
});

describe("rail open state across viewports", () => {
  test("a narrow viewport never opens a rail from the stored preference", () => {
    assert.equal(resolveRailExpanded({ storedExpanded: true, narrow: true }), false);
    assert.equal(resolveRailExpanded({ storedExpanded: false, narrow: true }), false);
  });

  test("a wide viewport follows the stored preference", () => {
    assert.equal(resolveRailExpanded({ storedExpanded: true, narrow: false }), true);
    assert.equal(resolveRailExpanded({ storedExpanded: false, narrow: false }), false);
    assert.equal(resolveRailExpanded({ storedExpanded: undefined, narrow: false }), false);
  });

  test("opening or closing on a narrow viewport leaves the preference alone", () => {
    assert.equal(
      expandedToPersist({ expanded: false, narrow: true, storedExpanded: true }),
      true,
    );
    assert.equal(
      expandedToPersist({ expanded: true, narrow: true, storedExpanded: false }),
      false,
    );
  });

  test("on a wide viewport the current state is the preference", () => {
    assert.equal(
      expandedToPersist({ expanded: true, narrow: false, storedExpanded: false }),
      true,
    );
    assert.equal(
      expandedToPersist({ expanded: false, narrow: false, storedExpanded: true }),
      false,
    );
  });

  test("without matchMedia the layout counts as docked", () => {
    const w = watchNarrow();
    assert.equal(w.isNarrow(), false);
    w.dispose();
  });
});

describe("the breakpoints match the stylesheets", () => {
  const css = (name) =>
    readFileSync(new URL(`../styles/${name}`, import.meta.url), "utf8");

  test("the JS query is the same media query shell.css switches on", () => {
    assert.equal(NARROW_QUERY, `(max-width: ${OVERLAY_MAX_WIDTH - 0.02}px)`);
    assert.ok(css("shell.css").includes(`@media ${NARROW_QUERY}`));
  });

  test("the compact breakpoint is shared by shell, top bar and transport", () => {
    const q = `@media (max-width: ${COMPACT_MAX_WIDTH - 0.02}px)`;
    for (const file of ["shell.css", "top-bar.css", "transport.css"]) {
      assert.ok(css(file).includes(q), `${file} is missing ${q}`);
    }
  });
});

describe("right rail width cap", () => {
  const TABS = 36;
  const cap = (viewportWidth, leftRailWidth) =>
    rightRailMaxPanelWidth({ viewportWidth, leftRailWidth, tabsWidth: TABS });

  test("docked, the editor keeps its minimum width", () => {
    assert.equal(cap(1440, 240), 804); // above the rail's own 480 maximum
    assert.equal(cap(1024, 240), 388);
    assert.equal(cap(1024, 36), 592);
    assert.equal(cap(900, 240), 264);
  });

  test("floating, a strip of canvas stays visible beside the rail", () => {
    assert.equal(cap(768, 36), 768 - 44 - TABS);
    assert.equal(cap(390, 0), 310);
  });

  test("never negative", () => {
    assert.equal(cap(60, 0), 0);
  });

  test("the constants are the ones shell.css and the tokens use", () => {
    const css = (name) =>
      readFileSync(new URL(`../styles/${name}`, import.meta.url), "utf8");
    const px = (name) =>
      Number(css("tokens.css").match(new RegExp(`--${name}:\\s*(\\d+)px`))[1]);
    assert.equal(px("editor-min-w"), EDITOR_MIN_WIDTH);
    assert.equal(px("target-min") + px("space-1"), OVERLAY_GUTTER);
    const shell = css("shell.css");
    assert.ok(shell.includes("100vw - var(--left-rail-w) - var(--editor-min-w)"));
    assert.ok(
      shell.includes(
        "min(var(--right-rail-w), 100% - var(--target-min) - var(--space-1))",
      ),
    );
  });
});

describe("resizedRailWidth(): dragging the right rail's handle", () => {
  const drag = (stored, dx, cap) =>
    resizedRailWidth({ stored, dx, min: 240, max: 480, cap });

  test("with room to spare it is the stored width plus the drag", () => {
    assert.equal(drag(320, 40, 804), 360);
    assert.equal(drag(320, -40, 804), 280);
    assert.equal(drag(320, 400, 804), 480);
    assert.equal(drag(320, -400, 804), 240);
  });

  test("a stored width above the cap starts from what is on screen", () => {
    // 480 stored, 388 drawn at 1024px: shrinking follows the pointer at once.
    assert.equal(drag(480, -10, 388), 378);
    assert.equal(drag(480, -92, 388), 296);
  });

  test("growing stops at the cap instead of storing an invisible width", () => {
    assert.equal(drag(480, 50, 388), 388);
    assert.equal(drag(300, 200, 388), 388);
  });

  test("a press without movement keeps the stored width", () => {
    assert.equal(drag(480, 0, 388), 480);
  });

  test("a cap below the minimum never pushes the width under it", () => {
    assert.equal(drag(320, -5, 200), 240);
    assert.equal(drag(320, 30, 200), 240);
  });
});

describe("railTakesEscape(): closing a floating rail", () => {
  const base = { key: "Escape", defaultPrevented: false, narrow: true, open: true };

  test("an unclaimed Escape closes an open floating rail", () => {
    assert.equal(railTakesEscape(base), true);
  });

  test("only Escape, only while floating, only while open", () => {
    assert.equal(railTakesEscape({ ...base, key: "Enter" }), false);
    assert.equal(railTakesEscape({ ...base, narrow: false }), false);
    assert.equal(railTakesEscape({ ...base, open: false }), false);
  });

  test("whatever claimed the key first keeps it", () => {
    // Rename field, command palette, completion popup, a search with text.
    assert.equal(railTakesEscape({ ...base, defaultPrevented: true }), false);
    // A modal or menu that is open but has not seen the key yet.
    assert.equal(railTakesEscape({ ...base, layerOpen: true }), false);
  });

  test("with both rails open, the one holding focus closes", () => {
    assert.equal(railTakesEscape({ ...base, focusInOtherRail: true }), false);
  });
});

describe("pickFocusReturn(): where focus goes when a rail closes", () => {
  const usable = (c) => c.shown;

  test("the opener, when it can still take focus", () => {
    const opener = { shown: true };
    assert.equal(pickFocusReturn([opener, { shown: true }], usable), opener);
  });

  test("skips a missing opener and a control that is not drawn", () => {
    // Below 600px the collapsed strip (and its button) is display: none.
    const strip = { shown: false };
    const patternButton = { shown: true };
    assert.equal(
      pickFocusReturn([null, strip, patternButton], usable),
      patternButton,
    );
  });

  test("null when nothing can take it", () => {
    assert.equal(pickFocusReturn([null, { shown: false }], usable), null);
  });
});

describe("design tokens: text contrast", () => {
  // OKLCH → linear sRGB → WCAG relative luminance.
  function luminance([L, C, H]) {
    const h = (H * Math.PI) / 180;
    const a = C * Math.cos(h);
    const b = C * Math.sin(h);
    const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
    const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
    const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
    const clip = (v) => Math.min(1, Math.max(0, v));
    return (
      0.2126 * clip(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s) +
      0.7152 * clip(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s) +
      0.0722 * clip(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s)
    );
  }
  const contrast = (x, y) => {
    const [hi, lo] = [luminance(x), luminance(y)].sort((p, q) => q - p);
    return (hi + 0.05) / (lo + 0.05);
  };
  // The default block only — the prefers-contrast override comes later.
  const root = css_root();
  function css_root() {
    const text = readFileSync(
      new URL("../styles/tokens.css", import.meta.url),
      "utf8",
    );
    return text.slice(0, text.indexOf("@media"));
  }
  function token(name) {
    const m = root.match(
      new RegExp(`--${name}:\\s*oklch\\(([\\d.]+)\\s+([\\d.]+)\\s+([\\d.]+)\\)`),
    );
    assert.ok(m, `--${name} should be a plain oklch() colour`);
    return [Number(m[1]), Number(m[2]), Number(m[3])];
  }

  test("all three text levels read as text (4.5:1) on the panel surfaces", () => {
    for (const text of ["text", "text-mut", "text-dim"]) {
      for (const surface of ["surface-0", "surface-1", "surface-2"]) {
        const ratio = contrast(token(text), token(surface));
        assert.ok(
          ratio >= 4.5,
          `--${text} on --${surface} is ${ratio.toFixed(2)}:1`,
        );
      }
    }
  });

  test("the secondary level also holds on the hover surface", () => {
    assert.ok(contrast(token("text-mut"), token("surface-3")) >= 4.5);
  });

  test("the levels stay distinct: text > mut > dim", () => {
    const [text, mut, dim] = ["text", "text-mut", "text-dim"].map(
      (t) => token(t)[0],
    );
    assert.ok(text - mut >= 0.1);
    assert.ok(mut - dim >= 0.1);
  });

  test("the focus ring and the strong border reach 3:1", () => {
    for (const surface of ["surface-0", "surface-1", "surface-2", "surface-3"]) {
      assert.ok(contrast(token("accent"), token(surface)) >= 3);
    }
    for (const surface of ["surface-0", "surface-1", "surface-2"]) {
      assert.ok(contrast(token("border-strong"), token(surface)) >= 3);
    }
  });
});
