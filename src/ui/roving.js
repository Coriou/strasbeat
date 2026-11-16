// Index math for roving-focus widgets (pattern tabs, the patterns tree, the
// rail's context menu). Pure — no DOM — so the keyboard model can be tested
// with node --test. The widgets own the elements; these only answer "which
// index does this key move to".

/**
 * Linear roving focus. Returns the index `key` moves to, or -1 when `key`
 * is not a navigation key for this orientation (the caller lets it through).
 * @param {number} index  currently focused index (-1 when nothing is)
 * @param {number} count  number of items
 * @param {string} key    KeyboardEvent.key
 * @param {{ horizontal?: boolean, wrap?: boolean }} [opts]
 */
export function moveIndex(index, count, key, { horizontal = false, wrap = false } = {}) {
  if (count <= 0) return -1;
  const prevKey = horizontal ? "ArrowLeft" : "ArrowUp";
  const nextKey = horizontal ? "ArrowRight" : "ArrowDown";
  if (key === "Home") return 0;
  if (key === "End") return count - 1;
  if (key === nextKey) {
    if (index < 0) return 0;
    if (index >= count - 1) return wrap ? 0 : count - 1;
    return index + 1;
  }
  if (key === prevKey) {
    if (index < 0) return count - 1;
    if (index <= 0) return wrap ? count - 1 : 0;
    return index - 1;
  }
  return -1;
}

/**
 * Keyboard model of a two-level tree, over its *visible* nodes in document
 * order. Each node is `{ level, expanded }` where `expanded` is true/false
 * for a folder and null for a leaf.
 *
 * Returns one of
 *   { focus: i }   move focus to node i
 *   { toggle: i }  expand or collapse folder i (focus stays on it)
 *   { leave: "start" }  ArrowUp on the first node — hand focus back to
 *                       whatever sits above the tree
 *   null           not a tree key, or nothing to do
 */
export function treeNavigate(nodes, index, key) {
  const count = nodes.length;
  if (count === 0 || index < 0 || index >= count) return null;
  const node = nodes[index];
  switch (key) {
    case "ArrowDown":
      return index < count - 1 ? { focus: index + 1 } : null;
    case "ArrowUp":
      return index > 0 ? { focus: index - 1 } : { leave: "start" };
    case "Home":
      return { focus: 0 };
    case "End":
      return { focus: count - 1 };
    case "ArrowRight":
      if (node.expanded === false) return { toggle: index };
      if (node.expanded === true) {
        const child = nodes[index + 1];
        return child && child.level > node.level ? { focus: index + 1 } : null;
      }
      return null;
    case "ArrowLeft":
      if (node.expanded === true) return { toggle: index };
      for (let i = index - 1; i >= 0; i--) {
        if (nodes[i].level < node.level) return { focus: i };
      }
      return null;
    default:
      return null;
  }
}

/**
 * Type-to-find. `labels` are the visible items' names, `from` the focused
 * index, `query` the characters typed so far. A single character (or the
 * same character repeated) cycles through the items starting with it; a
 * longer query stays on the current item while it still matches. Returns
 * the index to focus, or -1.
 */
export function typeaheadIndex(labels, from, query) {
  const count = labels.length;
  const q = String(query).toLowerCase();
  if (count === 0 || q === "") return -1;
  const repeated = q.length > 1 && [...q].every((c) => c === q[0]);
  const needle = repeated ? q[0] : q;
  const start = needle.length === 1 ? from + 1 : Math.max(from, 0);
  for (let step = 0; step < count; step++) {
    const i = (((start + step) % count) + count) % count;
    if (String(labels[i]).toLowerCase().startsWith(needle)) return i;
  }
  return -1;
}
