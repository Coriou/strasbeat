// vite.config.js builds `@strudel/codemirror` from its source modules and
// redirects three of their imports (slimStrudelCodemirrorPlugin), and
// src/editor/lazy-keymaps.js stands in for the Vim and Emacs packages. Both
// are written against how the INSTALLED release of the package is laid out.
// These tests read that release's sources and fail when an upgrade changes
// something the redirects or the stand-in rely on — the things a build would
// not notice (a build-time check in the plugin covers the rest).

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import viteConfig, {
  slimStrudelCodemirrorPlugin,
  isKeptOutOfEntry,
  eagerModuleIds,
} from "../vite.config.js";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkgDir = path.join(root, "node_modules/@strudel/codemirror");

// Every source module of the package (not its prebuilt dist/).
function sourceFiles(dir = pkgDir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "dist" || entry.name === "node_modules") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(full));
    else if (entry.name.endsWith(".mjs")) out.push(full);
  }
  return out;
}
const stripComments = (code) =>
  code.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const sources = sourceFiles().map((file) => ({
  file: path.relative(pkgDir, file),
  code: stripComments(fs.readFileSync(file, "utf8")),
}));

// [{ file, specifier, clause }] for every static import / re-export.
const IMPORT_RE =
  /(?:^|\n)[ \t]*(?:import|export)\s+(?:([^'";=()]*?)\s+from\s*)?['"]([^'"]+)['"]/g;
const imports = sources.flatMap(({ file, code }) =>
  [...code.matchAll(IMPORT_RE)].map((m) => ({
    file,
    clause: m[1] ?? "",
    specifier: m[2],
  })),
);
const namedImports = (clause) =>
  [...(clause.match(/\{([^}]*)\}/)?.[1] ?? "").split(",")]
    .map((part) => part.trim().split(/\s+as\s+/)[0])
    .filter(Boolean);

describe("@strudel/codemirror still has the shape the build relies on", () => {
  test("the source entry the alias points at is published", () => {
    const alias = viteConfig.resolve.alias.find((a) =>
      a.find.test("@strudel/codemirror"),
    );
    assert.equal(alias.replacement, "@strudel/codemirror/index.mjs");
    assert.ok(fs.existsSync(path.join(pkgDir, "index.mjs")));
    assert.ok(imports.length > 20, "the import scan found the sources");
  });

  test("upstream's docs dump is imported only the way the redirect matches", () => {
    const docs = imports.filter((i) => /doc\.json$/.test(i.specifier));
    assert.deepEqual(
      docs.map((i) => `${i.file} ← ${i.specifier}`).sort(),
      ["autocomplete.mjs ← ../../doc.json", "tooltip.mjs ← ../../doc.json"],
    );
    // The stand-in is `{ docs: [] }`: any other property would be undefined.
    for (const { file, code } of sources) {
      for (const [, prop] of code.matchAll(/\bjsdoc\.(\w+)/g)) {
        assert.equal(prop, "docs", `${file} reads jsdoc.${prop}`);
      }
    }
    assert.ok(
      !fs.existsSync(path.join(pkgDir, "doc.json")),
      "the package now ships doc.json — check what imports it",
    );
  });

  test("the Vim and Emacs packages are imported only as the stand-in provides", async () => {
    const shim = await import("./editor/lazy-keymaps.js");
    const keymapImports = imports.filter((i) =>
      /^@replit\/codemirror-(vim|emacs)/.test(i.specifier),
    );
    assert.deepEqual(
      [...new Set(keymapImports.map((i) => i.specifier))].sort(),
      ["@replit/codemirror-emacs", "@replit/codemirror-vim"],
    );
    for (const { file, clause } of keymapImports) {
      assert.ok(
        !/\*|^\w/.test(clause.trim()),
        `${file}: only named imports can be redirected (${clause})`,
      );
      for (const name of namedImports(clause)) {
        assert.ok(name in shim, `${file} imports { ${name} }`);
      }
    }
    // The stand-in records Vim.* calls and replays them once Vim is loaded,
    // so it cannot return anything: only calls made for their effect work.
    for (const { file, code } of sources) {
      for (const [, before, method] of code.matchAll(
        /([^\n;{}]*?)\bVim\.(\w+)\s*\(/g,
      )) {
        assert.ok(
          ["defineEx", "defineAction", "mapCommand"].includes(method),
          `${file} calls Vim.${method}()`,
        );
        assert.equal(
          before.trim(),
          "",
          `${file} uses the result of Vim.${method}()`,
        );
      }
    }
  });

  test("every dependency of the sources is pre-bundled in dev", () => {
    // The package is excluded from Vite's dependency pre-bundling; a bare
    // import from inside it is only served pre-bundled when strasbeat's own
    // code imports the same package or optimizeDeps.include names it.
    const included = viteConfig.optimizeDeps.include.map((entry) =>
      entry.split(">").pop().trim(),
    );
    const appSource = (function read(dir) {
      return fs.readdirSync(dir, { withFileTypes: true }).map((entry) => {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) return read(full);
        return /\.js$/.test(entry.name) && !/\.test\.js$/.test(entry.name)
          ? fs.readFileSync(full, "utf8")
          : "";
      }).join("\n");
    })(path.join(root, "src"));
    const redirected = ["@replit/codemirror-vim", "@replit/codemirror-emacs"];
    const bare = [
      ...new Set(
        imports
          .map((i) => i.specifier)
          .filter((s) => !s.startsWith(".") && !redirected.includes(s)),
      ),
    ];
    assert.ok(bare.includes("@codemirror/state"));
    for (const specifier of bare) {
      const importedByApp = new RegExp(
        `from\\s+["']${specifier.replace(/[/\\^$*+?.()|[\]{}]/g, "\\$&")}["']`,
      ).test(appSource);
      assert.ok(
        importedByApp || included.includes(specifier),
        `"${specifier}" is imported only by @strudel/codemirror: add ` +
          `"@strudel/codemirror > ${specifier}" to optimizeDeps.include`,
      );
    }
  });
});

describe("slimStrudelCodemirrorPlugin", () => {
  const importer = path.join(pkgDir, "keybindings.mjs");
  const build = () => {
    const plugin = slimStrudelCodemirrorPlugin();
    plugin.config({}, { command: "build" });
    plugin.buildStart();
    const errors = [];
    const ctx = {
      error(message) {
        errors.push(message);
      },
    };
    return { plugin, ctx, errors };
  };

  test("redirects only imports made from inside the package", () => {
    const { plugin } = build();
    assert.match(
      plugin.resolveId("@replit/codemirror-vim", importer),
      /src\/editor\/lazy-keymaps\.js$/,
    );
    assert.equal(
      plugin.resolveId(
        "@replit/codemirror-vim",
        path.join(root, "src/editor/lazy-keymaps.js"),
      ),
      null,
      "the stand-in's own import reaches the real package",
    );
    const docs = plugin.resolveId("../../doc.json", importer);
    assert.match(plugin.load(docs), /docs: \[\]/);
  });

  test("a build in which a redirect never fired fails", () => {
    const { plugin, ctx, errors } = build();
    plugin.resolveId("../../doc.json", importer);
    plugin.resolveId("@replit/codemirror-vim", importer);
    plugin.buildEnd.call(ctx);
    assert.equal(errors.length, 1);
    assert.match(errors[0], /no longer imports emacs/);

    plugin.resolveId("@replit/codemirror-emacs", importer);
    errors.length = 0;
    plugin.buildEnd.call(ctx);
    assert.deepEqual(errors, []);
  });

  test("the dev server is not held to it", () => {
    const plugin = slimStrudelCodemirrorPlugin();
    plugin.config({}, { command: "serve" });
    const errors = [];
    plugin.buildEnd.call({ error: (m) => errors.push(m) });
    assert.deepEqual(errors, []);
  });

  test("a build with a keymap package or the docs dump in the first load fails", () => {
    const vimId = "/x/node_modules/@replit/codemirror-vim/dist/index.js";
    const chunk = (fileName, extra) => ({
      type: "chunk",
      fileName,
      isEntry: false,
      imports: [],
      modules: {},
      ...extra,
    });
    const lazy = {
      "index.js": chunk("index.js", {
        isEntry: true,
        imports: ["shared.js"],
        modules: { "/x/src/main.js": {} },
      }),
      "shared.js": chunk("shared.js", {
        modules: { "\0strasbeat:upstream-doc-json": {} },
      }),
      "vim.js": chunk("vim.js", { modules: { [vimId]: {} } }),
      "style.css": { type: "asset", fileName: "style.css" },
    };
    assert.deepEqual(eagerModuleIds(lazy).filter(isKeptOutOfEntry), []);

    const { plugin, ctx, errors } = build();
    plugin.generateBundle.call(ctx, {}, lazy);
    assert.deepEqual(errors, []);

    const eager = {
      ...lazy,
      "shared.js": chunk("shared.js", {
        imports: ["vim.js"],
        modules: { "/x/node_modules/@strudel/doc.json": {} },
      }),
    };
    plugin.generateBundle.call(ctx, {}, eager);
    assert.equal(errors.length, 1);
    assert.match(errors[0], /codemirror-vim/);
    assert.match(errors[0], /doc\.json/);
  });
});
