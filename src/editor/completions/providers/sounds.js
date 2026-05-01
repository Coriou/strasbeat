// src/editor/completions/providers/sounds.js

import { soundMap } from "@strudel/webaudio";
import { score } from "../score.js";
import { getBufferTokens } from "../context.js";
import { buildAuditionInfo } from "../info.js";

const CATEGORY_BASE = 1.0;
const BUFFER_BOOST = 0.5;
const RECENCY_BOOST_MAX = 0.3;
const IN_BANK_BOOST = 0.2;
const MAX_RESULTS = 80;

const STARTER_SHELF = [
  "bd", "sd", "hh", "oh", "cp", "ride",
  "gm_piano", "gm_pad_warm", "gm_strings",
  "sine", "saw", "tri",
];

const SOUND_NO_QUOTES = /(?:^|[^\w])(?:s|sound)\(\s*$/;
const SOUND_WITH_QUOTES = /(?:^|[^\w])(?:s|sound)\(\s*['"][^'"]*$/;
const SOUND_FRAGMENT = /(?:[\s[{(<])([\w]*)$|^([\w]*)$/;

let cachedSoundKeys = [];
let cachedSnapshot = null;

function getSoundKeys() {
  const current = soundMap.get();
  if (current !== cachedSnapshot) {
    cachedSnapshot = current;
    cachedSoundKeys = Object.keys(current);
  }
  return cachedSoundKeys;
}

export function soundsProvider({ recency, audition }) {
  return function provider(context) {
    const noQuotes = context.matchBefore(SOUND_NO_QUOTES);
    if (noQuotes) {
      // Cursor at `s(` with no quote yet — defer to ergonomics phase
      // for snippet expansion; for now, no completions here.
      return null;
    }

    const ctx = context.matchBefore(SOUND_WITH_QUOTES);
    if (!ctx) return null;

    const text = ctx.text;
    const quoteIdx = Math.max(text.lastIndexOf('"'), text.lastIndexOf("'"));
    if (quoteIdx === -1) return null;
    const inside = text.slice(quoteIdx + 1);

    const fragMatch = inside.match(SOUND_FRAGMENT);
    const fragment = fragMatch ? fragMatch[1] ?? fragMatch[2] ?? "" : "";

    return rank({
      fragment,
      from: ctx.to - fragment.length,
      to: ctx.to,
      explicit: context.explicit,
      recency,
      audition,
    });
  };
}

/**
 * Pure ranking — exported for tests and for the mini-notation provider
 * to reuse on the inside-string path.
 *
 * Result shape: `{ label, detail, apply, finalScore, bank, inBank }`.
 *
 * - `label` — what the popup shows as the title. For an in-bank candidate
 *   under a `bank("X")` chain, this is the short suffix (`bd`); otherwise
 *   it's the full name.
 * - `detail` — secondary text. The full resolved name for in-bank, or the
 *   bank prefix (or "") for out-of-bank.
 * - `apply` — what gets inserted on accept. Same semantics as `label`:
 *   short suffix in-bank, full name otherwise.
 * - `bank` — the bank prefix of the underlying sound name (used by the
 *   sounds-provider info panel and by external callers).
 * - `inBank` — true iff this candidate is a member of the in-scope bank.
 *   The mini-notation provider uses this to decide whether to forward
 *   `{ bank: bankInScope }` to the audition callback (only in-bank
 *   candidates get the bank rewrite — passing it for out-of-bank would
 *   double-prefix the resolved name).
 */
export function rankSounds({ fragment, buffer, recency, allKeys, bankInScope = null }) {
  if (!fragment) {
    return rankStarterShelf({ buffer, recency, allKeys });
  }
  const out = [];
  const bankPrefix_ = bankInScope ? `${bankInScope}_`.toLowerCase() : null;

  for (const name of allKeys) {
    let scoreTarget = name;
    let inBank = false;
    let displayLabel = name;
    let displayDetail = bankPrefix(name);
    let applyText = name;

    if (bankPrefix_ && name.toLowerCase().startsWith(bankPrefix_)) {
      const suffix = name.slice(bankInScope.length + 1);
      scoreTarget = suffix;
      inBank = true;
      displayLabel = suffix;
      displayDetail = name;
      applyText = suffix;
    }

    const m = score(fragment, scoreTarget);
    if (!m) continue;
    const finalScore =
      m.score +
      (buffer.has(name) ? BUFFER_BOOST : 0) +
      recency.score("sound", name) +
      (inBank ? IN_BANK_BOOST : 0) +
      CATEGORY_BASE;
    out.push({
      label: displayLabel,
      detail: displayDetail,
      apply: applyText,
      finalScore,
      bank: bankPrefix(name),
      inBank,
    });
  }
  out.sort((a, b) => b.finalScore - a.finalScore);
  return out.slice(0, MAX_RESULTS);
}

function rankStarterShelf({ buffer, recency, allKeys }) {
  const keys = new Set(allKeys);
  const present = STARTER_SHELF.filter((n) => keys.has(n));
  const seen = new Set(present);
  const bufferEntries = [...buffer].filter((n) => keys.has(n) && !seen.has(n));
  bufferEntries.forEach((n) => seen.add(n));
  const recent = recency.snapshot
    ? recency.snapshot().sound.map((e) => e.label).filter((n) => keys.has(n) && !seen.has(n))
    : [];

  const out = [];
  for (const name of [...present, ...bufferEntries, ...recent]) {
    const finalScore =
      0.5 +
      (buffer.has(name) ? BUFFER_BOOST : 0) +
      recency.score("sound", name) +
      CATEGORY_BASE;
    const bank = bankPrefix(name);
    out.push({ label: name, detail: bank, apply: name, finalScore, bank, inBank: false });
  }
  return out.slice(0, 20);
}

function rank({ fragment, from, to, explicit, recency, audition }) {
  const buffer = getBufferTokens().get("sound");
  const allKeys = getSoundKeys();
  if (!fragment && !explicit) {
    // Don't auto-trigger an empty starter shelf during normal typing —
    // only on Ctrl+Space (explicit). The mini-notation provider handles
    // space-inside-string as a separate auto-trigger.
    return null;
  }
  const ranked = rankSounds({ fragment, buffer, recency, allKeys });
  return {
    from,
    to,
    filter: false,
    options: ranked.map((r) => ({
      label: r.label,
      type: "sound",
      detail: r.detail,
      apply: r.apply,
      boost: r.finalScore,
      info: audition ? () => buildAuditionInfo(r.apply ?? r.label, audition) : undefined,
      // Stash the audition payload so Alt+Arrow keyboard preview can
      // fire the right name. This is the regex-fallback path — no bank
      // context is detected here by design, so no `bank` is forwarded.
      _audition: { name: r.apply ?? r.label },
    })),
  };
}

function bankPrefix(name) {
  const i = name.indexOf("_");
  return i > 0 ? name.slice(0, i) : "";
}
