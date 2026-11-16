// Stand-in for `@replit/codemirror-vim` and `@replit/codemirror-emacs` as
// seen by `@strudel/codemirror` (the redirect is in vite.config.js).
//
// Upstream's keybindings.mjs imports both keymaps statically and builds the
// editor's keymap extension synchronously: `keybindings("vim")` returns
// `[Prec.high(vim()), …]`. That puts ~140 kB of modal-editing code in front
// of every user's first paint, including the large majority who never
// leave the default keymap. This module exports the same three names
// upstream imports — `vim`, `Vim`, `emacs` — but fetches the real package
// only when its keymap is first asked for:
//
//   - `vim()` / `emacs()` return the real extension once the package is
//     loaded. Before that they return an empty extension (the editor keeps
//     its base keymap, so typing works) and start the fetch; when it
//     completes, `onKeymapLoaded` subscribers are told, and the app applies
//     the profile again so the real extension replaces the empty one (see
//     main.js). The same path serves a profile restored at boot and one
//     picked from the keymap chip or the settings panel.
//   - `Vim` is the object upstream configures at import time
//     (`Vim.defineEx("write", "w", …)` for `:w` → evaluate, `:q` → stop,
//     `gc` → toggle comment). Those calls are recorded and replayed on the
//     real `Vim` as soon as it exists, before any view can use it.
//
// A failed fetch is reported to the user by `lazyImport`; the editor stays
// on its base keymap and the next attempt to use the keymap retries.
//
// Between asking for a keymap and having it, the editor is NOT in that
// keymap — in Vim's case it inserts what a Vim user types as commands.
// `keymapStatus` / `onKeymapStatus` say which of the three it is, so the UI
// never names a keymap (or a Vim mode) that is not actually in force.

import { lazyImport } from "../lazy-import.js";

/**
 * @param {Record<string, {
 *   load: () => Promise<object>,
 *   extension: (mod: object, ...args: unknown[]) => unknown,
 *   onLoad?: (mod: object) => void,
 * }>} defs
 */
export function createLazyKeymaps(defs) {
  const listeners = new Set();
  const statusListeners = new Set();
  const state = new Map(
    Object.keys(defs).map((name) => [
      name,
      { mod: null, pending: null, failed: false },
    ]),
  );

  function status(name) {
    const s = state.get(name);
    // Not one of ours: built in, nothing to wait for.
    if (!s || s.mod) return "ready";
    if (s.pending) return "loading";
    return s.failed ? "failed" : "idle";
  }

  function emitStatus(name) {
    const now = status(name);
    for (const fn of [...statusListeners]) {
      try {
        fn(name, now);
      } catch (err) {
        console.warn("[strasbeat/keymap] keymap-status listener threw:", err);
      }
    }
  }

  function ensure(name) {
    const def = defs[name];
    const s = state.get(name);
    if (!def || !s) return Promise.reject(new Error(`unknown keymap "${name}"`));
    if (s.mod) return Promise.resolve(s.mod);
    if (!s.pending) {
      s.failed = false;
      s.pending = Promise.resolve()
        .then(() => def.load())
        .then(
          (mod) => {
            s.mod = mod;
            s.pending = null;
            def.onLoad?.(mod);
            for (const fn of [...listeners]) {
              try {
                fn(name);
              } catch (err) {
                console.warn("[strasbeat/keymap] keymap-loaded listener threw:", err);
              }
            }
            // After the loaded listeners: by now the app has put the real
            // keymap into the editor, so "ready" is true of the editor too.
            emitStatus(name);
            return mod;
          },
          (err) => {
            s.pending = null;
            s.failed = true;
            emitStatus(name);
            throw err;
          },
        );
      emitStatus(name);
    }
    return s.pending;
  }

  return {
    ensure,
    isLoaded: (name) => Boolean(state.get(name)?.mod),
    /**
     * Where a keymap stands: "ready" (in, or never lazy), "loading",
     * "failed" (the last fetch failed and nothing has retried), or "idle"
     * (lazy and not asked for yet).
     */
    status,
    /** `fn(name, status)` each time a keymap's status changes. */
    onStatus(fn) {
      statusListeners.add(fn);
      return () => statusListeners.delete(fn);
    },
    /**
     * The function upstream calls to get the keymap's extension. Returns
     * the real one when the package is in, otherwise an empty extension
     * while the fetch (started here) is under way.
     */
    extension(name) {
      return (...args) => {
        const s = state.get(name);
        if (s.mod) return defs[name].extension(s.mod, ...args);
        // The failure is reported where it is caught (lazyImport); here it
        // only means "still on the base keymap".
        ensure(name).catch(() => {});
        return [];
      };
    },
    /** `fn(name)` each time a keymap's package finishes loading. */
    onLoaded(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}

/**
 * An object that accepts any method call and remembers it, until `adopt`
 * hands it the real thing: the remembered calls are replayed in order and
 * every later access goes straight through.
 */
export function createCallRecorder() {
  let real = null;
  const calls = [];
  const proxy = new Proxy(
    {},
    {
      get(_target, prop) {
        if (real) {
          const value = real[prop];
          return typeof value === "function" ? value.bind(real) : value;
        }
        if (typeof prop !== "string") return undefined;
        return (...args) => {
          calls.push([prop, args]);
        };
      },
    },
  );
  function adopt(target) {
    real = target;
    for (const [prop, args] of calls.splice(0)) {
      try {
        real[prop](...args);
      } catch (err) {
        console.warn(`[strasbeat/keymap] replaying Vim.${prop}() failed:`, err);
      }
    }
  }
  return { proxy, adopt };
}

const vimApi = createCallRecorder();

const keymaps = createLazyKeymaps({
  vim: {
    load: () =>
      lazyImport(() => import("@replit/codemirror-vim"), {
        what: "the Vim keymap",
      }),
    extension: (mod, ...args) => mod.vim(...args),
    onLoad: (mod) => vimApi.adopt(mod.Vim),
  },
  emacs: {
    load: () =>
      lazyImport(() => import("@replit/codemirror-emacs"), {
        what: "the Emacs keymap",
      }),
    extension: (mod, ...args) => mod.emacs(...args),
  },
});

// The names `@strudel/codemirror`'s keybindings.mjs imports.
export const vim = keymaps.extension("vim");
export const emacs = keymaps.extension("emacs");
export const Vim = vimApi.proxy;

// For the app.
export const onKeymapLoaded = keymaps.onLoaded;
export const isKeymapLoaded = keymaps.isLoaded;
export const keymapStatus = keymaps.status;
export const onKeymapStatus = keymaps.onStatus;
/** Fetch a keymap (again). Failures are reported, never thrown. */
export const loadKeymap = (name) => keymaps.ensure(name).catch(() => {});
