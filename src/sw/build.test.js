import test from "node:test";
import assert from "node:assert/strict";
import {
  makePrecache,
  contentBuildId,
  PUBLIC_SHELL,
  OPT_IN_THRESHOLD,
} from "./build.js";
const asset = (source) => ({ type: "asset", source });
const chunk = (fileName, options = {}) => ({
  type: "chunk",
  fileName,
  code: "entry",
  imports: [],
  dynamicImports: [],
  ...options,
});
function fixture() {
  return {
    bundle: {
      "index.html": asset('<script src="/assets/main-hash.js"></script>'),
      "assets/main-hash.js": chunk("assets/main-hash.js", {
        isEntry: true,
        dynamicImports: [
          "assets/xen-hash.js",
          "assets/csound-hash.js",
          "assets/panel-hash.js",
        ],
      }),
      "assets/xen-hash.js": chunk("assets/xen-hash.js", {
        facadeModuleId: "/node_modules/@strudel/xen/dist/index.mjs",
        code: "x".repeat(OPT_IN_THRESHOLD + 1),
      }),
      "assets/csound-hash.js": chunk("assets/csound-hash.js", {
        facadeModuleId: "/node_modules/@strudel/csound/dist/index.mjs",
        dynamicImports: ["assets/engine-hash.js"],
      }),
      "assets/engine-hash.js": chunk("assets/engine-hash.js", {
        code: "c".repeat(OPT_IN_THRESHOLD + 1),
      }),
      "assets/panel-hash.js": chunk("assets/panel-hash.js"),
      "assets/font-hash.woff2": asset("font"),
    },
    publicFiles: Object.fromEntries(
      PUBLIC_SHELL.map((name) => [name, asset(name)]),
    ),
  };
}
test("precache includes shell, fonts and lazy panels but excludes large opt-in graphs", () => {
  const { bundle, publicFiles } = fixture();
  const result = makePrecache(bundle, publicFiles);
  assert.deepEqual(result.excluded.sort(), [
    "assets/engine-hash.js",
    "assets/xen-hash.js",
  ]);
  assert.equal(result.allAssets.length, 6);
  for (const url of [
    "/index.html",
    "/assets/main-hash.js",
    "/assets/font-hash.woff2",
    "/assets/panel-hash.js",
    ...PUBLIC_SHELL.map((x) => `/${x}`),
  ])
    assert.ok(result.precache.some((x) => x.url === url));
  assert.ok(!result.precache.some((x) => /shareimage|sw\.js/.test(x.url)));
});
test("guards missing index, entry, icons and excessive total size", () => {
  for (const name of ["index.html", "assets/main-hash.js"]) {
    const { bundle, publicFiles } = fixture();
    delete bundle[name];
    assert.throws(
      () => makePrecache(bundle, publicFiles),
      /missing|entry script/,
    );
  }
  const { bundle, publicFiles } = fixture();
  assert.throws(() => makePrecache({}, publicFiles), /missing index/);
  assert.throws(() => makePrecache(bundle, {}), /missing/);
  assert.throws(
    () => makePrecache(bundle, publicFiles, { ceiling: 1 }),
    /exceeds/,
  );
});
test("source maps are neither precached nor counted as assets", () => {
  const { bundle, publicFiles } = fixture();
  const before = makePrecache(bundle, publicFiles);
  bundle["assets/main-hash.js.map"] = asset("m".repeat(9 * 1024 * 1024));
  const after = makePrecache(bundle, publicFiles);
  assert.deepEqual(after.precache, before.precache);
  assert.deepEqual(after.allAssets, before.allAssets);
  assert.equal(after.version, before.version);
  assert.equal(after.total, before.total);
});
test("a shared large opt-in dependency remains required", () => {
  const { bundle, publicFiles } = fixture();
  bundle["assets/panel-hash.js"].imports.push("assets/engine-hash.js");
  assert.ok(
    makePrecache(bundle, publicFiles).precache.some(
      (x) => x.url === "/assets/engine-hash.js",
    ),
  );
});
test("version is order-independent and changes with HTML, public content or hashed asset names", () => {
  const { bundle, publicFiles } = fixture();
  const initial = makePrecache(bundle, publicFiles).version;
  assert.equal(
    makePrecache(
      Object.fromEntries(Object.entries(bundle).reverse()),
      publicFiles,
    ).version,
    initial,
  );
  publicFiles["favicon.svg"].source = "new icon";
  assert.notEqual(makePrecache(bundle, publicFiles).version, initial);
  const changed = makePrecache(bundle, publicFiles).version;
  bundle["index.html"].source += "new build";
  assert.notEqual(makePrecache(bundle, publicFiles).version, changed);
  const htmlChanged = makePrecache(bundle, publicFiles).version;
  bundle["assets/another-hash.css"] = asset("css");
  assert.notEqual(makePrecache(bundle, publicFiles).version, htmlChanged);
});

test("an accidental 4 MiB required chunk fails even below the total budget", () => {
  const { bundle, publicFiles } = fixture();
  bundle["assets/panel-hash.js"].code = "x".repeat(4 * 1024 * 1024);
  assert.throws(() => makePrecache(bundle, publicFiles), /per-file ceiling/);
});

test("the build identifier follows the shipped files and nothing else", () => {
  const names = ["assets/main-a1.js", "assets/panel-b2.js", "index.html"];
  const id = contentBuildId(names);
  assert.match(id, /^[0-9a-f]{10}$/);
  assert.equal(contentBuildId([...names].reverse()), id);
  // Not a shipped file: a source map, the page itself, the worker.
  assert.equal(
    contentBuildId([...names, "assets/main-a1.js.map", "sw.js"]),
    id,
  );
  // A chunk whose content (and so its name) changed.
  assert.notEqual(
    contentBuildId(["assets/main-c3.js", "assets/panel-b2.js"]),
    id,
  );
});
