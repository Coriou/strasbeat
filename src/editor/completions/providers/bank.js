// src/editor/completions/providers/bank.js

import { soundMap } from "@strudel/webaudio";
import { score } from "../score.js";
import { getBufferTokens } from "../context.js";

const CATEGORY_BASE = 0.8;
const BUFFER_BOOST = 0.4;

const BANK_NO_QUOTES = /\bbank\(\s*$/;
const BANK_WITH_QUOTES = /\bbank\(\s*['"][^'"]*$/;

let cachedBanks = [];
let cachedSnapshot = null;

function getBankList() {
  const current = soundMap.get();
  if (current !== cachedSnapshot) {
    cachedSnapshot = current;
    const banks = new Set();
    for (const key of Object.keys(current)) {
      const i = key.indexOf("_");
      if (i > 0) banks.add(key.slice(0, i));
    }
    cachedBanks = [...banks].sort();
  }
  return cachedBanks;
}

export function bankProvider({ recency }) {
  return function provider(context) {
    const noQuotes = context.matchBefore(BANK_NO_QUOTES);
    if (noQuotes) return null;
    const ctx = context.matchBefore(BANK_WITH_QUOTES);
    if (!ctx) return null;

    const text = ctx.text;
    const quoteIdx = Math.max(text.lastIndexOf('"'), text.lastIndexOf("'"));
    if (quoteIdx === -1) return null;
    const fragment = text.slice(quoteIdx + 1);

    const buffer = getBufferTokens().get("bank");
    const ranked = [];
    for (const name of getBankList()) {
      const m = score(fragment, name);
      if (!m) continue;
      const finalScore =
        m.score +
        (buffer.has(name) ? BUFFER_BOOST : 0) +
        recency.score("bank", name) +
        CATEGORY_BASE;
      ranked.push({ label: name, finalScore });
    }
    ranked.sort((a, b) => b.finalScore - a.finalScore);
    return {
      from: ctx.to - fragment.length,
      to: ctx.to,
      filter: false,
      options: ranked.map((r) => ({
        label: r.label,
        type: "namespace",
        detail: "bank",
        boost: r.finalScore,
      })),
    };
  };
}
