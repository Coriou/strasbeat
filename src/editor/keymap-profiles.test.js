import { describe, test, beforeEach } from "node:test";
import assert from "node:assert/strict";

import {
  KEYMAP_PROFILES,
  DEFAULT_PROFILE_ID,
  STORAGE_KEY,
  TOOLTIP_SEEN_KEY,
  getProfile,
  getStoredProfileId,
  setStoredProfileId,
  hasSeenTooltip,
  markTooltipSeen,
} from "./keymap-profiles.js";

// Minimal localStorage shim — the production code only uses get/set.
function makeMockStorage() {
  const store = new Map();
  return {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
    clear: () => store.clear(),
    _store: store,
  };
}

beforeEach(() => {
  globalThis.localStorage = makeMockStorage();
});

describe("KEYMAP_PROFILES registry", () => {
  test("contains exactly five profiles in the documented order", () => {
    assert.deepEqual(
      KEYMAP_PROFILES.map((p) => p.id),
      ["strudel", "vscode", "vim", "emacs", "helix"],
    );
  });

  test("exactly one profile is marked default and it matches DEFAULT_PROFILE_ID", () => {
    const defaults = KEYMAP_PROFILES.filter((p) => p.isDefault);
    assert.equal(defaults.length, 1);
    assert.equal(defaults[0].id, DEFAULT_PROFILE_ID);
    assert.equal(DEFAULT_PROFILE_ID, "strudel");
  });

  test("only the VSCode profile applies the strasbeat overlay", () => {
    const overlayProfiles = KEYMAP_PROFILES.filter((p) => p.applyStrasbeatOverlay);
    assert.deepEqual(overlayProfiles.map((p) => p.id), ["vscode"]);
  });

  test("modal profiles (vim, helix) declare a non-empty modes array", () => {
    const modal = KEYMAP_PROFILES.filter((p) => p.isModal);
    assert.deepEqual(modal.map((p) => p.id), ["vim", "helix"]);
    for (const p of modal) {
      assert.ok(Array.isArray(p.modes) && p.modes.length > 0, `${p.id} should have modes`);
    }
  });

  test("every profile has a non-empty description string", () => {
    for (const p of KEYMAP_PROFILES) {
      assert.equal(typeof p.description, "string");
      assert.ok(p.description.length > 0, `${p.id} needs a description`);
    }
  });
});

describe("getProfile()", () => {
  test("returns the matching profile by id", () => {
    assert.equal(getProfile("vim").id, "vim");
  });

  test("falls back to the default profile when id is unknown", () => {
    assert.equal(getProfile("does-not-exist").id, DEFAULT_PROFILE_ID);
  });

  test("falls back to the default profile when id is null/undefined", () => {
    assert.equal(getProfile(null).id, DEFAULT_PROFILE_ID);
    assert.equal(getProfile(undefined).id, DEFAULT_PROFILE_ID);
  });
});

describe("getStoredProfileId() / setStoredProfileId()", () => {
  test("returns DEFAULT_PROFILE_ID when nothing is stored", () => {
    assert.equal(getStoredProfileId(), DEFAULT_PROFILE_ID);
  });

  test("returns the stored id when valid", () => {
    setStoredProfileId("vim");
    assert.equal(getStoredProfileId(), "vim");
    assert.equal(localStorage.getItem(STORAGE_KEY), "vim");
  });

  test("returns DEFAULT_PROFILE_ID when stored value is unknown (and does not throw)", () => {
    localStorage.setItem(STORAGE_KEY, "made-up-profile");
    assert.equal(getStoredProfileId(), DEFAULT_PROFILE_ID);
  });

  test("setStoredProfileId rejects unknown ids without writing", () => {
    setStoredProfileId("not-real");
    assert.equal(localStorage.getItem(STORAGE_KEY), null);
  });
});

describe("hasSeenTooltip() / markTooltipSeen()", () => {
  test("returns false initially", () => {
    assert.equal(hasSeenTooltip(), false);
  });

  test("returns true after markTooltipSeen()", () => {
    markTooltipSeen();
    assert.equal(hasSeenTooltip(), true);
    assert.equal(localStorage.getItem(TOOLTIP_SEEN_KEY), "1");
  });

  test("returns true when storage throws (don't pester)", () => {
    globalThis.localStorage = {
      getItem() { throw new Error("storage unavailable"); },
    };
    assert.equal(hasSeenTooltip(), true);
  });
});
