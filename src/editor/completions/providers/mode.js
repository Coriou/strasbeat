// src/editor/completions/providers/mode.js

import { score } from "../score.js";
import { getBufferTokens } from "../context.js";

const CATEGORY_BASE = 0.5;
const BUFFER_BOOST = 0.2;

const MODES = [
  { label: "below", detail: "voice below anchor" },
  { label: "above", detail: "voice above anchor" },
  { label: "duck",  detail: "avoid root note" },
  { label: "root",  detail: "root position" },
];

const PITCH_NAMES = [
  "C", "C#", "Db", "D", "D#", "Eb", "E", "F",
  "F#", "Gb", "G", "G#", "Ab", "A", "A#", "Bb", "B",
];

const MODE_NO_QUOTES = /\bmode\(\s*$/;
const MODE_AFTER_COLON = /\bmode\(\s*['"][^'"]*:[^'"]*$/;
const MODE_PRE_COLON = /\bmode\(\s*['"][^'"]*$/;

export function modeProvider({ recency }) {
  return function provider(context) {
    if (context.matchBefore(MODE_NO_QUOTES)) return null;

    const afterColon = context.matchBefore(MODE_AFTER_COLON);
    if (afterColon) {
      const text = afterColon.text;
      const colonIdx = text.lastIndexOf(":");
      const fragment = text.slice(colonIdx + 1);
      const ranked = PITCH_NAMES
        .map((p) => {
          const m = fragment ? score(fragment, p) : { score: 0.3, matched: [] };
          return m ? { label: p, finalScore: m.score + CATEGORY_BASE } : null;
        })
        .filter(Boolean)
        .sort((a, b) => b.finalScore - a.finalScore);
      return {
        from: afterColon.from + colonIdx + 1,
        to: afterColon.to,
        filter: false,
        options: ranked.map((r) => ({
          label: r.label, type: "pitch", boost: r.finalScore,
        })),
      };
    }

    const ctx = context.matchBefore(MODE_PRE_COLON);
    if (!ctx) return null;
    const text = ctx.text;
    const quoteIdx = Math.max(text.lastIndexOf('"'), text.lastIndexOf("'"));
    if (quoteIdx === -1) return null;
    const fragment = text.slice(quoteIdx + 1);

    const buffer = getBufferTokens().get("function"); // mode words bleed into fn ns
    const ranked = MODES
      .map((mode) => {
        const m = fragment ? score(fragment, mode.label) : { score: 0.3, matched: [] };
        if (!m) return null;
        return {
          ...mode,
          finalScore:
            m.score +
            (buffer.has(mode.label) ? BUFFER_BOOST : 0) +
            recency.score("mode", mode.label) +
            CATEGORY_BASE,
        };
      })
      .filter(Boolean)
      .sort((a, b) => b.finalScore - a.finalScore);

    return {
      from: ctx.to - fragment.length,
      to: ctx.to,
      filter: false,
      options: ranked.map((r) => ({
        label: r.label,
        type: "keyword",
        detail: r.detail,
        boost: r.finalScore,
      })),
    };
  };
}
