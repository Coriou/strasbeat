// src/editor/completions/providers/chord.js

import { complex } from "@strudel/tonal";
import { score } from "../score.js";
import { getBufferTokens } from "../context.js";

const CATEGORY_BASE = 0.5;
const BUFFER_BOOST = 0.3;

const PITCH_NAMES = [
  "C", "C#", "Db", "D", "D#", "Eb", "E", "E#", "Fb",
  "F", "F#", "Gb", "G", "G#", "Ab", "A", "A#", "Bb",
  "B", "B#", "Cb",
];

const CHORD_SYMBOLS = ["", ...Object.keys(complex)].sort();

const CHORD_NO_QUOTES = /\bchord\(\s*$/;
const CHORD_WITH_QUOTES = /\bchord\(\s*['"][^'"]*$/;
const CHORD_FRAGMENT = /(?:[\s[{(<])([\w#b+^:-]*)$|^([\w#b+^:-]*)$/;

export function chordProvider({ recency }) {
  return function provider(context) {
    const noQuotes = context.matchBefore(CHORD_NO_QUOTES);
    if (noQuotes) return null;
    const ctx = context.matchBefore(CHORD_WITH_QUOTES);
    if (!ctx) return null;

    const text = ctx.text;
    const quoteIdx = Math.max(text.lastIndexOf('"'), text.lastIndexOf("'"));
    if (quoteIdx === -1) return null;
    const inside = text.slice(quoteIdx + 1);
    const fragMatch = inside.match(CHORD_FRAGMENT);
    const fragment = fragMatch ? fragMatch[1] ?? fragMatch[2] ?? "" : "";

    let rootMatch = null;
    let symbolFragment = fragment;
    for (const pitch of PITCH_NAMES) {
      if (fragment.toLowerCase().startsWith(pitch.toLowerCase())) {
        if (!rootMatch || pitch.length > rootMatch.length) {
          rootMatch = pitch;
          symbolFragment = fragment.slice(pitch.length);
        }
      }
    }

    const buffer = getBufferTokens().get("chord");

    if (rootMatch) {
      const ranked = scoreList(CHORD_SYMBOLS, symbolFragment, buffer, recency);
      return {
        from: ctx.to - symbolFragment.length,
        to: ctx.to,
        filter: false,
        options: ranked.map((r) => ({
          label: r.label === "" ? "major" : r.label,
          apply: r.label,
          type: "type",
          detail: "chord quality",
          boost: r.finalScore,
        })),
      };
    }

    const ranked = scoreList(PITCH_NAMES, fragment, buffer, recency);
    return {
      from: ctx.to - fragment.length,
      to: ctx.to,
      filter: false,
      options: ranked.map((r) => ({
        label: r.label,
        type: "pitch",
        boost: r.finalScore,
      })),
    };
  };
}

function scoreList(items, fragment, buffer, recency) {
  const out = [];
  for (const name of items) {
    const m = fragment ? score(fragment, name) : { score: 0.3, matched: [] };
    if (!m) continue;
    const finalScore =
      m.score +
      (buffer.has(name) ? BUFFER_BOOST : 0) +
      recency.score("chord", name) +
      CATEGORY_BASE;
    out.push({ label: name, finalScore });
  }
  out.sort((a, b) => b.finalScore - a.finalScore);
  return out;
}
