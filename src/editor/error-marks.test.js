import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { extractErrorLine, setError } from "./error-marks.js";

describe("extractErrorLine()", () => {
  test("reads acorn SyntaxError loc data", () => {
    const err = {
      message: "Unexpected token",
      loc: { line: 3, column: 11 },
    };

    assert.deepEqual(extractErrorLine(err), {
      line: 3,
      column: 11,
      message: "Unexpected token",
    });
  });

  test("reads mini parse errors from the message text", () => {
    const err = {
      message: "[mini] parse error at line 5: Unexpected end of input",
    };

    assert.deepEqual(extractErrorLine(err), {
      line: 5,
      message: "Unexpected end of input",
    });
  });

  test("reads generic line-number fallbacks", () => {
    const err = {
      message: "Runtime blew up at line 9 while evaluating",
    };

    assert.deepEqual(extractErrorLine(err), {
      line: 9,
      message: "Runtime blew up at line 9 while evaluating",
    });
  });

  test("strips Strudel logger prefix from display message", () => {
    const err = {
      message: "[eval] error: something at line 4",
    };

    const result = extractErrorLine(err);
    assert.equal(result.line, 4);
    assert.equal(result.message, "something at line 4");
  });

  test("preserves [mini] prefix (needed for extraction)", () => {
    const err = {
      message: "[mini] parse error at line 7: bad token",
    };

    const result = extractErrorLine(err);
    assert.equal(result.line, 7);
    assert.equal(result.message, "bad token");
  });

  test("rejects line zero and non-location uses of the word line", () => {
    assert.equal(
      extractErrorLine({ message: "parse error at line 0: nope" }),
      null,
    );
    assert.equal(extractErrorLine({ message: "timeline not found" }), null);
  });

  test("returns null when no line data exists", () => {
    assert.equal(extractErrorLine({ message: "Something failed" }), null);
    assert.equal(extractErrorLine(new Error("Boom")), null);
  });
});

describe("setError() runtime fallback", () => {
  test("matches whole identifiers (sin) instead of substrings (sine)", () => {
    const view = createMockView([
      's("hh*8").pan(sine.fast(4))',
      's("hh*8").pan(sin.slow(2))',
    ]);

    const result = setError(view, { message: "sin is not defined" });

    assert.equal(result?.line, 2);
    assert.equal(view.dispatchCount, 1);
  });

  test("returns null when identifier appears on multiple lines", () => {
    const view = createMockView([
      's("hh*8").pan(sin.fast(2))',
      's("hh*8").pan(sin.slow(2))',
    ]);

    const result = setError(view, { message: "sin is not defined" });

    assert.equal(result, null);
    assert.equal(view.dispatchCount, 0);
  });
});

function createMockView(lines) {
  const lineInfos = [];
  let offset = 0;
  for (let i = 0; i < lines.length; i++) {
    const text = lines[i];
    const from = offset;
    const to = from + text.length;
    lineInfos.push({ number: i + 1, text, from, to });
    offset = to + 1;
  }

  const doc = {
    lines: lines.length,
    line(number) {
      return lineInfos[number - 1];
    },
  };

  const view = {
    state: { doc },
    dispatchCount: 0,
    dispatch() {
      this.dispatchCount += 1;
    },
  };

  return view;
}
