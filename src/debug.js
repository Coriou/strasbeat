import {
  EXPORT_SAMPLE_RATE,
  EXPORT_MAX_POLYPHONY,
  renderPatternToBuffer,
} from "./export.js";

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
  };
}
