/**
 * Mini-notation tokeniser helper.
 *
 * Given a mini-notation string and a cursor offset within it, identifies
 * the "current token" — the whitespace-delimited fragment the cursor is
 * in or at the end of. Doesn't parse the full mini-notation grammar;
 * just finds word boundaries so autocomplete knows what to replace.
 */

/**
 * @typedef {{ token: string, from: number, to: number }} MiniToken
 */

/**
 * Find the current token at `offset` inside `text`.
 *
 * Tokens are separated by whitespace and mini-notation operators like
 * `[`, `]`, `<`, `>`, `{`, `}`, `,`, `|`, `!`, `@`, `?`.
 *
 * Returns null if the cursor is at a separator or the string is empty.
 *
 * @param {string} text - The mini-notation string content (inside quotes).
 * @param {number} offset - Cursor position within `text` (0-based).
 * @returns {MiniToken | null}
 */
export function tokenAtOffset(text, offset) {
  if (!text || offset < 0 || offset > text.length) return null;

  // Separators: whitespace + mini-notation structural chars
  const SEP = /[\s[\]<>{},|!@?*/:~]/;

  // Walk backwards from offset to find token start
  let from = offset;
  while (from > 0 && !SEP.test(text[from - 1])) from--;

  // Walk forward from offset to find token end
  let to = offset;
  while (to < text.length && !SEP.test(text[to])) to++;

  // If from === to, cursor is at a separator — no token
  if (from === to) return null;

  return {
    token: text.slice(from, to),
    from,
    to,
  };
}

/**
 * Determine the "context" of a mini-notation string based on the
 * enclosing function call name.
 *
 * @param {string} fnName - e.g. 's', 'sound', 'note', 'n'
 * @returns {'sound' | 'note' | 'other'}
 */
export function miniContext(fnName) {
  const lower = fnName?.toLowerCase();
  if (lower === "s" || lower === "sound") return "sound";
  if (lower === "note" || lower === "n") return "note";
  return "other";
}
