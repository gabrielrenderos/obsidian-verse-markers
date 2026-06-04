// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2025 Gabriel Renderos

/**
 * postprocessor.ts
 * Reading view MarkdownPostProcessor for verse markers.
 */

import { MarkdownPostProcessorContext } from "obsidian";
import {
  execVerseMarker,
  getVerseRegex,
  hasVerseMarker,
  parseMarkerToken,
  continuationPartAnchor,
  VERSE_FRAGMENT_TEST_STRICT,
  VERSE_FRAGMENT_TEST_LOOSE,
} from "./detection";

/** Tags whose descendants must be skipped entirely. */
const SKIP_TAGS = new Set([
  "A", "CODE", "PRE", "MATH", "MJX-CONTAINER",
  "TABLE", "IMG",
]);

/** CSS classes that indicate skippable containers. */
const SKIP_CLASSES = [".math", ".internal-embed", ".external-embed"];

/**
 * Returns true if the given node has an ancestor that should be skipped.
 */
function isInsideSkipped(node: Node): boolean {
  let current: Node | null = node.parentNode;
  while (current !== null) {
    if (current.nodeType === Node.ELEMENT_NODE) {
      const el = current as Element;
      if (SKIP_TAGS.has(el.tagName)) return true;
      for (const cls of SKIP_CLASSES) {
        if (el.matches(cls)) return true;
      }
    }
    current = current.parentNode;
  }
  return false;
}

/**
 * Processes a single Text node: replaces each verse marker "[N]"/"[Na]" token
 * with a single span containing just its label N (or "Na", brackets dropped).
 * The span carries id="verse-N" (or "verse-Na") for anchor navigation.
 * Returns true if any replacements were made.
 */
function processTextNode(textNode: Text): boolean {
  const text = textNode.nodeValue ?? "";
  const re = getVerseRegex();
  const matches: RegExpExecArray[] = [];
  let match: RegExpExecArray | null;

  while ((match = execVerseMarker(re, text)) !== null) {
    matches.push(match);
  }

  if (matches.length === 0) return false;

  const parent = textNode.parentNode;
  if (!parent) return false;

  const fragment = activeDocument.createDocumentFragment();
  let lastIndex = 0;

  for (const m of matches) {
    const start = m.index;
    const token = m[0];
    const end = start + token.length;

    if (start > lastIndex) {
      fragment.appendChild(activeDocument.createTextNode(text.slice(lastIndex, start)));
    }

    // Strip the brackets: render only the label (number + any authored part
    // letters), carrying the matching verse id.
    const { number, part } = parseMarkerToken(token);
    const label = `${number}${part ?? ""}`;
    const markerEl = activeDocument.createElement("span");
    markerEl.className = "verse-marker";
    markerEl.id = `verse-${label}`;
    markerEl.textContent = label;

    fragment.appendChild(markerEl);
    lastIndex = end;
  }

  if (lastIndex < text.length) {
    fragment.appendChild(activeDocument.createTextNode(text.slice(lastIndex)));
  }

  parent.replaceChild(fragment, textNode);
  return true;
}

/**
 * Collects all Text nodes within el that are not inside a skipped ancestor.
 * Collect into an array first to avoid live NodeList mutation issues.
 */
function collectTextNodes(el: HTMLElement): Text[] {
  const result: Text[] = [];
  const walker = activeDocument.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  let node: Node | null;
  while ((node = walker.nextNode()) !== null) {
    const textNode = node as Text;
    if (!isInsideSkipped(textNode)) {
      result.push(textNode);
    }
  }
  return result;
}

/**
 * Collects all <a> elements within el that reference a verse fragment.
 * Always recognizes the explicit `verse-N` / `verse-N:M` form. When
 * `allowShorthand` is true, also recognizes the shorthand `N` / `N:M`.
 * See detection.ts for the full syntax contract.
 *
 * Uses el.getElementsByTagName which is scoped to the fragment — not a
 * full-document scan.
 */
export function collectVerseAnchors(
  el: HTMLElement,
  allowShorthand: boolean = false
): HTMLAnchorElement[] {
  const test = allowShorthand ? VERSE_FRAGMENT_TEST_LOOSE : VERSE_FRAGMENT_TEST_STRICT;
  const result: HTMLAnchorElement[] = [];
  const anchors = el.getElementsByTagName("a");
  for (let i = 0; i < anchors.length; i++) {
    const a = anchors[i];
    const href = a.getAttribute("data-href") ?? a.getAttribute("href") ?? "";
    const hashIdx = href.indexOf("#");
    if (hashIdx === -1) continue;
    const fragment = href.slice(hashIdx + 1);
    if (test.test(fragment)) {
      result.push(a);
    }
  }
  return result;
}

/**
 * Determines whether `el`'s block is a continuation of a verse that was
 * split above it. If so, returns the anchor id to inject at the block's
 * start (e.g. "verse-4b").
 *
 * Returns null when no injection is warranted — e.g. the block already
 * contains its own verse marker (part "a" gets its id from that marker
 * span). The part-letter computation itself (heading + interior-footnote
 * boundaries) lives in detection.ts so it stays the single source of truth.
 */
function partAnchorForBlock(
  el: HTMLElement,
  ctx: MarkdownPostProcessorContext
): string | null {
  const info = ctx.getSectionInfo(el);
  if (!info) return null;

  // If the block itself contains a verse marker, its own marker carries the
  // "verse-N" id — no extra injection needed for part a.
  const sourceLines = info.text.split("\n");
  const blockText = sourceLines.slice(info.lineStart, info.lineEnd + 1).join("\n");
  if (hasVerseMarker(blockText)) return null;

  return continuationPartAnchor(info.text, info.lineStart);
}

/**
 * Injects an invisible anchor span at the very start of `el` so that
 * `id="verse-Nb"` (or c, d, …) scroll targets exist in the DOM.
 * Idempotent: skips injection if the id is already present inside el.
 */
function injectPartAnchor(el: HTMLElement, id: string): void {
  if (el.querySelector(`#${CSS.escape(id)}`)) return;
  const anchor = activeDocument.createElement("span");
  anchor.id = id;
  anchor.className = "verse-part-anchor";
  anchor.setAttribute("aria-hidden", "true");
  el.insertBefore(anchor, el.firstChild);
}

/**
 * The MarkdownPostProcessor to register with Obsidian.
 * Idempotent: a text node that has already been split into spans will
 * contain no raw [N] tokens, so a second pass is a no-op.
 *
 * If `ctx` is provided and the block is a continuation of a heading-split
 * verse, a `verse-Nb`/`verse-Nc`/… anchor is injected at the block's start.
 */
export function versePostProcessor(
  el: HTMLElement,
  ctx?: MarkdownPostProcessorContext
): void {
  const textNodes = collectTextNodes(el);
  for (const tn of textNodes) {
    processTextNode(tn);
  }

  if (ctx) {
    const partId = partAnchorForBlock(el, ctx);
    if (partId) injectPartAnchor(el, partId);
  }
}
