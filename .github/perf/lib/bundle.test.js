import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { bundle } from "../bundle.mjs";
test("initial graph follows static imports and reexports, excluding lazy imports and maps", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bundle-test-"));
  try {
    const files = {
      "index.html":
        '<script type="module" src="/entry.js"></script><link rel="stylesheet" href="/style.css">',
      "entry.js": 'import{a}from"./a.js";import"./b.js";import("./lazy.js");',
      "a.js": 'export {b} from "./b.js";',
      "b.js": "export const b=1;",
      "lazy.js": "export default 2;",
      "style.css": "body{}",
      "entry.js.map": "{}",
    };
    await Promise.all(
      Object.entries(files).map(([name, text]) =>
        fs.writeFile(path.join(root, name), text),
      ),
    );
    const r = (await bundle(root)).records[0];
    assert.deepEqual(r.info.initial.sort(), ["a.js", "b.js", "entry.js"]);
    assert.equal(
      r.counts.initialJsRaw,
      files["entry.js"].length + files["a.js"].length + files["b.js"].length,
    );
    assert.equal(r.counts.fileCount, 6);
    assert.equal(r.info.largestLazy[0].file, "lazy.js");
  } finally {
    await fs.rm(root, { recursive: true });
  }
});
