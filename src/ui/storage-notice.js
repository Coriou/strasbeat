// Persistent "your work is not being saved" notice.
//
// The transport status line is a single, last-writer-wins string: a save
// failure shown there is replaced by the next message and never seen at all
// when the failing write happens while the page is closing. A save problem is
// the one condition the user must not be able to miss, so it gets its own
// element that stays up until the condition is gone.
//
// Styled inline from design tokens (it has no stylesheet of its own yet).

/**
 * @param {HTMLElement | null} host  element the notice is prepended to
 * @returns {{ show(text: string, detail?: string): void, clear(): void }}
 */
export function mountStorageNotice(host) {
  const el = document.createElement("span");
  el.className = "storage-notice";
  el.setAttribute("role", "alert");
  el.hidden = true;
  Object.assign(el.style, {
    flex: "0 1 auto",
    minWidth: "0",
    marginRight: "var(--space-2)",
    padding: "2px var(--space-2)",
    border: "1px solid var(--rec)",
    borderRadius: "var(--radius-sm)",
    color: "var(--rec)",
    fontFamily: "var(--font-sans)",
    fontSize: "var(--text-xs)",
    fontWeight: "600",
    lineHeight: "var(--lh-sm)",
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
  });
  host?.prepend(el);

  return {
    show(text, detail) {
      el.textContent = `⚠ ${text}`;
      el.title = detail ?? text;
      el.hidden = false;
    },
    clear() {
      el.hidden = true;
      el.textContent = "";
      el.title = "";
    },
  };
}
