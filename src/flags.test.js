import test from "node:test";
import assert from "node:assert/strict";
import { flagEnabled } from "./flags.js";
function store() {
  const values = new Map();
  return {
    getItem: (k) => values.get(k),
    setItem: (k, v) => values.set(k, v),
    removeItem: (k) => values.delete(k),
  };
}
test("off is remembered and on clears only the named flag", () => {
  const data = store();
  const storage = () => data;
  assert.equal(flagEnabled("sw", { storage, search: "?sb-sw=off" }), false);
  assert.equal(data.getItem("strasbeat:flag:sw"), "off");
  assert.equal(flagEnabled("sw", { storage, search: "" }), false);
  assert.equal(flagEnabled("other", { storage, search: "" }), true);
  assert.equal(flagEnabled("sw", { storage, search: "?sb-sw=on" }), true);
  assert.equal(data.getItem("strasbeat:flag:sw"), undefined);
  assert.equal(flagEnabled("sw", { storage, search: "?sb-sw=invalid" }), true);
});
test("throwing storage getter, reads and writes never throw; URL takes precedence", () => {
  const fail = () => {
    throw new Error("blocked");
  };
  for (const storage of [
    fail,
    () => ({ getItem: fail, setItem: fail, removeItem: fail }),
    () => null,
  ]) {
    assert.equal(flagEnabled("sw", { storage, search: "" }), true);
    assert.equal(flagEnabled("sw", { storage, search: "?sb-sw=off" }), false);
    assert.equal(flagEnabled("sw", { storage, search: "?sb-sw=on" }), true);
  }
});
