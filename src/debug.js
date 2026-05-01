import {
  EXPORT_SAMPLE_RATE,
  EXPORT_MAX_POLYPHONY,
  renderPatternToBuffer,
} from "./export.js";
import { score as completionScore } from "./editor/completions/score.js";
import { getBufferTokens } from "./editor/completions/context.js";
import { getInstalledRecency } from "./editor/completions/install.js";
import { rankSounds } from "./editor/completions/providers/sounds.js";

// ─── Console helpers ─────────────────────────────────────────────────────
// Strudel sound names are not 1:1 with the official GM-128 names. Use
// `strasbeat.findSounds("piano")` from devtools to discover what's actually
// loaded before guessing in your patterns.
// Echo helper output into the console panel alongside devtools so the
// composer can see results without switching windows. Additive —
// devtools still get the same `console.log` lines.
export function mountDebugHelpers({
  soundMap,
  getSound,
  editor,
  getConsolePanel,
  getAudioContext,
  setAudioContext,
  setSuperdoughAudioController,
  resetGlobalEffects,
  initAudio,
  superdough,
}) {
  function echoHelper(message, data) {
    console.log(message, data ?? "");
    try {
      getConsolePanel()?.log(message, data);
    } catch (err) {
      console.warn("[strasbeat/console] helper echo failed:", err);
    }
  }

  return {
    /** List loaded sounds whose key matches `query` (regex, case-insensitive). */
    findSounds(query = "") {
      const all = Object.keys(soundMap.get());
      if (!query) {
        echoHelper(`${all.length} sounds loaded — pass a query to filter`);
        return all.slice(0, 30);
      }
      const re = new RegExp(query, "i");
      const matches = all.filter((k) => re.test(k));
      echoHelper(
        `findSounds(${JSON.stringify(query)}) → ${matches.length} match${matches.length === 1 ? "" : "es"}`,
        matches.slice(0, 30),
      );
      return matches;
    },
    /** Total number of registered sounds (samples + soundfonts + synths). */
    countSounds() {
      return Object.keys(soundMap.get()).length;
    },
    /** Check if a specific name resolves. */
    hasSound(name) {
      return !!getSound(name);
    },
    /**
     * Debug helper: render the current pattern offline (no file written) and
     * return per-channel signal stats. Use from devtools to verify the export
     * pipeline still produces audio without flooding ~/Downloads with WAVs.
     *
     *   await strasbeat.probeRender(4)
     */
    async probeRender(cycles = 4, sampleRate = EXPORT_SAMPLE_RATE) {
      await editor.evaluate(false);
      editor.repl.scheduler.stop();
      const pattern = editor.repl.state.pattern;
      const cps = editor.repl.scheduler.cps;
      if (!pattern) throw new Error("no pattern after evaluate");
      const { rendered, scheduled } = await renderPatternToBuffer(
        pattern,
        cps,
        cycles,
        sampleRate,
        {
          getAudioContext,
          getSound,
          setAudioContext,
          setSuperdoughAudioController,
          initAudio,
          superdough,
        },
      );
      const ch0 = rendered.getChannelData(0);
      let absMax = 0,
        nz = 0;
      for (let i = 0; i < ch0.length; i++) {
        const a = Math.abs(ch0[i]);
        if (a > absMax) absMax = a;
        if (ch0[i] !== 0) nz++;
      }
      setAudioContext(null);
      setSuperdoughAudioController(null);
      resetGlobalEffects();
      await initAudio({ maxPolyphony: EXPORT_MAX_POLYPHONY });
      const stats = {
        cps,
        cycles,
        scheduled,
        seconds: rendered.length / sampleRate,
        absMax,
        percentNonZero: (100 * nz) / ch0.length,
      };
      echoHelper(
        `probeRender(${cycles}) → ${scheduled} events, absMax=${absMax.toFixed(3)}`,
        stats,
      );
      return stats;
    },
    /**
     * Live introspection of the intellisense ranking pipeline. Useful for
     * tuning weights from devtools without rebuilding. See
     * design/work/23-intellisense-v2.md (Task 12) for the surface contract.
     */
    completions: {
      /** Pure subsequence score: `completions.score("gmpw", "gm_pad_warm")`. */
      score: (q, c) => completionScore(q, c),
      /** Snapshot of the recency LRU table (or `null` if not installed yet). */
      recency: () => getInstalledRecency()?.snapshot?.() ?? null,
      /** Categorised buffer tokens extracted from the live editor doc. */
      bufferTokens: () => getBufferTokens(),
      /**
       * Re-run the ranker against the live recency + buffer-token state.
       * Today only the `sound` category is exposed.
       */
      rank: (fragment, category) => {
        if (category !== "sound") {
          console.warn("[debug] only 'sound' category exposed for now");
          return [];
        }
        const recency = getInstalledRecency();
        return rankSounds({
          fragment,
          buffer: getBufferTokens().get("sound"),
          recency: recency ?? { score: () => 0, snapshot: () => ({ sound: [] }) },
          allKeys: Object.keys(soundMap.get()),
        });
      },
    },
  };
}
