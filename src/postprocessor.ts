// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2025 Gabriel Renderos

/**
 * postprocessor.ts
 * Reading view MarkdownPostProcessor for verse markers.
 */

import { App, MarkdownPostProcessorContext, MarkdownView } from "obsidian";
import {
  charOffsetForLine,
  hasVerseMarker,
  isVerseBreakLine,
  isSectionFlowBreakLine,
  parseMarkerToken,
  continuationPartAnchor,
  applyProcessToken,
  nextProcessToken,
  verseRefToAnchorId,
  verseRefToDisplayLabel,
  flatVerseRef,
  shouldOmitLoneRomanMarker,
  VERSE_FRAGMENT_TEST_STRICT,
  VERSE_FRAGMENT_TEST_LOOSE,
  verseProcessStateAt,
  defaultVerseProcessState,
  type VerseProcessState,
  type ProcessToken,
} from "./detection";

type RomanDisplaySettings = Pick<
  import("./settings").VerseMarkersSettings,
  "showRomanParentInNestedVerses"
>;

let getRomanDisplaySettings: () => RomanDisplaySettings = () => ({
  showRomanParentInNestedVerses: true,
});

/** Supplies hierarchical marker display options to the reading-view processor. */
export function configureVerseMarkerDisplay(
  getter: () => RomanDisplaySettings
): void {
  getRomanDisplaySettings = getter;
}

export function getShowRomanParentInNestedVerses(): boolean {
  return getRomanDisplaySettings().showRomanParentInNestedVerses;
}

/** Re-run reading-view preview so marker labels pick up display setting changes. */
export function refreshReadingViewVerseMarkers(app: App): void {
  app.workspace.iterateAllLeaves((leaf) => {
    if (!(leaf.view instanceof MarkdownView)) return;
    const preview = leaf.view.previewMode;
    if (!preview?.containerEl?.isConnected) return;

    const scroll = preview.getScroll();
    const data = preview.get();
    // `rerender(false)` skips blocks that look unchanged; `set(…, true)` clears
    // and re-renders from source so post-processors run on fresh `[N]` tokens.
    preview.set(data, true);
    preview.applyScroll(scroll);
  });
}

interface MarkerRenderContext {
  showRomanParentInNested: boolean;
  sourceText?: string;
  /** Absolute offset in `sourceText` at the start of the current text node. */
  sourceOffset?: number;
}

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

function isEditorialText(state: VerseProcessState): boolean {
  return (
    state.structuredFlowActive &&
    (state.inVerseSpan || state.inSectionSpan) &&
    !state.inVerseMode
  );
}

/**
 * Appends plain text, wrapping editorial gaps in `.verse-editorial` so the
 * navigation flash can skip them without re-parsing source offsets.
 */
function appendVerseText(
  fragment: DocumentFragment,
  text: string,
  state: VerseProcessState
): void {
  if (text.length === 0) return;
  if (isEditorialText(state)) {
    fragment.appendChild(createSpan({ cls: "verse-editorial", text }));
    return;
  }
  fragment.appendChild(activeDocument.createTextNode(text));
}

/**
 * Appends a styled verse marker to `fragment` (brackets dropped — reading view).
 */
function appendVerseMarker(
  fragment: DocumentFragment,
  state: VerseProcessState,
  token: string,
  renderCtx: MarkerRenderContext,
  markerIndex?: number
): void {
  if (token.startsWith("[") && /^[IVXLCDM]+$/.test(token.slice(1, -1))) {
    const section = token.slice(1, -1);
    if (
      renderCtx.showRomanParentInNested &&
      renderCtx.sourceText !== undefined &&
      markerIndex !== undefined
    ) {
      const afterRoman =
        (renderCtx.sourceOffset ?? 0) + markerIndex + token.length;
      if (
        shouldOmitLoneRomanMarker(
          renderCtx.sourceText,
          afterRoman,
          section
        )
      ) {
        return;
      }
    }
    const ref = { section, number: null, part: null };
    fragment.appendChild(
      createSpan({
        cls: "verse-marker",
        text: section,
        attr: { id: verseRefToAnchorId(ref) },
      })
    );
    return;
  }

  const { number, part } = parseMarkerToken(token);
  let ref = flatVerseRef(number, part);
  if (
    state.sawSection &&
    state.currentSection !== null &&
    state.structuredFlowActive &&
    state.scopedChildrenActive
  ) {
    ref = { section: state.currentSection, number, part };
  }
  fragment.appendChild(
    createSpan({
      cls: "verse-marker",
      text: verseRefToDisplayLabel(ref, renderCtx.showRomanParentInNested),
      attr: { id: verseRefToAnchorId(ref) },
    })
  );
}

type InlineToken = ProcessToken;

/** Next verse/section marker, `[//]`, or `[///]` in `text` at/after `from`. */
function nextInlineToken(text: string, from: number): InlineToken | null {
  return nextProcessToken(text, from);
}

/**
 * Processes a single Text node: styles verse markers, removes `[//]` break
 * tokens (reading view), and wraps editorial gaps in `.verse-editorial`.
 * `state` carries the verse/editorial toggle across nodes in document order.
 */
function processTextNode(
  textNode: Text,
  state: VerseProcessState,
  renderCtx: MarkerRenderContext
): boolean {
  if (textNode.parentElement?.closest(".verse-editorial, .verse-marker")) {
    return false;
  }
  const text = textNode.nodeValue ?? "";
  const hasToken = nextInlineToken(text, 0) !== null;
  if (!hasToken && !isEditorialText(state)) return false;

  const parent = textNode.parentNode;
  if (!parent) return false;

  if (!hasToken) {
    parent.replaceChild(
      createSpan({ cls: "verse-editorial", text }),
      textNode
    );
    return true;
  }

  const fragment = createFragment();
  let lastIndex = 0;
  let pos = 0;

  while (pos < text.length) {
    const hit = nextInlineToken(text, pos);
    if (!hit) break;

    if (hit.index > lastIndex) {
      appendVerseText(fragment, text.slice(lastIndex, hit.index), state);
    }

    if (hit.kind === "marker") {
      const token =
        hit.raw.kind === "roman"
          ? `[${hit.raw.roman}]`
          : hit.raw.token;
      appendVerseMarker(fragment, state, token, renderCtx, hit.index);
    }
    applyProcessToken(state, hit);

    lastIndex = hit.index + hit.length;
    pos = lastIndex;
  }

  if (lastIndex < text.length) {
    appendVerseText(fragment, text.slice(lastIndex), state);
  }

  parent.replaceChild(fragment, textNode);
  return true;
}

/**
 * True when `blockText` is editorial continuation after a `[//]` (no markers
 * of its own) and `state` says we are inside an editorial gap.
 */
function isEditorialContinuationBlock(
  blockText: string,
  state: VerseProcessState
): boolean {
  return (
    isEditorialText(state) &&
    !hasVerseMarker(blockText) &&
    !isVerseBreakLine(blockText) &&
    !isSectionFlowBreakLine(blockText)
  );
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
export interface StyleVerseMarkersOptions {
  /** Full note source — bootstraps Roman section scope for excerpt styling. */
  fullText?: string;
  /** Character offset in `fullText` where the excerpt begins. */
  sourceStart?: number;
  /** When set, overrides the plugin setting for Roman parent display. */
  showRomanParentInNested?: boolean;
}

export function styleVerseMarkers(
  el: HTMLElement,
  options?: StyleVerseMarkersOptions
): void {
  const textNodes = collectTextNodes(el, false);
  const state: VerseProcessState =
    options?.fullText !== undefined && options.sourceStart !== undefined
      ? verseProcessStateAt(options.fullText, options.sourceStart)
      : defaultVerseProcessState();
  const renderCtx: MarkerRenderContext = {
    showRomanParentInNested:
      options?.showRomanParentInNested ??
      getShowRomanParentInNestedVerses(),
    sourceText: options?.fullText,
    sourceOffset: options?.sourceStart,
  };
  let cursor = options?.sourceStart ?? 0;
  for (const tn of textNodes) {
    const len = tn.nodeValue?.length ?? 0;
    renderCtx.sourceOffset = cursor;
    processTextNode(tn, state, renderCtx);
    cursor += len;
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
  el.insertBefore(
    createSpan({
      cls: "verse-part-anchor",
      attr: { id, "aria-hidden": "true" },
    }),
    el.firstChild
  );
}

/**
 * Hides a block whose source is only a verse-break (`[//]`) or flow-break
 * (`[///]`) line.
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
  if (!isVerseBreakLine(blockText) && !isSectionFlowBreakLine(blockText)) return;
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
  // Popover/embed cards style markers themselves with full-file section context.
  if (el.closest(".verse-hover-preview, .verse-embed-preview")) {
    return;
  }

  let state: VerseProcessState = defaultVerseProcessState();
  let blockText = "";
  let sectionInfo: ReturnType<MarkdownPostProcessorContext["getSectionInfo"]> =
    null;

  if (ctx) {
    sectionInfo = ctx.getSectionInfo(el);
    if (sectionInfo) {
      const lines = sectionInfo.text.split("\n");
      blockText = lines.slice(sectionInfo.lineStart, sectionInfo.lineEnd + 1).join("\n");
      state = verseProcessStateAt(
        sectionInfo.text,
        charOffsetForLine(sectionInfo.text, sectionInfo.lineStart)
      );
    }
  }

  if (isEditorialContinuationBlock(blockText, state)) {
    el.addClass("verse-editorial");
    if (ctx) hideVerseBreakBlock(el, ctx);
    const partId = ctx ? partAnchorForBlock(el, ctx) : null;
    if (partId) injectPartAnchor(el, partId);
    return;
  }

  const renderCtx: MarkerRenderContext = {
    showRomanParentInNested: getShowRomanParentInNestedVerses(),
    sourceText: sectionInfo?.text,
    sourceOffset: sectionInfo
      ? charOffsetForLine(sectionInfo.text, sectionInfo.lineStart)
      : undefined,
  };
  let sourceCursor = renderCtx.sourceOffset ?? 0;

  const textNodes = collectTextNodes(el);
  for (const tn of textNodes) {
    const len = tn.nodeValue?.length ?? 0;
    renderCtx.sourceOffset = sourceCursor;
    processTextNode(tn, state, renderCtx);
    sourceCursor += len;
  }

  if (ctx) {
    hideVerseBreakBlock(el, ctx);
    const partId = partAnchorForBlock(el, ctx);
    if (partId) injectPartAnchor(el, partId);
  }
}
