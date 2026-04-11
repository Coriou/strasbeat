import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { extractErrorLine } from "./error-marks.js";

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
