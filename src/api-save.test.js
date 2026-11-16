import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { rejectSaveRequest } from "../vite.config.js";

// The dev-only /api/save middleware writes files into patterns/. It listens on
// localhost, so it has to tell the app's own page apart from any other site
// open in the same browser.
describe("/api/save request screening", () => {
  const own = { host: "localhost:5173", origin: "http://localhost:5173", "content-type": "application/json", "sec-fetch-site": "same-origin" };

  test("accepts the app's own JSON request", () => {
    assert.equal(rejectSaveRequest(own), null);
    assert.equal(rejectSaveRequest({ ...own, "content-type": "application/json; charset=utf-8" }), null);
  });

  test("accepts non-browser clients (no Origin / fetch metadata)", () => {
    assert.equal(rejectSaveRequest({ host: "localhost:5173", "content-type": "application/json" }), null);
  });

  test("refuses a request from another origin", () => {
    assert.equal(rejectSaveRequest({ ...own, origin: "https://evil.example" }).status, 403);
    assert.equal(rejectSaveRequest({ ...own, origin: "http://localhost:9999" }).status, 403);
    assert.equal(rejectSaveRequest({ ...own, origin: "null" }).status, 403);
  });

  test("refuses cross-site fetch metadata even without an Origin header", () => {
    const { origin, ...noOrigin } = own;
    assert.equal(rejectSaveRequest({ ...noOrigin, "sec-fetch-site": "cross-site" }).status, 403);
    assert.equal(rejectSaveRequest({ ...noOrigin, "sec-fetch-site": "same-site" }).status, 403);
  });

  test("refuses the preflight-free content types a no-cors page can send", () => {
    for (const type of ["text/plain", "application/x-www-form-urlencoded", "multipart/form-data", undefined]) {
      const { origin, "sec-fetch-site": _site, ...rest } = own;
      assert.equal(rejectSaveRequest({ ...rest, "content-type": type }).status, 415);
    }
  });

  test("refuses a rebound hostname, which is same-origin with itself", () => {
    // evil.example re-pointed at 127.0.0.1: Origin and Host agree.
    const rebound = { ...own, host: "evil.example:5173", origin: "http://evil.example:5173" };
    assert.equal(rejectSaveRequest(rebound).status, 403);
    assert.equal(rejectSaveRequest({ host: "evil.example:5173", "content-type": "application/json" }).status, 403);
    assert.equal(rejectSaveRequest({ ...own, host: undefined }).status, 403);
    assert.equal(rejectSaveRequest({ ...own, host: "localhost.evil.example:5173", origin: "http://localhost.evil.example:5173" }).status, 403);
  });

  test("accepts the names and addresses a dev server is really reached by", () => {
    for (const host of ["localhost:5173", "app.localhost:5173", "127.0.0.1:5173", "192.168.1.20:5173", "[::1]:5173", "localhost"]) {
      assert.equal(rejectSaveRequest({ ...own, host, origin: `http://${host}` }), null, host);
    }
  });
});
