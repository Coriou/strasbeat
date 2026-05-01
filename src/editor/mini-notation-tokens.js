/**
 * Mini-notation tokeniser helper.
 *
 * Given a mini-notation string and a cursor offset within it, identifies
 * the "current token" — the whitespace-delimited fragment the cursor is
 * in or at the end of. Doesn't parse the full mini-notation grammar;
 * just finds word boundaries so autocomplete knows what to replace.
 */

/**
 * @typedef {{ token: string, from: number, to: number, prevSeparator: ":" | null }} MiniToken
 */

/**
 * Find the current token at `offset` inside `text`.
 *
 * Tokens are separated by whitespace and mini-notation operators like
 * `[`, `]`, `<`, `>`, `{`, `}`, `,`, `|`, `!`, `@`, `?`.
 *
 * Returns null if the cursor is at a separator or the string is empty.
 *
 * Special case: when the cursor sits immediately after a `:` with no
 * following token character yet (e.g. cursor right after the colon in
 * `"bd:"`), returns an empty-fragment marker
 * `{ token: "", from, to, prevSeparator: ":" }` so the provider can
 * offer numeric variant completions.
 *
 * @param {string} text - The mini-notation string content (inside quotes).
 * @param {number} offset - Cursor position within `text` (0-based).
 * @returns {MiniToken | null}
 */
export function tokenAtOffset(text, offset) {
  if (text == null || offset < 0 || offset > text.length) return null;
  const SEP = /[\s[\]<>{},|!@?*/:~]/;

  // Special: empty fragment after a colon — surface for variant completion.
  // (cursor sits immediately after a `:` with no following token char yet.)
  if (offset > 0 && text[offset - 1] === ":") {
    const charAt = text[offset];
    if (charAt === undefined || SEP.test(charAt)) {
      return { token: "", from: offset, to: offset, prevSeparator: ":" };
    }
  }

  let from = offset;
  while (from > 0 && !SEP.test(text[from - 1])) from--;

  let to = offset;
  while (to < text.length && !SEP.test(text[to])) to++;

  if (from === to) return null;

  const prevSeparator = from > 0 && text[from - 1] === ":" ? ":" : null;
  return { token: text.slice(from, to), from, to, prevSeparator };
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
