/**
 * references.ts
 * Hover preview and link resolution for verse references.
 *
 * Hover preview handles BOTH single-verse and range fragments:
 *   verse-3    → "[3] In the beginning…"
 *   verse-3a   → "[3a] <content of part a>"
 *   verse-3:7  → "[3] … [4] … [5] …"  (up to maxVerses)
 *
 * Content is rendered through Obsidian's own MarkdownRenderer so the popover
 * matches the reading-view look (bold, italics, internal links, etc.).
 *
 * We also suppress Obsidian's native page-preview popover on these anchors,
 * because the core preview searches for a heading literally named "verse-3"
 * and shows an "Unable to find" error when it fails.
 */

import { App, Component, MarkdownRenderer, TFile, setIcon } from "obsidian";
import {
  getVerseContent,
  getVerseParts,
  getVerseRangeRawText,
  parseVerseRange,
  parseVerseSingle,
} from "./detection";
import type VerseMarkersPlugin from "./main";

/** Converts a single lowercase letter "a".."z" to a zero-based index. */
function partToIndex(part: string): number {
  return part.charCodeAt(0) - "a".charCodeAt(0);
}

/**
 * Builds the markdown source for a verse range preview.
 *
 * `startPart` and `endPart` (if given) trim the endpoints to a specific
 * heading-split sub-part:
 *   startPart "b" → the start verse begins at part b (earlier parts hidden).
 *   endPart   "c" → the end verse ends at part c   (later parts hidden).
 *
 * Returns null if the file cannot be read or no verses are found.
 */
export async function buildRangePreviewMarkdown(
  app: App,
  file: TFile,
  start: number,
  end: number,
  maxVerses: number,
  startPart: string | null = null,
  endPart: string | null = null
): Promise<string | null> {
  const content = await app.vault.cachedRead(file);
  const limit = Math.min(end, start + maxVerses - 1);

  // Fast path: no part trimming. Return the raw source span so the popover
  // mirrors the document layout (inline verse markers, paragraphs, headings,
  // blockquotes). The MarkdownRenderer + our own post-processor handle the
  // rest, giving the preview the same look as the reading view.
  if (startPart === null && endPart === null) {
    const raw = getVerseRangeRawText(content, start, limit);
    return raw && raw.length > 0 ? raw : null;
  }

  // Trimmed path: one or both endpoints reference a specific part, so we
  // can't just slice the raw source — rebuild verse by verse instead.
  const blocks: string[] = [];
  for (let n = start; n <= limit; n++) {
    const trimStart = n === start && startPart !== null;
    const trimEnd = n === limit && n === end && endPart !== null;

    let verseText: string | null;
    let label = `${n}`;

    if (trimStart || trimEnd) {
      const parts = getVerseParts(content, n);
      if (!parts) continue;
      const sliceStart = trimStart ? partToIndex(startPart as string) : 0;
      const sliceEnd = trimEnd ? partToIndex(endPart as string) + 1 : parts.length;
      if (sliceStart < 0 || sliceStart >= parts.length) continue;
      if (sliceEnd <= sliceStart) continue;
      const sliced = parts.slice(sliceStart, sliceEnd).filter((p) => p.length > 0);
      if (sliced.length === 0) continue;
      verseText = sliced.join(" ");
      if (trimStart) label = `${n}${startPart}`;
    } else {
      verseText = getVerseContent(content, n);
      if (verseText === null) continue;
    }

    blocks.push(`[${label}] ${verseText}`);
  }

  if (blocks.length === 0) return null;
  return blocks.join("\n\n");
}

/**
 * Builds the markdown source for a single-verse preview.
 * `part` is an optional lowercase letter ("a", "b", …) selecting a
 * heading-split sub-part. Returns null if the verse or part is missing.
 */
export async function buildSinglePreviewMarkdown(
  app: App,
  file: TFile,
  verse: number,
  part: string | null
): Promise<string | null> {
  const content = await app.vault.cachedRead(file);
  const verseText = getVerseContent(content, verse, part);
  if (verseText === null || verseText.length === 0) return null;
  const label = part ? `${verse}${part}` : `${verse}`;
  return `[${label}] ${verseText}`;
}

/**
 * Delay before hiding the popover after the mouse leaves the anchor or the
 * popover itself. This gap lets the user transition the cursor across the
 * gap between anchor and popover without the popover disappearing, and
 * makes the scrollable popover content actually reachable.
 */
const HIDE_DELAY_MS = 200;

/** Vertical gap between the link and the popover. */
const POPOVER_GAP_PX = 4;
/** Margin to keep clear of the viewport edge when clipping. */
const VIEWPORT_MARGIN_PX = 8;

/**
 * Positions a popover under (or above, if there's no room below) its anchor
 * element, left-aligned with the link's start. Mirrors the placement
 * Obsidian's native page-preview uses: the popover's location is determined
 * by where the link is, NOT by where the cursor entered it.
 *
 * Reads the popover's current bounding rect, so it should be called both
 * before append (for an initial placement based on min size) and again
 * after the content renders (so post-render size can flip/shift it).
 */
function positionPopover(popover: HTMLElement, anchor: HTMLElement): void {
  const linkRect = anchor.getBoundingClientRect();
  const popRect = popover.getBoundingClientRect();
  const vw = window.innerWidth;
  const vh = window.innerHeight;

  let left = linkRect.left + window.scrollX;
  let top = linkRect.bottom + window.scrollY + POPOVER_GAP_PX;

  // Right edge: shift left so the popover stays inside the viewport.
  const popWidth = popRect.width || 0;
  if (popWidth > 0 && left + popWidth > window.scrollX + vw - VIEWPORT_MARGIN_PX) {
    left = window.scrollX + vw - popWidth - VIEWPORT_MARGIN_PX;
    if (left < window.scrollX + VIEWPORT_MARGIN_PX) {
      left = window.scrollX + VIEWPORT_MARGIN_PX;
    }
  }

  // Bottom edge: if the popover would spill below the viewport, place it
  // above the link instead — but only if there's actually more room there.
  const popHeight = popRect.height || 0;
  if (popHeight > 0 && top + popHeight > window.scrollY + vh - VIEWPORT_MARGIN_PX) {
    const aboveTop = linkRect.top + window.scrollY - popHeight - POPOVER_GAP_PX;
    const spaceBelow = vh - linkRect.bottom;
    const spaceAbove = linkRect.top;
    if (spaceAbove > spaceBelow && aboveTop >= window.scrollY + VIEWPORT_MARGIN_PX) {
      top = aboveTop;
    }
  }

  popover.style.left = `${left}px`;
  popover.style.top = `${top}px`;
}

/**
 * Attaches a mouse-hover preview to a verse-reference anchor. Handles both
 * single-verse fragments (verse-3, verse-3a) and ranges (verse-3:7, with or
 * without part suffixes on either endpoint).
 *
 * Behavior modeled on Obsidian's native page-preview:
 *   - max-sized, scrollable popover (CSS)
 *   - short delay before hiding, so the cursor can cross into the popover
 *     to scroll its contents
 *   - "Open note" icon button in the top-right that navigates to the verse
 *
 * Also suppresses Obsidian's native page-preview on this anchor so the core
 * "Unable to find 'verse-N'" popover doesn't appear. Returns a disposer.
 */
export function attachVerseHoverPreview(
  plugin: VerseMarkersPlugin,
  anchorEl: HTMLElement,
  linkText: string
): () => void {
  let popoverEl: HTMLElement | null = null;
  let popoverComponent: Component | null = null;
  let hideTimer: number | null = null;
  // Monotonic counter so we can cancel a stale async show() when the user
  // moves off the anchor before the markdown finishes rendering.
  let showToken = 0;

  const cancelHide = (): void => {
    if (hideTimer !== null) {
      window.clearTimeout(hideTimer);
      hideTimer = null;
    }
  };

  const hide = (): void => {
    cancelHide();
    showToken++; // invalidate any in-flight show()
    if (popoverComponent) {
      popoverComponent.unload();
      popoverComponent = null;
    }
    if (popoverEl && popoverEl.parentNode) {
      popoverEl.parentNode.removeChild(popoverEl);
    }
    popoverEl = null;
  };

  const scheduleHide = (): void => {
    cancelHide();
    hideTimer = window.setTimeout(hide, HIDE_DELAY_MS);
  };

  const show = async (ev: MouseEvent): Promise<void> => {
    cancelHide();
    if (!plugin.settings.enableHoverPreviews) return;
    // Already visible — don't rebuild.
    if (popoverEl) return;

    const hashIndex = linkText.indexOf("#");
    if (hashIndex === -1) return;

    const filePart = linkText.slice(0, hashIndex);
    const fragment = linkText.slice(hashIndex + 1);
    const allowShorthand = plugin.settings.enableShorthandSyntax;

    const file = plugin.app.metadataCache.getFirstLinkpathDest(filePart, "");
    if (!(file instanceof TFile)) return;

    const myToken = ++showToken;

    // Try range first (more specific), then single.
    let markdown: string | null = null;
    const range = parseVerseRange(fragment, allowShorthand);
    if (range) {
      markdown = await buildRangePreviewMarkdown(
        plugin.app,
        file,
        range.start,
        range.end,
        plugin.settings.hoverPreviewMaxVerses,
        range.startPart,
        range.endPart
      );
    } else {
      const single = parseVerseSingle(fragment, allowShorthand);
      if (single) {
        markdown = await buildSinglePreviewMarkdown(
          plugin.app,
          file,
          single.verse,
          single.part
        );
      }
    }

    // User moved off before we finished building content.
    if (myToken !== showToken) return;
    if (!markdown) return;

    // Build the popover using Obsidian's own class hierarchy so themes
    // style it identically to the native page-preview popover:
    //
    //   .popover.hover-popover        outer frame (position, border, shadow, size)
    //     .markdown-embed.is-loaded   inner embed card
    //       .markdown-embed-content   scrollable body
    //         .markdown-preview-view.markdown-rendered
    //           ... our markdown content ...
    //       .markdown-embed-link      the corner "open" arrow
    //
    // Position is anchored to the link element's bounding rect (NOT the
    // cursor) so it lands in the same place regardless of where the
    // pointer entered, matching Obsidian's native popover behavior.
    const el = document.createElement("div");
    el.className = "popover hover-popover verse-hover-preview";
    el.style.position = "absolute";

    el.addEventListener("mouseenter", cancelHide);
    el.addEventListener("mouseleave", scheduleHide);

    const embed = document.createElement("div");
    embed.className = "markdown-embed is-loaded";
    el.appendChild(embed);

    const contentEl = document.createElement("div");
    contentEl.className = "markdown-embed-content";
    embed.appendChild(contentEl);

    const previewEl = document.createElement("div");
    previewEl.className = "markdown-preview-view markdown-rendered";
    contentEl.appendChild(previewEl);

    // Corner "open note" affordance — same class the native hover popover
    // uses, so themes style the chrome (position, hover background) for
    // free. The icon is the diagonal-arrows glyph that matches Obsidian's
    // current native popover.
    const openLink = document.createElement("a");
    openLink.className = "markdown-embed-link";
    openLink.setAttribute("aria-label", "Open link");
    setIcon(openLink, "lucide-move-diagonal-2");
    openLink.addEventListener("click", async (clickEv) => {
      clickEv.preventDefault();
      clickEv.stopPropagation();
      hide();
      await resolveVerseLink(plugin.app, file, fragment, allowShorthand);
    });
    embed.appendChild(openLink);

    // Initial placement: under the link, left-aligned with the link's
    // start. Final placement runs again after render once we know the
    // popover's actual size (so we can flip above / clip to viewport).
    positionPopover(el, anchorEl);
    document.body.appendChild(el);

    const component = new Component();
    component.load();
    await MarkdownRenderer.renderMarkdown(markdown, previewEl, file.path, component);

    // Re-position now that the rendered content has determined the size.
    positionPopover(el, anchorEl);

    // Yet another cancellation window — render might be slow.
    if (myToken !== showToken) {
      component.unload();
      if (el.parentNode) el.parentNode.removeChild(el);
      return;
    }

    popoverEl = el;
    popoverComponent = component;
  };

  // Stop the native page-preview from seeing the mouseover. Obsidian's core
  // preview registers a document-level handler; calling stopPropagation on
  // the target element prevents the event from bubbling up to it.
  const suppressNative = (ev: MouseEvent): void => {
    ev.stopPropagation();
  };

  // Click-hide: when the user follows the link, Obsidian re-renders the
  // view and the anchor is removed before mouseleave can fire — the popover
  // would otherwise stay orphaned in document.body forever.
  const onClickHide = (): void => hide();

  anchorEl.addEventListener("mouseover", suppressNative);
  anchorEl.addEventListener("mouseenter", show);
  anchorEl.addEventListener("mouseleave", scheduleHide);
  anchorEl.addEventListener("click", onClickHide);

  return () => {
    anchorEl.removeEventListener("mouseover", suppressNative);
    anchorEl.removeEventListener("mouseenter", show);
    anchorEl.removeEventListener("mouseleave", scheduleHide);
    anchorEl.removeEventListener("click", onClickHide);
    hide();
  };
}

/** @deprecated use attachVerseHoverPreview. Kept temporarily for back-compat. */
export const attachRangeHoverPreview = attachVerseHoverPreview;

/**
 * Resolves a verse fragment navigation click: opens the file and scrolls
 * to the verse anchor. Returns true if handled.
 *
 * `allowShorthand` must mirror the plugin's `enableShorthandSyntax` setting
 * so we only accept shorthand fragments when the user has opted in.
 *
 * Scroll target resolution:
 *   - "verse-N"   → id="verse-N"
 *   - "verse-Na"  → id="verse-Na" if present, else id="verse-N"
 *   - "verse-N:M" → id="verse-N"
 */
export async function resolveVerseLink(
  app: App,
  file: TFile,
  fragment: string,
  allowShorthand: boolean = false
): Promise<boolean> {
  const single = parseVerseSingle(fragment, allowShorthand);
  const range = parseVerseRange(fragment, allowShorthand);

  let startVerse: number | null = null;
  let startPart: string | null = null;
  let endVerse: number | null = null;
  let endPart: string | null = null;

  if (single !== null) {
    startVerse = single.verse;
    startPart = single.part;
    endVerse = single.verse;
    endPart = single.part;
  } else if (range !== null) {
    // For a range, jump to the start endpoint. If it has a part suffix
    // ("verse-4b:25"), scroll to that part anchor with fallback to verse-N.
    startVerse = range.start;
    startPart = range.startPart;
    endVerse = range.end;
    endPart = range.endPart;
  }

  if (startVerse === null || endVerse === null) return false;

  const leaf = app.workspace.getMostRecentLeaf();
  if (!leaf) return false;

  await leaf.openFile(file);

  // Short delay so the reading-view render has a chance to populate anchors.
  setTimeout(() => {
    const primaryId = startPart
      ? `verse-${startVerse}${startPart}`
      : `verse-${startVerse}`;
    const fallbackId = `verse-${startVerse}`;
    const anchor =
      document.getElementById(primaryId) ?? document.getElementById(fallbackId);
    if (anchor) {
      anchor.scrollIntoView({ behavior: "smooth", block: "center" });
    }
    flashVerseRange(
      startVerse as number,
      startPart,
      endVerse as number,
      endPart
    );
  }, 150);

  return true;
}

/**
 * Flash lifecycle constants. Tuned to feel close to Obsidian's native
 * link-jump highlight: a quick fade in, a comfortable hold, then a fade
 * out before the wrapping spans are removed from the DOM.
 */
const FLASH_FADE_MS = 220;
const FLASH_HOLD_MS = 2000;

/** Tracks the currently-wrapped spans so overlapping flashes can clean up. */
let activeFlashSpans: HTMLSpanElement[] = [];
let flashTimer: number | null = null;

/**
 * Briefly highlights only the *text* of the verses inside the navigated
 * span — not their containing blocks. We wrap the text nodes that fall
 * inside each in-range verse's DOM Range with `<span class="verse-flash">`
 * elements, then toggle `.verse-flash-active` to drive a CSS background
 * transition. The rounded-corner / padded look is therefore real CSS box
 * decoration (impossible with the CSS Custom Highlight API, which only
 * accepts color/background-color/text-decoration on `::highlight()`).
 *
 * Spans are unwrapped after the fade-out completes so the DOM ends up
 * exactly as it started.
 */
function flashVerseRange(
  startVerse: number,
  startPart: string | null,
  endVerse: number,
  endPart: string | null
): void {
  const ranges = buildVerseTextRanges(startVerse, startPart, endVerse, endPart);
  if (ranges.length === 0) return;

  // Tear down any in-flight previous flash before starting this one.
  if (flashTimer !== null) {
    window.clearTimeout(flashTimer);
    flashTimer = null;
  }
  unwrapFlashSpans();

  const spans: HTMLSpanElement[] = [];
  const spansByRange: HTMLSpanElement[][] = [];
  for (const range of ranges) {
    const rangeSpans = wrapRangeWithSpans(range, "verse-flash");
    spansByRange.push(rangeSpans);
    for (const span of rangeSpans) {
      spans.push(span);
    }
  }
  if (spans.length === 0) return;

  // Determine edge caps from verse-range boundaries (first/last verse in
  // selection), then apply them only to the true outer spans so interior
  // spans (including verse number/body seams) stay square and seamless.
  const nonEmptyRangeSpans = spansByRange.filter((group) => group.length > 0);
  const firstRangeSpans = nonEmptyRangeSpans[0];
  const lastRangeSpans = nonEmptyRangeSpans[nonEmptyRangeSpans.length - 1];
  if (firstRangeSpans?.length) firstRangeSpans[0].classList.add("verse-flash-start");
  if (lastRangeSpans?.length) {
    lastRangeSpans[lastRangeSpans.length - 1].classList.add("verse-flash-end");
  }

  activeFlashSpans = spans;

  // Add the active class on the next frame so the browser registers the
  // initial transparent state first — without the rAF, the transition is
  // skipped and the highlight pops in instantly.
  requestAnimationFrame(() => {
    for (const s of spans) s.classList.add("verse-flash-active");
  });

  flashTimer = window.setTimeout(() => {
    for (const s of spans) s.classList.remove("verse-flash-active");
    flashTimer = window.setTimeout(() => {
      // Guard: a newer flash may have already replaced our spans.
      if (activeFlashSpans === spans) unwrapFlashSpans();
      flashTimer = null;
    }, FLASH_FADE_MS);
  }, FLASH_HOLD_MS);
}

/**
 * Wraps every text node intersecting `range` in `<span class={className}>`.
 * Because our flash ranges always start/end at element boundaries
 * (setStartBefore / setEndBefore on verse anchors), no text node is split
 * mid-character — we just lift each whole text node into a wrapping span.
 *
 * Text nodes are collected first via TreeWalker, then wrapped, so the
 * walker isn't disturbed by the DOM mutation.
 */
function wrapRangeWithSpans(range: Range, className: string): HTMLSpanElement[] {
  const spans: HTMLSpanElement[] = [];
  const ancestor = range.commonAncestorContainer;
  const walkRoot =
    ancestor.nodeType === Node.TEXT_NODE ? ancestor.parentNode : ancestor;
  if (!walkRoot) return spans;

  const walker = document.createTreeWalker(walkRoot, NodeFilter.SHOW_TEXT);
  const candidates: Text[] = [];
  let cur: Node | null;
  while ((cur = walker.nextNode())) {
    const t = cur as Text;
    if (!t.nodeValue || t.nodeValue.length === 0) continue;
    // Never highlight heading text: headings can act as verse split markers,
    // but their own label text is section structure, not verse body.
    const owner = t.parentElement;
    if (owner && owner.closest("h1, h2, h3, h4, h5, h6")) continue;
    // Skip whitespace-only text nodes (typically structural newlines/indent
    // sitting between block elements — e.g. between <blockquote> and its
    // child <p>s). With padding applied, a wrapped whitespace node would
    // render as a small visible chip above/below adjacent content, which
    // is what made flashed blockquotes appear to briefly grow taller.
    if (!/\S/.test(t.nodeValue)) continue;
    if (range.intersectsNode(t)) candidates.push(t);
  }

  for (const node of candidates) {
    const parent = node.parentNode;
    if (!parent) continue;
    const span = document.createElement("span");
    span.className = className;
    parent.insertBefore(span, node);
    span.appendChild(node);
    spans.push(span);
  }
  return spans;
}

/** Removes every active flash span, restoring the original DOM structure. */
function unwrapFlashSpans(): void {
  for (const span of activeFlashSpans) {
    const parent = span.parentNode;
    if (!parent) continue;
    while (span.firstChild) parent.insertBefore(span.firstChild, span);
    parent.removeChild(span);
    if (parent.nodeType === Node.ELEMENT_NODE) {
      (parent as Element).normalize();
    }
  }
  activeFlashSpans = [];
}

/**
 * Returns the list of verse-anchor elements that fall within the given
 * span, applying part-trim rules at both endpoints. Returned in document
 * order — `querySelectorAll` already provides that.
 */
function collectInRangeAnchors(
  startVerse: number,
  startPart: string | null,
  endVerse: number,
  endPart: string | null
): HTMLElement[] {
  const startCode = startPart !== null ? startPart.charCodeAt(0) : 0;
  const endCode = endPart !== null ? endPart.charCodeAt(0) : 0;
  const all = document.querySelectorAll<HTMLElement>('[id^="verse-"]');
  const inRange: HTMLElement[] = [];
  for (let i = 0; i < all.length; i++) {
    const el = all[i];
    const m = /^verse-(\d+)([a-z])?$/.exec(el.id);
    if (!m) continue;
    const n = parseInt(m[1], 10);
    const part = m[2] ?? null;

    if (n < startVerse || n > endVerse) continue;
    if (n === startVerse && startPart !== null) {
      if (part === null) continue;
      if (part.charCodeAt(0) < startCode) continue;
    }
    if (n === endVerse && endPart !== null && part !== null) {
      if (part.charCodeAt(0) > endCode) continue;
    }
    inRange.push(el);
  }
  return inRange;
}

/**
 * Returns the first H1–H6 element that sits after `a` and (if given) before
 * `b` in document order. Used to clamp the trailing edge of a flash range
 * so that a section heading isn't highlighted along with the last selected
 * verse when the selection doesn't continue into the next section.
 */
function findHeadingBetween(a: Element, b: Element | null): Element | null {
  const headings = document.querySelectorAll<HTMLElement>(
    "h1, h2, h3, h4, h5, h6"
  );
  for (let i = 0; i < headings.length; i++) {
    const h = headings[i];
    if (!(a.compareDocumentPosition(h) & Node.DOCUMENT_POSITION_FOLLOWING)) {
      continue;
    }
    if (b && !(h.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING)) {
      continue;
    }
    return h;
  }
  return null;
}

/**
 * Builds DOM Ranges that cover the text of each in-range verse: from the
 * verse's anchor element up to (but not including) the next verse anchor
 * in the document. Final in-range verse extends to end-of-document.
 *
 * Heading clamp: when the verse AFTER the current anchor is NOT itself in
 * the selection (i.e. this is a trailing edge of the highlighted span), the
 * range stops before any heading that sits between the two anchors. Without
 * this, a section heading that precedes the next verse would be swept into
 * the highlight even though the user's selection ends within the previous
 * section. For interior verses, headings are kept inside the range so
 * heading-split verses (parts b, c, …) still highlight fully.
 */
function buildVerseTextRanges(
  startVerse: number,
  startPart: string | null,
  endVerse: number,
  endPart: string | null
): Range[] {
  const inRange = collectInRangeAnchors(startVerse, startPart, endVerse, endPart);
  if (inRange.length === 0) return [];

  // Need every verse-* anchor in document order to find the immediate
  // next stopping point for each in-range one (the next anchor may itself
  // be out of range — e.g. the verse right after the end of the span).
  const allValidAnchors: HTMLElement[] = [];
  const all = document.querySelectorAll<HTMLElement>('[id^="verse-"]');
  for (let i = 0; i < all.length; i++) {
    if (/^verse-\d+[a-z]?$/.test(all[i].id)) allValidAnchors.push(all[i]);
  }

  const inRangeSet = new Set<HTMLElement>(inRange);

  const ranges: Range[] = [];
  for (const anchor of inRange) {
    const idx = allValidAnchors.indexOf(anchor);
    const next = idx >= 0 ? allValidAnchors[idx + 1] : undefined;
    const nextInSelection = next !== undefined && inRangeSet.has(next);

    const range = document.createRange();
    try {
      range.setStartBefore(anchor);
      if (next) {
        if (!nextInSelection) {
          const heading = findHeadingBetween(anchor, next);
          if (heading) {
            range.setEndBefore(heading);
          } else {
            range.setEndBefore(next);
          }
        } else {
          range.setEndBefore(next);
        }
      } else {
        // No next anchor — extend through the end of the document body,
        // but still clamp before any trailing heading so a final section
        // header isn't highlighted.
        const heading = findHeadingBetween(anchor, null);
        if (heading) {
          range.setEndBefore(heading);
        } else {
          const last = document.body.lastChild;
          if (!last) continue;
          range.setEndAfter(last);
        }
      }
      ranges.push(range);
    } catch {
      // setStart/setEnd can throw on detached nodes; just skip.
      continue;
    }
  }
  return ranges;
}
