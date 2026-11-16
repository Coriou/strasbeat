// src/editor/completions/providers/chord.js

import { insertCompletionText, pickedCompletion } from "@codemirror/autocomplete";
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

// The chord qualities @strudel/tonal's voicing dictionaries know. `complex`
// already contains the empty symbol (a bare root is a major triad), so it is
// not added by hand — that listed the major row twice.
//
// The empty symbol can't be shown as an empty row, so it is labelled "major"
// — but "major" is NOT a symbol the dictionaries accept (`chord("Cmajor")` is
// an unknown chord → silence). `insert` is what accepting the row writes.
const CHORD_QUALITIES = Object.keys(complex)
  .sort()
  .map((symbol) => ({ insert: symbol, label: symbol === "" ? "major" : symbol }));

// CodeMirror falls back to the label when `apply` is an empty string, so the
// major row needs a function to really insert nothing.
function applyInsert(insert) {
  return (view, completion, from, to) => {
    view.dispatch({
      ...insertCompletionText(view.state, insert, from, to),
      annotations: pickedCompletion.of(completion),
    });
  };
}

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
      const ranked = scoreList(CHORD_QUALITIES, symbolFragment, buffer, recency);
      return {
        from: ctx.to - symbolFragment.length,
        to: ctx.to,
        filter: false,
        options: ranked.map((r) => ({
          label: r.label,
          apply: r.insert === "" ? applyInsert("") : r.insert,
          type: "type",
          detail: "chord quality",
          boost: r.finalScore,
        })),
      };
    }

    const ranked = scoreList(
      PITCH_NAMES.map((name) => ({ insert: name, label: name })),
      fragment,
      buffer,
      recency,
    );
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
  for (const { insert, label } of items) {
    const m = fragment ? score(fragment, label) : { score: 0.3, matched: [] };
    if (!m) continue;
    const finalScore =
      m.score +
      (buffer.has(label) ? BUFFER_BOOST : 0) +
      recency.score("chord", label) +
      CATEGORY_BASE;
    out.push({ label, insert, finalScore });
  }
  out.sort((a, b) => b.finalScore - a.finalScore);
  return out;
}
