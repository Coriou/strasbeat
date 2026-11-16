// The page must never ship a fallback or duplicate copy of Prettier.
// Vite emits the separate worker build as an asset in the main bundle.
import { test } from "node:test";
import assert from "node:assert/strict";
import viteConfig, { workerOnlyPrettierPlugin } from "../../vite.config.js";

test("the worker-only guard is installed for production builds", () => {
  assert.ok(
    viteConfig.plugins.some((p) => p.name === "strasbeat:worker-only-prettier"),
  );
  assert.equal(workerOnlyPrettierPlugin().apply, "build");
  assert.equal(viteConfig.worker?.format ?? "iife", "iife");
});

for (const [name, id] of [
  ["entry", "/repo/node_modules/prettier/standalone.mjs"],
  [
    "lazy",
    "/repo/node_modules/.pnpm/prettier@3.8.1/node_modules/prettier/plugins/babel.mjs",
  ],
  [
    "shared",
    "C:\\repo\\node_modules\\prettier\\plugins\\estree.mjs?commonjs-proxy",
  ],
]) {
  test(`rejects Prettier in a ${name} page chunk`, () => {
    const plugin = workerOnlyPrettierPlugin();
    assert.throws(
      () =>
        plugin.generateBundle.call(
          {
            error(message) {
              throw new Error(message);
            },
          },
          {},
          {
            [`${name}.js`]: {
              type: "chunk",
              isEntry: name === "entry",
              modules: { [id]: {} },
            },
          },
        ),
      /Prettier must only be bundled in the formatting worker/,
    );
  });
}

test("allows the worker asset and ordinary page modules", () => {
  workerOnlyPrettierPlugin().generateBundle.call(
    {
      error(message) {
        assert.fail(message);
      },
    },
    {},
    {
      "index.js": {
        type: "chunk",
        modules: { "/repo/src/editor/format.js": {} },
      },
      "format-worker.js": { type: "asset", source: "/* bundled Prettier */" },
    },
  );
});
