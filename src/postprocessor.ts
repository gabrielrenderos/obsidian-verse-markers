// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2025 Gabriel Renderos

/**
 * postprocessor.ts
 * Reading view MarkdownPostProcessor for verse markers.
 */

import { MarkdownPostProcessorContext } from "obsidian";
import {
  execVerseMarker,
  findVerseBreakIndex,
  getVerseRegex,
  hasVerseMarker,
  isVerseBreakLine,
  parseMarkerToken,
  continuationPartAnchor,
  VERSE_BREAK_TOKEN,
  VERSE_FRAGMENT_TEST_STRICT,
  VERSE_FRAGMENT_TEST_LOOSE,
} from "./detection";

/** Tags whose descendants must be skipped entirely. */
const SKIP_TAGS = new Set([
  "A", "CODE", "PRE", "MATH", "MJX-CONTAINER",
  "TABLE", "IMG",
]);

/** CSS classes that always indicate skippable containers. */
const SKIP_CLASSES = [".math"];

/**
 * Embed containers. The page-level post-processor skips these (Obsidian renders
 * embeds through their own pass), but our own verse embeds DO want their markers
 * styled — see `styleVerseMarkers`.
 */
const EMBED_SKIP_CLASSES = [".internal-embed", ".external-embed"];

/**
 * Returns true if the given node has an ancestor that should be skipped.
 * When `skipEmbeds` is false, content inside an embed container is NOT skipped
 * (used when we render verse content inside our own embed card).
 */
function isInsideSkipped(node: Node, skipEmbeds = true): boolean {
  let current: Node | null = node.parentNode;
  while (current !== null) {
    if (current.nodeType === Node.ELEMENT_NODE) {
      const el = current as Element;
      if (SKIP_TAGS.has(el.tagName)) return true;
      for (const cls of SKIP_CLASSES) {
        if (el.matches(cls)) return true;
      }
      if (skipEmbeds) {
        for (const cls of EMBED_SKIP_CLASSES) {
          if (el.matches(cls)) return true;
        }
      }
    }
    current = current.parentNode;
  }
  return false;
}

/**
 * Appends a styled verse marker to `fragment` (brackets dropped — reading view).
 */
function appendVerseMarker(fragment: DocumentFragment, token: string): void {
  const { number, part } = parseMarkerToken(token);
  const label = `${number}${part ?? ""}`;
  const markerEl = activeDocument.createElement("span");
  markerEl.className = "verse-marker";
  markerEl.id = `verse-${label}`;
  markerEl.textContent = label;
  fragment.appendChild(markerEl);
}

type InlineToken =
  | { index: number; length: number; kind: "marker"; token: string }
  | { index: number; length: number; kind: "break" };

/** Next verse marker or `[//]` break in `text` at/after `from`. */
function nextInlineToken(text: string, from: number): InlineToken | null {
  const slice = text.slice(from);
  const brRel = findVerseBreakIndex(slice);
  const brIdx = brRel === -1 ? -1 : from + brRel;
  const m = execVerseMarker(getVerseRegex(), slice);
  const markerIdx = m ? from + m.index : -1;

  if (brIdx === -1 && markerIdx === -1) return null;
  if (markerIdx === -1 || (brIdx !== -1 && brIdx < markerIdx)) {
    return { index: brIdx, length: VERSE_BREAK_TOKEN.length, kind: "break" };
  }
  return { index: markerIdx, length: m![0].length, kind: "marker", token: m![0] };
}

/**
 * Processes a single Text node: styles verse markers and removes `[//]` break
 * tokens (reading view). Editorial text after an inline break stays visible.
 */
function processTextNode(textNode: Text): boolean {
  const text = textNode.nodeValue ?? "";
  if (nextInlineToken(text, 0) === null) return false;

  const parent = textNode.parentNode;
  if (!parent) return false;

  const fragment = activeDocument.createDocumentFragment();
  let lastIndex = 0;
  let pos = 0;

  while (pos < text.length) {
    const hit = nextInlineToken(text, pos);
    if (!hit) break;

    if (hit.index > lastIndex) {
      fragment.appendChild(
        activeDocument.createTextNode(text.slice(lastIndex, hit.index))
      );
    }

    if (hit.kind === "marker") {
      appendVerseMarker(fragment, hit.token);
    }
    // break: omit token from reading view (editorial text after it remains)

    lastIndex = hit.index + hit.length;
    pos = lastIndex;
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
function collectTextNodes(el: HTMLElement, skipEmbeds = true): Text[] {
  const result: Text[] = [];
  const walker = activeDocument.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  let node: Node | null;
  while ((node = walker.nextNode()) !== null) {
    const textNode = node as Text;
    if (!isInsideSkipped(textNode, skipEmbeds)) {
      result.push(textNode);
    }
  }
  return result;
}

/**
 * Styles verse markers within `el`, INCLUDING content inside an embed container.
 *
 * The page-level post-processor (`versePostProcessor`) deliberately skips
 * `.internal-embed`, because Obsidian renders normal embeds through their own
 * pass. Our verse embeds, however, render their content themselves and DO want
 * the `[N]` markers styled — so this variant doesn't skip embed containers.
 * Code/math and the hard tags are still skipped.
 */
export function styleVerseMarkers(el: HTMLElement): void {
  const textNodes = collectTextNodes(el, false);
  for (const tn of textNodes) {
    processTextNode(tn);
  }
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
 * Hides a block whose source is only a verse-break line (`[//]`).
 */
function hideVerseBreakBlock(
  el: HTMLElement,
  ctx: MarkdownPostProcessorContext
): void {
  const info = ctx.getSectionInfo(el);
  if (!info) return;
  const blockText = info.text
    .split("\n")
    .slice(info.lineStart, info.lineEnd + 1)
    .join("\n");
  if (!isVerseBreakLine(blockText)) return;
  el.addClass("verse-break");
  el.empty();
  el.setAttr("aria-hidden", "true");
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
    hideVerseBreakBlock(el, ctx);
    const partId = partAnchorForBlock(el, ctx);
    if (partId) injectPartAnchor(el, partId);
  }
}
