import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
  buildExport,
  parseImportJson,
  previewImport,
  applyImport,
} from "./library-io.js";

function makeStore({ index = { lastOpen: null, userPatterns: [], folders: [] }, records = {} } = {}) {
  const recs = new Map(Object.entries(records));
  const idxRef = structuredClone(index);
  return {
    get: (n) => (recs.has(n) ? structuredClone(recs.get(n)) : null),
    set: (n, r) => recs.set(n, structuredClone(r)),
    delete: (n) => recs.delete(n),
    keys: () => Array.from(recs.keys()),
    getIndex: () => structuredClone(idxRef),
    setIndex: (i) => Object.assign(idxRef, i),
    renamePatternKey: () => {},
    renameFolderInRecords: () => 0,
  };
}

describe("buildExport", () => {
  test("emits the documented shape", () => {
    const store = makeStore({
      index: { lastOpen: "a", userPatterns: ["a"], folders: ["Jazz"] },
      records: {
        a: { code: "x", modified: "2026-05-10T00:00:00Z", isUserPattern: true, folder: "Jazz" },
        "05-dub": { code: "y", modified: "2026-05-09T00:00:00Z", isUserPattern: false },
      },
    });
    const exp = buildExport(store, { now: () => new Date("2026-05-11T00:00:00Z") });
    assert.equal(exp.version, 1);
    assert.equal(exp.exportedAt, "2026-05-11T00:00:00.000Z");
    assert.deepEqual(exp.folders, ["Jazz"]);
    assert.deepEqual(exp.patterns.a, {
      code: "x", modified: "2026-05-10T00:00:00Z", isUserPattern: true, folder: "Jazz",
    });
    // Demo working copies have no folder field.
    assert.deepEqual(exp.patterns["05-dub"], {
      code: "y", modified: "2026-05-09T00:00:00Z", isUserPattern: false,
    });
  });

  test("excludes nothing — empty store still produces a valid file", () => {
    const exp = buildExport(makeStore(), { now: () => new Date(0) });
    assert.equal(exp.version, 1);
    assert.deepEqual(exp.folders, []);
    assert.deepEqual(exp.patterns, {});
  });
});

describe("parseImportJson", () => {
  test("accepts a valid file", () => {
    const json = JSON.stringify({
      version: 1, exportedAt: "t",
      folders: ["Jazz"],
      patterns: { a: { code: "x", modified: "t", isUserPattern: true, folder: "Jazz" } },
    });
    const r = parseImportJson(json);
    assert.ok(r.ok);
    assert.equal(r.data.version, 1);
  });

  test("rejects non-JSON text", () => {
    const r = parseImportJson("not json");
    assert.equal(r.ok, false);
  });

  test("rejects unsupported version", () => {
    const r = parseImportJson(JSON.stringify({ version: 2, folders: [], patterns: {} }));
    assert.equal(r.ok, false);
    assert.match(r.error, /version/i);
  });

  test("rejects missing folders or patterns", () => {
    assert.equal(parseImportJson(JSON.stringify({ version: 1 })).ok, false);
    assert.equal(parseImportJson(JSON.stringify({ version: 1, folders: [] })).ok, false);
    assert.equal(parseImportJson(JSON.stringify({ version: 1, patterns: {} })).ok, false);
  });

  test("rejects wrong types", () => {
    assert.equal(parseImportJson(JSON.stringify({ version: 1, folders: "a", patterns: {} })).ok, false);
    assert.equal(parseImportJson(JSON.stringify({ version: 1, folders: [], patterns: [] })).ok, false);
  });

  test("rejects invalid pattern names", () => {
    const json = JSON.stringify({
      version: 1, folders: [],
      patterns: { "has space": { code: "x", modified: "t", isUserPattern: true } },
    });
    const r = parseImportJson(json);
    assert.equal(r.ok, false);
    assert.match(r.error, /invalid pattern name/i);
  });

  test("rejects records missing required fields", () => {
    for (const rec of [
      {}, // missing everything
      { code: 1, modified: "t", isUserPattern: true }, // wrong code type
      { code: "x", modified: 1, isUserPattern: true }, // wrong modified type
      { code: "x", modified: "t" }, // missing isUserPattern
      { code: "x", modified: "t", isUserPattern: "yes" }, // wrong isUserPattern type
      { code: "x", modified: "t", isUserPattern: true, folder: 1 }, // non-string folder
    ]) {
      const r = parseImportJson(JSON.stringify({
        version: 1, folders: [],
        patterns: { a: rec },
      }));
      assert.equal(r.ok, false, `expected reject for ${JSON.stringify(rec)}`);
    }
  });

  test("rejects reserved folder names in the import", () => {
    for (const f of ["Demos", "Unfiled", "DEMOS"]) {
      const r = parseImportJson(JSON.stringify({
        version: 1, folders: [f], patterns: {},
      }));
      assert.equal(r.ok, false);
      assert.match(r.error, /reserved/i);
    }
  });

  test("strips orphan folder field on a pattern record", () => {
    const r = parseImportJson(JSON.stringify({
      version: 1, folders: ["Jazz"],
      patterns: { a: { code: "x", modified: "t", isUserPattern: true, folder: "Nope" } },
    }));
    assert.ok(r.ok);
    assert.equal(r.data.patterns.a.folder, undefined);
  });

  test("preserves a valid folder field", () => {
    const r = parseImportJson(JSON.stringify({
      version: 1, folders: ["Jazz"],
      patterns: { a: { code: "x", modified: "t", isUserPattern: true, folder: "Jazz" } },
    }));
    assert.ok(r.ok);
    assert.equal(r.data.patterns.a.folder, "Jazz");
  });
});

describe("previewImport", () => {
  test("computes new folders, new patterns, conflicts, and untransferable demos", () => {
    const store = makeStore({
      index: { lastOpen: null, userPatterns: ["existing"], folders: ["Jazz"] },
      records: {
        existing: { code: "x", modified: "t", isUserPattern: true, folder: "Jazz" },
      },
    });
    const shippedDemos = new Set(["05-dub"]); // currently-shipped demo names
    const json = {
      version: 1, exportedAt: "t",
      folders: ["Jazz", "Live"],
      patterns: {
        existing: { code: "y", modified: "t", isUserPattern: true, folder: "Jazz" },
        "new-tune": { code: "z", modified: "t", isUserPattern: true, folder: "Live" },
        "05-dub":    { code: "a", modified: "t", isUserPattern: false }, // demo wc, demo exists
        "gone-demo": { code: "b", modified: "t", isUserPattern: false }, // demo wc, demo gone
      },
    };
    const pv = previewImport(json, store, shippedDemos);
    assert.deepEqual(pv.newFolders, ["Live"]);
    assert.deepEqual(pv.conflicts.sort(), ["existing"]);
    assert.deepEqual(pv.newUserPatterns.sort(), ["new-tune"]);
    assert.deepEqual(pv.demoWorkingCopies.transferable, ["05-dub"]);
    assert.deepEqual(pv.demoWorkingCopies.untransferable, ["gone-demo"]);
  });
});

describe("applyImport: conflict strategies", () => {
  const baseJson = {
    version: 1, exportedAt: "t",
    folders: ["Jazz", "Live"],
    patterns: {
      existing: { code: "NEW", modified: "t", isUserPattern: true, folder: "Live" },
      brand:    { code: "Z",   modified: "t", isUserPattern: true, folder: "Jazz" },
    },
  };

  test("skip leaves existing record alone, imports new ones", () => {
    const store = makeStore({
      index: { lastOpen: null, userPatterns: ["existing"], folders: [] },
      records: { existing: { code: "OLD", modified: "t", isUserPattern: true, folder: "Jazz" } },
    });
    const r = applyImport(baseJson, store, { conflictStrategy: "skip", shippedDemos: new Set() });
    assert.equal(r.imported, 1); // brand
    assert.equal(r.skipped, 1);   // existing
    assert.equal(store.get("existing").code, "OLD");
    assert.equal(store.get("brand").code, "Z");
    assert.deepEqual(store.getIndex().folders, ["Jazz", "Live"]);
    assert.ok(store.getIndex().userPatterns.includes("brand"));
  });

  test("overwrite replaces existing record", () => {
    const store = makeStore({
      index: { lastOpen: null, userPatterns: ["existing"], folders: [] },
      records: { existing: { code: "OLD", modified: "t", isUserPattern: true } },
    });
    const r = applyImport(baseJson, store, { conflictStrategy: "overwrite", shippedDemos: new Set() });
    assert.equal(r.imported, 2);
    assert.equal(store.get("existing").code, "NEW");
    assert.equal(store.get("existing").folder, "Live");
  });

  test("rename writes the import under <name>-imported, increments on collision", () => {
    const store = makeStore({
      index: { lastOpen: null, userPatterns: ["existing", "existing-imported"], folders: [] },
      records: {
        existing: { code: "OLD", modified: "t", isUserPattern: true },
        "existing-imported": { code: "PRIOR", modified: "t", isUserPattern: true },
      },
    });
    const r = applyImport(baseJson, store, { conflictStrategy: "rename", shippedDemos: new Set() });
    assert.equal(store.get("existing").code, "OLD"); // untouched
    assert.equal(store.get("existing-imported").code, "PRIOR");
    assert.equal(store.get("existing-imported-2").code, "NEW");
    assert.ok(r.renamed.find((p) => p.from === "existing" && p.to === "existing-imported-2"));
  });

  test("demo working copies are imported only if the demo exists in this build", () => {
    const store = makeStore();
    const json = {
      version: 1, exportedAt: "t", folders: [],
      patterns: {
        "05-dub":    { code: "A", modified: "t", isUserPattern: false },
        "gone-demo": { code: "B", modified: "t", isUserPattern: false },
      },
    };
    const r = applyImport(json, store, { conflictStrategy: "skip", shippedDemos: new Set(["05-dub"]) });
    assert.equal(store.get("05-dub")?.code, "A");
    assert.equal(store.get("gone-demo"), null);
    assert.equal(r.skipped, 1); // gone-demo
  });

  test("local edits to a Demo are a conflict: kept on skip, kept beside the import on rename", () => {
    const json = {
      version: 1, exportedAt: "t", folders: [],
      patterns: { "05-dub": { code: "FROM_BACKUP", modified: "t", isUserPattern: false } },
    };
    const shippedDemos = new Set(["05-dub"]);
    const local = () => makeStore({
      records: { "05-dub": { code: "MY_EDITS", modified: "t", isUserPattern: false } },
    });

    assert.deepEqual(previewImport(json, local(), shippedDemos).conflicts, ["05-dub"]);

    let store = local();
    let r = applyImport(json, store, { conflictStrategy: "skip", shippedDemos });
    assert.equal(store.get("05-dub").code, "MY_EDITS");
    assert.equal(r.skipped, 1);
    assert.equal(r.imported, 0);

    store = local();
    r = applyImport(json, store, { conflictStrategy: "rename", shippedDemos });
    assert.equal(store.get("05-dub").code, "MY_EDITS");
    assert.equal(store.get("05-dub-imported").code, "FROM_BACKUP");
    assert.equal(store.get("05-dub-imported").isUserPattern, true);
    assert.ok(store.getIndex().userPatterns.includes("05-dub-imported"));

    store = local();
    applyImport(json, store, { conflictStrategy: "overwrite", shippedDemos });
    assert.equal(store.get("05-dub").code, "FROM_BACKUP");
  });

  test("an identical Demo copy, or one with no local edits, is not a conflict", () => {
    const json = {
      version: 1, exportedAt: "t", folders: [],
      patterns: { "05-dub": { code: "SAME", modified: "t", isUserPattern: false } },
    };
    const shippedDemos = new Set(["05-dub"]);
    assert.deepEqual(previewImport(json, makeStore(), shippedDemos).conflicts, []);
    const same = makeStore({ records: { "05-dub": { code: "SAME", modified: "t", isUserPattern: false } } });
    assert.deepEqual(previewImport(json, same, shippedDemos).conflicts, []);
  });

  test("a pattern named __proto__ is exported like any other", () => {
    const store = makeStore({
      index: { lastOpen: null, userPatterns: ["__proto__"], folders: [] },
      records: { ["__proto__"]: { code: "X", modified: "t", isUserPattern: true } },
    });
    const text = JSON.stringify(buildExport(store));
    assert.equal(JSON.parse(text).patterns["__proto__"].code, "X");
  });

  test("QuotaExceededError aborts cleanly, reports counts", () => {
    const store = makeStore();
    let calls = 0;
    store.set = (n, r) => {
      if (++calls > 1) {
        const e = new Error("quota"); e.name = "QuotaExceededError";
        throw e;
      }
    };
    const r = applyImport(baseJson, store, { conflictStrategy: "skip", shippedDemos: new Set() });
    assert.equal(r.ok, false);
    assert.equal(r.imported, 1);
    assert.match(r.error, /storage/i);
  });
});

describe("applyImport: organisation and partial failures", () => {
  const rec = (extra = {}) => ({ code: "C", modified: "t", isUserPattern: true, ...extra });

  test("files a pattern under the local spelling of a folder that differs only by case", () => {
    const store = makeStore({ index: { lastOpen: null, userPatterns: [], folders: ["Jazz"] } });
    const parsed = parseImportJson(JSON.stringify({
      version: 1, exportedAt: "t", folders: ["jazz", " Live "],
      patterns: { a: rec({ folder: "jazz" }), b: rec({ folder: "LIVE" }) },
    }));
    assert.equal(parsed.ok, true);
    const r = applyImport(parsed.data, store, { conflictStrategy: "skip", shippedDemos: new Set() });
    assert.equal(r.ok, true);
    assert.deepEqual(store.getIndex().folders, ["Jazz", "Live"]);
    assert.equal(store.get("a").folder, "Jazz");
    assert.equal(store.get("b").folder, "Live");
  });

  test("a quota failure part-way still lists what was written, and says how far it got", () => {
    const store = makeStore();
    const realSet = store.set;
    let calls = 0;
    store.set = (n, r) => {
      if (++calls > 2) { const e = new Error("quota"); e.name = "QuotaExceededError"; throw e; }
      return realSet(n, r);
    };
    const json = { version: 1, exportedAt: "t", folders: [], patterns: { p1: rec(), p2: rec(), p3: rec(), p4: rec() } };
    const r = applyImport(json, store, { conflictStrategy: "skip", shippedDemos: new Set() });
    assert.equal(r.ok, false);
    assert.equal(r.imported, 2);
    assert.match(r.error, /storage full.*2 of 4/i);
    assert.deepEqual(store.getIndex().userPatterns, ["p1", "p2"], "written records are not stranded");
    assert.deepEqual(r.written, ["p1", "p2"]);
  });

  test("when even the index can't be written, the records this import created are removed", () => {
    const store = makeStore({
      index: { lastOpen: null, userPatterns: ["old"], folders: [] },
      records: { old: rec({ code: "OLD" }) },
    });
    store.setIndex = () => { const e = new Error("quota"); e.name = "QuotaExceededError"; throw e; };
    const json = { version: 1, exportedAt: "t", folders: [], patterns: { p1: rec(), p2: rec() } };
    const r = applyImport(json, store, { conflictStrategy: "skip", shippedDemos: new Set() });
    assert.equal(r.ok, false);
    assert.equal(r.imported, 0);
    assert.equal(store.get("p1"), null);
    assert.equal(store.get("p2"), null);
    assert.equal(store.get("old").code, "OLD");
  });

  test("a user pattern named like a shipped Demo is a conflict, never written under that name", () => {
    const shippedDemos = new Set(["01-demo"]);
    const json = { version: 1, exportedAt: "t", folders: [], patterns: { "01-demo": rec({ code: "MINE" }) } };
    const pv = previewImport(json, makeStore(), shippedDemos);
    assert.deepEqual(pv.conflicts, ["01-demo"]);
    assert.deepEqual(pv.newUserPatterns, []);

    const skip = makeStore();
    assert.equal(applyImport(json, skip, { conflictStrategy: "skip", shippedDemos }).skipped, 1);
    assert.equal(skip.get("01-demo"), null);

    for (const strategy of ["overwrite", "rename"]) {
      const store = makeStore();
      const r = applyImport(json, store, { conflictStrategy: strategy, shippedDemos });
      assert.equal(store.get("01-demo"), null, `${strategy}: demo name untouched`);
      assert.equal(store.get("01-demo-imported").code, "MINE");
      assert.deepEqual(r.renamed, [{ from: "01-demo", to: "01-demo-imported" }]);
      assert.deepEqual(store.getIndex().userPatterns, ["01-demo-imported"]);
    }
  });

  test("reports every name it wrote", () => {
    const store = makeStore({ index: { lastOpen: null, userPatterns: ["a"], folders: [] }, records: { a: rec({ code: "OLD" }) } });
    const json = {
      version: 1, exportedAt: "t", folders: [],
      patterns: { a: rec({ code: "NEW" }), b: rec(), demo: { code: "D", modified: "t", isUserPattern: false } },
    };
    const r = applyImport(json, store, { conflictStrategy: "overwrite", shippedDemos: new Set(["demo"]) });
    assert.deepEqual(r.written.sort(), ["a", "b", "demo"]);
    assert.equal(store.get("a").code, "NEW");
  });
});
