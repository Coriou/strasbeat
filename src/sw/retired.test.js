import test from "node:test";
import assert from "node:assert/strict";
import { retainAssets, collectRetired, matchRetired } from "./retired.js";
function storage() {
  const buckets = new Map();
  const key = (r) =>
    new URL(typeof r === "string" ? r : r.url, "https://example.test").href;
  return {
    keys: async () => [...buckets.keys()],
    delete: async (name) => buckets.delete(name),
    open: async (name) => {
      if (!buckets.has(name)) {
        const values = new Map();
        buckets.set(name, {
          match: async (r) => values.get(key(r))?.clone(),
          put: async (r, response) => values.set(key(r), response.clone()),
          keys: async () => [...values.keys()].map((url) => new Request(url)),
        });
      }
      return buckets.get(name);
    },
  };
}
test("an old window keeps its lazy assets after precache deletion; a new window cannot use them", async () => {
  const s = storage();
  const old = await s.open("strasbeat-precache-old");
  await old.put("/assets/old.js", new Response("old code"));
  await old.put("/index.html", new Response("old html"));
  await retainAssets(
    s,
    "new",
    [{ cache: old, keep: () => true }],
    ["window-1", "window-2"],
  );
  await s.delete("strasbeat-precache-old");
  assert.equal(
    await (await matchRetired(s, "/assets/old.js", "window-1")).text(),
    "old code",
  );
  assert.equal(
    await matchRetired(s, "/assets/old.js", "new-window"),
    undefined,
  );
  assert.equal(await matchRetired(s, "/index.html", "window-1"), undefined);
  await collectRetired(s, ["window-2"]);
  assert.equal(await matchRetired(s, "/assets/old.js", "window-1"), undefined);
  assert.equal(
    await (await matchRetired(s, "/assets/old.js", "window-2")).text(),
    "old code",
  );
  await collectRetired(s, []);
  assert.deepEqual(await s.keys(), []);
});
test("retention skips non-assets, partial responses, and files rejected by the source filter", async () => {
  const s = storage();
  const old = await s.open("runtime");
  await old.put("/assets/partial.js", new Response("partial", { status: 206 }));
  await old.put("/assets/current.js", new Response("current"));
  await retainAssets(
    s,
    "new",
    [{ cache: old, keep: (r) => !r.url.endsWith("current.js") }],
    ["old-window"],
  );
  assert.equal(
    await matchRetired(s, "/assets/partial.js", "old-window"),
    undefined,
  );
  assert.equal(
    await matchRetired(s, "/assets/current.js", "old-window"),
    undefined,
  );
  await retainAssets(s, "unused", [{ cache: old, keep: () => true }], []);
  assert.ok(!(await s.keys()).includes("strasbeat-retired-unused"));
});
test("a first install, with nothing to hand over, leaves no lease behind", async () => {
  const s = storage();
  const empty = await s.open("strasbeat-assets-v1");
  await retainAssets(s, "first", [{ cache: empty, keep: () => true }], ["w"]);
  assert.deepEqual(await s.keys(), ["strasbeat-assets-v1"]);
});
