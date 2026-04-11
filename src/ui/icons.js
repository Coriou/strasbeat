// Lucide icon helpers — wraps `lucide`'s createElement so the rest of the
// shell code never has to know about Lucide's array-of-arrays icon shape.
//
// Tree-shaking note: each icon is imported by name from the `lucide`
// barrel (`import { Play } from 'lucide'`) so unused icons don't ship.
//
// See design/SYSTEM.md §10 for sizing conventions:
//   - top bar:        16px
//   - transport bar:  14px
//   - inline / gutter: 12px

import {
  createElement,
  Play,
  Square,
  Disc,
  Download,
  Share2,
  Settings,
  Plus,
  Search,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronsDownUp,
  Save,
  Music2,
  BookOpen,
  Terminal,
  Eraser,
  MoreHorizontal,
  Volume2,
  X,
  GraduationCap,
  Copy,
  Wrench,
  Waves,
} from "lucide";

const ICONS = {
  play: Play,
  square: Square,
  disc: Disc,
  download: Download,
  share: Share2,
  settings: Settings,
  plus: Plus,
  search: Search,
  "chevron-down": ChevronDown,
  "chevron-left": ChevronLeft,
  "chevrons-down-up": ChevronsDownUp,
  save: Save,
  music: Music2,
  "book-open": BookOpen,
  "graduation-cap": GraduationCap,
  "chevron-right": ChevronRight,
  copy: Copy,
  wrench: Wrench,
  waves: Waves,
  terminal: Terminal,
  eraser: Eraser,
  "more-horizontal": MoreHorizontal,
  "volume-2": Volume2,
  x: X,
};

/**
 * Build an SVGElement for a Lucide icon.
 *
 *   const svg = makeIcon('play', { size: 14 });
 *   button.appendChild(svg);
 *
 * @param {keyof typeof ICONS} name
 * @param {{ size?: number, className?: string, ariaLabel?: string }} [opts]
 * @returns {SVGElement}
 */
export function makeIcon(name, { size, className, ariaLabel } = {}) {
  const node = ICONS[name];
  if (!node) {
    // Surface silently-missing icons loudly — same defensive style we use
    // for missing Strudel sounds (see CLAUDE.md "Surface silent failures
    // loudly"). A wrong icon name is almost always a typo at the call site.
    console.warn(`[strasbeat/icons] unknown icon "${name}"`);
    return document.createElementNS("http://www.w3.org/2000/svg", "svg");
  }
  const attrs = {};
  if (size != null) {
    attrs.width = size;
    attrs.height = size;
  }
  if (className) attrs.class = className;
  const svg = createElement(node, attrs);
  if (ariaLabel) {
    svg.setAttribute("role", "img");
    svg.setAttribute("aria-label", ariaLabel);
  } else {
    svg.setAttribute("aria-hidden", "true");
  }
  return svg;
}

/**
 * Walk a root element and replace every `<span data-icon="name">` placeholder
 * with the corresponding Lucide SVG. Lets the HTML stay declarative — see
 * `index.html` for the placeholders this expands.
 */
export function hydrateIcons(root = document) {
  const placeholders = root.querySelectorAll("[data-icon]");
  for (const el of placeholders) {
    const name = el.getAttribute("data-icon");
    if (!name) continue;
    const svg = makeIcon(name);
    // Replace the inner content of the placeholder so its container styles
    // (sizing, color) still apply.
    el.replaceChildren(svg);
  }
}
