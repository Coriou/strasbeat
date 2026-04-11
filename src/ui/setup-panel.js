// Setup panel — user configuration for opt-in packages, user samples,
// and a setup script. See design/work/14-strudel-learning-and-extensibility.md
// Phase 2.
//
// Positioned as a sub-section within the Settings panel (to avoid tab
// overflow in the right rail). Can also live as a standalone tab — the
// factory shape is the same either way.

import { makeIcon } from "./icons.js";
import {
  OPT_IN_PACKAGES,
  getEnabledPackages,
  setEnabledPackages,
  getSetupScript,
  setSetupScript,
  getUserSamples,
  importUserSamples,
  deleteUserSampleBank,
  deleteAllUserSamples,
} from "../user-setup.js";

export function createSetupPanel({
  onFocusEditor = () => {},
  onReloadRequired = () => {},
  confirm: confirmFn = window.confirm,
}) {
  let root = null;
  let mounted = false;
  let packageToggles = {};
  let scriptEditor = null;
  let banksEl = null;

  return {
    id: "setup",
    icon: "wrench",
    label: "Setup",
    create,
    activate,
    deactivate,
  };

  function create(container) {
    root = container;
    root.classList.add("setup-panel");

    // ─── Packages section ─────────────────────────────────────────────
    const pkgSection = el("div", "setup-panel__section");
    const pkgLabel = el("div", "setup-panel__section-label", "Opt-in Packages");
    pkgSection.appendChild(pkgLabel);

    const pkgDesc = el(
      "div",
      "setup-panel__desc",
      "Enable additional Strudel packages. Changes take effect on next page reload.",
    );
    pkgSection.appendChild(pkgDesc);

    const enabledSet = new Set(getEnabledPackages());

    for (const pkg of OPT_IN_PACKAGES) {
      const row = el("div", "setup-panel__pkg-row");

      const toggle = document.createElement("input");
      toggle.type = "checkbox";
      toggle.className = "setup-panel__toggle";
      toggle.checked = enabledSet.has(pkg.id);
      toggle.id = `setup-pkg-${pkg.id}`;
      packageToggles[pkg.id] = toggle;
      toggle.addEventListener("change", () => onTogglePackage(pkg.id));

      const label = document.createElement("label");
      label.className = "setup-panel__pkg-label";
      label.htmlFor = toggle.id;

      const nameEl = el("span", "setup-panel__pkg-name", pkg.label);
      const descEl = el("span", "setup-panel__pkg-desc", pkg.description);
      label.appendChild(nameEl);
      label.appendChild(descEl);

      row.appendChild(toggle);
      row.appendChild(label);
      pkgSection.appendChild(row);
    }

    root.appendChild(pkgSection);

    // ─── User samples section ─────────────────────────────────────────
    const sampSection = el("div", "setup-panel__section");
    const sampLabel = el("div", "setup-panel__section-label", "User Samples");
    sampSection.appendChild(sampLabel);

    const sampDesc = el(
      "div",
      "setup-panel__desc",
      "Import sample folder URLs or manage imported banks. Samples are stored in your browser.",
    );
    sampSection.appendChild(sampDesc);

    // Import from URL
    const importRow = el("div", "setup-panel__import-row");
    const urlInput = el("input", "setup-panel__url-input");
    urlInput.type = "text";
    urlInput.placeholder = "Samples JSON URL…";
    urlInput.setAttribute("aria-label", "Sample manifest URL");
    importRow.appendChild(urlInput);

    const importBtn = document.createElement("button");
    importBtn.type = "button";
    importBtn.className = "setup-panel__btn";
    importBtn.textContent = "Import";
    importBtn.addEventListener("click", async () => {
      const url = urlInput.value.trim();
      if (!url) return;
      try {
        const resp = await fetch(url);
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const sampleMap = await resp.json();
        const name =
          new URL(url).pathname
            .split("/")
            .pop()
            ?.replace(/\.json$/i, "") || "user-import";
        await importUserSamples(name, sampleMap);
        urlInput.value = "";
        refreshBanks();
        console.log(`[setup] imported sample bank "${name}" from URL`);
      } catch (err) {
        console.error("[setup] import failed:", err);
        alert(`Import failed: ${err.message}`);
      }
    });
    importRow.appendChild(importBtn);
    sampSection.appendChild(importRow);

    // Bank list
    banksEl = el("div", "setup-panel__banks");
    sampSection.appendChild(banksEl);

    // Delete all
    const deleteAllBtn = document.createElement("button");
    deleteAllBtn.type = "button";
    deleteAllBtn.className = "setup-panel__btn setup-panel__btn--danger";
    deleteAllBtn.textContent = "Delete all user samples";
    deleteAllBtn.addEventListener("click", async () => {
      const yes = await confirmFn(
        "Delete all user samples? This cannot be undone.",
      );
      if (!yes) return;
      await deleteAllUserSamples();
      refreshBanks();
    });
    sampSection.appendChild(deleteAllBtn);
    root.appendChild(sampSection);

    // ─── Setup script section ─────────────────────────────────────────
    const scriptSection = el("div", "setup-panel__section");
    const scriptLabel = el("div", "setup-panel__section-label", "Setup Script");
    scriptSection.appendChild(scriptLabel);

    const scriptDesc = el(
      "div",
      "setup-panel__desc",
      "Runs once at boot after core packages load. Same permissions as pattern code.",
    );
    scriptSection.appendChild(scriptDesc);

    scriptEditor = document.createElement("textarea");
    scriptEditor.className = "setup-panel__script";
    scriptEditor.spellcheck = false;
    scriptEditor.placeholder =
      "// e.g. samples('https://...')\n// or any initialization code";
    scriptEditor.value = getSetupScript();
    scriptSection.appendChild(scriptEditor);

    const scriptActions = el("div", "setup-panel__script-actions");
    const saveScriptBtn = document.createElement("button");
    saveScriptBtn.type = "button";
    saveScriptBtn.className = "setup-panel__btn setup-panel__btn--primary";
    saveScriptBtn.textContent = "Save script";
    saveScriptBtn.addEventListener("click", () => {
      setSetupScript(scriptEditor.value);
      onReloadRequired();
    });
    scriptActions.appendChild(saveScriptBtn);

    const clearScriptBtn = document.createElement("button");
    clearScriptBtn.type = "button";
    clearScriptBtn.className = "setup-panel__btn";
    clearScriptBtn.textContent = "Clear";
    clearScriptBtn.addEventListener("click", () => {
      scriptEditor.value = "";
      setSetupScript("");
    });
    scriptActions.appendChild(clearScriptBtn);
    scriptSection.appendChild(scriptActions);

    root.appendChild(scriptSection);

    // ─── OSC config section (visible when @strudel/osc is enabled) ────
    const DEFAULT_OSC_URL = "ws://localhost:8080";
    const oscEnabled = enabledSet.has("osc");
    if (oscEnabled) {
      const oscSection = el("div", "setup-panel__section");
      const oscLabel = el("div", "setup-panel__section-label", "OSC Output");
      oscSection.appendChild(oscLabel);

      const oscDesc = el(
        "div",
        "setup-panel__desc",
        "Strudel sends OSC messages via WebSocket. The bridge server must listen on the URL below.",
      );
      oscSection.appendChild(oscDesc);

      // URL display (read-only — upstream hardcodes ws://localhost:8080)
      const oscUrlRow = el("div", "setup-panel__osc-url-row");
      const oscUrlLabel = el("span", "setup-panel__osc-url-label", "Target:");
      const oscUrlValue = el(
        "span",
        "setup-panel__osc-url-value",
        DEFAULT_OSC_URL,
      );
      oscUrlRow.append(oscUrlLabel, oscUrlValue);
      oscSection.appendChild(oscUrlRow);

      // Connection status
      const oscStatusRow = el("div", "setup-panel__osc-status-row");
      const oscDot = el("span", "setup-panel__osc-dot");
      oscDot.dataset.status = "unknown";
      const oscStatusText = el(
        "span",
        "setup-panel__osc-status-text",
        "Not connected",
      );
      oscStatusRow.append(oscDot, oscStatusText);
      oscSection.appendChild(oscStatusRow);

      // Test button
      const oscTestBtn = document.createElement("button");
      oscTestBtn.type = "button";
      oscTestBtn.className = "setup-panel__btn";
      oscTestBtn.textContent = "Test connection";
      oscTestBtn.addEventListener("click", async () => {
        oscDot.dataset.status = "connecting";
        oscStatusText.textContent = "Connecting…";
        try {
          const ws = new WebSocket(DEFAULT_OSC_URL);
          await new Promise((resolve, reject) => {
            ws.addEventListener("open", () => {
              oscDot.dataset.status = "connected";
              oscStatusText.textContent = "Connected";
              // Send a test message
              const msg = {
                address: "/strasbeat/test",
                args: ["hello"],
                timestamp: 0,
              };
              ws.send(JSON.stringify(msg));
              console.log("[setup] OSC test message sent to", DEFAULT_OSC_URL);
              resolve();
              setTimeout(() => ws.close(), 500);
            });
            ws.addEventListener("error", () => {
              reject(new Error("Connection failed"));
            });
            ws.addEventListener("close", () => {
              // Only mark as error if we never connected
              if (oscDot.dataset.status === "connecting") {
                reject(new Error("Connection closed"));
              }
            });
            setTimeout(() => reject(new Error("Timeout")), 3000);
          });
        } catch (err) {
          oscDot.dataset.status = "error";
          oscStatusText.textContent = `Error: ${err.message}`;
          console.warn("[setup] OSC test failed:", err.message);
        }
      });
      oscSection.appendChild(oscTestBtn);

      root.appendChild(oscSection);
    }

    mounted = true;
    refreshBanks();
  }

  function activate() {
    if (!mounted) return;
    refreshBanks();
  }

  function deactivate() {}

  // ─── Package toggle handler ─────────────────────────────────────────

  function onTogglePackage(id) {
    const enabled = getEnabledPackages();
    const checked = packageToggles[id]?.checked;
    let next;
    if (checked) {
      next = [...new Set([...enabled, id])];
    } else {
      next = enabled.filter((x) => x !== id);
    }
    setEnabledPackages(next);
    onReloadRequired();
  }

  // ─── Refresh sample banks display ───────────────────────────────────

  async function refreshBanks() {
    if (!banksEl) return;
    banksEl.replaceChildren();
    try {
      const banks = await getUserSamples();
      if (banks.length === 0) {
        banksEl.appendChild(
          el("div", "setup-panel__empty", "No user samples imported yet."),
        );
        return;
      }
      for (const bank of banks) {
        const row = el("div", "setup-panel__bank-row");
        const nameEl = el("span", "setup-panel__bank-name", bank.name);
        row.appendChild(nameEl);
        const delBtn = document.createElement("button");
        delBtn.type = "button";
        delBtn.className = "setup-panel__bank-del";
        delBtn.title = `Delete "${bank.name}"`;
        delBtn.appendChild(makeIcon("trash-2", { size: 12 }));
        delBtn.addEventListener("click", async () => {
          const yes = await confirmFn(`Delete sample bank "${bank.name}"?`);
          if (!yes) return;
          await deleteUserSampleBank(bank.name);
          refreshBanks();
        });
        row.appendChild(delBtn);
        banksEl.appendChild(row);
      }
    } catch (err) {
      banksEl.appendChild(
        el("div", "setup-panel__empty", "Failed to load user samples."),
      );
    }
  }

  // ─── Helpers ──────────────────────────────────────────────────────────

  function el(tag, className, text) {
    const e = document.createElement(tag);
    if (className) e.className = className;
    if (text != null) e.textContent = text;
    return e;
  }
}
