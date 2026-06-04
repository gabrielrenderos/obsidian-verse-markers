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

import {
  App,
  Component,
  MarkdownRenderer,
  MarkdownView,
  TFile,
  setIcon,
} from "obsidian";
import {
  appendMissingFootnoteDefinitions,
  findVerseLine,
  firstFragmentPart,
  getVerseContent,
  getVerseFragments,
  getVerseParts,
  getVerseRangeRawText,
  parseVerseSegments,
  partHasAnchor,
  verseBlockquotePrefix,
  type VerseSegment,
} from "./detection";
import { collectVerseAnchors } from "./postprocessor";
import type VerseMarkersPlugin from "./main";

/* ---------------------------------------------------------------------------
 * Nested popover model
 * ---------------------------------------------------------------------------
 * Each visible popover registers a node in `popoverNodes`. Nodes form a tree
 * keyed by ancestry: when a popover is opened by hovering an anchor that
 * lives inside another popover's rendered content, the new node becomes a
 * child of that popover. Hide policy:
 *   - A node never auto-hides while it has open children (the user is
 *     interacting with a descendant).
 *   - When a child closes, the parent re-evaluates: if the cursor is no
 *     longer over the parent, schedule a hide.
 *   - When a node hides, all of its descendants hide first (so closing a
 *     parent reliably tears down the whole subtree).
 * Depth is capped at MAX_POPOVER_DEPTH to avoid runaway nesting.
 * ------------------------------------------------------------------------- */

interface PopoverNode {
  el: HTMLElement;
  parent: PopoverNode | null;
  children: Set<PopoverNode>;
  depth: number;
  /** Cursor currently over the popover's own frame (NOT its source anchor). */
  hovered: boolean;
  cancelHide: () => void;
  scheduleHide: () => void;
  hide: () => void;
}

/**
 * Hard cap on popover chain depth. Realistic chains are 2–3 deep; this is
 * intentionally well above that so we never deny a legitimate use, but
 * still bounded so a pathological link-cycle can't keep allocating
 * components forever.
 */
const MAX_POPOVER_DEPTH = 16;

/** Live popover-node lookup, used to find the parent of a nested popover. */
const popoverNodes: WeakMap<HTMLElement, PopoverNode> = new WeakMap();

/**
 * Walks up from `node` to find the nearest enclosing popover frame and
 * returns its registered PopoverNode, or null if `node` is not inside any
 * verse popover.
 */
function findEnclosingPopoverNode(node: Node | null): PopoverNode | null {
  let cur: Node | null = node;
  while (cur) {
    if (
      cur.nodeType === Node.ELEMENT_NODE &&
      (cur as HTMLElement).classList.contains("verse-hover-preview")
    ) {
      const found = popoverNodes.get(cur as HTMLElement);
      if (found) return found;
    }
    cur = cur.parentNode;
  }
  return null;
}

/** Cancels the hide timer for `node` and every ancestor up to the root. */
function cancelHideUpChain(node: PopoverNode | null): void {
  let cur = node;
  while (cur) {
    cur.cancelHide();
    cur = cur.parent;
  }
}

/** Converts a single lowercase letter "a".."z" to a zero-based index. */
function partToIndex(part: string): number {
  return part.charCodeAt(0) - "a".charCodeAt(0);
}

/**
 * Renders a verse label (e.g. "3" or "3b") as a `.verse-marker` span so the
 * popover colors it with the theme accent, exactly like the bracket-less
 * markers the reading-view post-processor produces from `[N]`.
 *
 * We can't just emit `[3b]` markdown and let the post-processor style it:
 * the canonical verse-marker regex matches digit-only tokens, so a part
 * label like "3b" would slip through and render as unstyled plain text.
 */
function verseMarkerLabel(label: string): string {
  return `<span class="verse-marker">${label}</span>`;
}

/**
 * Re-wraps `text` in a blockquote by prefixing every line with `prefix`
 * (e.g. "> "). A no-op when `prefix` is empty, so non-blockquote verses are
 * left untouched. Restores the quote-block styling that verse-content
 * synthesis drops (the extractor strips `>` markers).
 */
function applyBlockquotePrefix(text: string, prefix: string): string {
  if (!prefix) return text;
  return text
    .split("\n")
    .map((line) => `${prefix}${line}`)
    .join("\n");
}

/**
 * Builds the preview markdown for a verse range, WITHOUT appending footnote
 * definitions (the caller does that once so multi-segment references don't
 * duplicate the footnote section). Returns the number of canonical verses the
 * core actually covers (for the shared verse budget) and null markdown if
 * nothing was found.
 *
 * `startPart`/`endPart` (if given) trim the endpoints to a specific
 * heading-split sub-part. `maxVerses` caps how many verses this core renders.
 */
function buildRangeCore(
  content: string,
  start: number,
  end: number,
  maxVerses: number,
  startPart: string | null,
  endPart: string | null
): { markdown: string; versesUsed: number } | null {
  const limit = Math.min(end, start + Math.max(maxVerses, 1) - 1);

  // Fast path: no part trimming. Return the raw source span so the popover
  // mirrors the document layout (inline verse markers, paragraphs, headings,
  // blockquotes). The MarkdownRenderer + our own post-processor handle the
  // rest, giving the preview the same look as the reading view.
  if (startPart === null && endPart === null) {
    const raw = getVerseRangeRawText(content, start, limit);
    if (!raw || raw.length === 0) return null;
    return { markdown: raw, versesUsed: limit - start + 1 };
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

    const line = `${verseMarkerLabel(label)} ${verseText}`;
    blocks.push(applyBlockquotePrefix(line, verseBlockquotePrefix(content, n)));
  }

  if (blocks.length === 0) return null;
  return { markdown: blocks.join("\n\n"), versesUsed: limit - start + 1 };
}

/**
 * Builds the preview markdown for a single verse, WITHOUT footnote append.
 *
 * `part` (optional) selects a specific sub-part — an authored [Na] fragment if
 * one exists, else a heading/footnote-split segment. For a whole-verse
 * reference (part null) to a verse the editor split into scattered fragments
 * ([5a]…[5b]…), each fragment is rendered as its own block (labeled with its
 * own marker, kept on a separate line), omitting the heading and any verses
 * physically between them. A plain `[N]` verse stays a single block.
 */
function buildSingleCore(
  content: string,
  verse: number,
  part: string | null
): string | null {
  const prefix = verseBlockquotePrefix(content, verse);

  if (part !== null) {
    const verseText = getVerseContent(content, verse, part);
    if (verseText === null || verseText.length === 0) return null;
    const line = `${verseMarkerLabel(`${verse}${part}`)} ${verseText}`;
    return applyBlockquotePrefix(line, prefix);
  }

  const blocks = getVerseFragments(content, verse)
    .filter((f) => f.content.length > 0)
    .map((f) => {
      const label = f.part ? `${verse}${f.part}` : `${verse}`;
      const line = `${verseMarkerLabel(label)} ${f.content}`;
      return applyBlockquotePrefix(line, prefix);
    });
  if (blocks.length === 0) return null;
  return blocks.join("\n\n");
}

/**
 * Builds the markdown source for a verse range preview. Public wrapper that
 * reads the file and appends any missing footnote definitions once.
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
  const core = buildRangeCore(content, start, end, maxVerses, startPart, endPart);
  if (!core) return null;
  return appendMissingFootnoteDefinitions(core.markdown, content);
}

/**
 * Builds the markdown source for a single-verse preview. Public wrapper that
 * reads the file and appends any missing footnote definitions once.
 */
export async function buildSinglePreviewMarkdown(
  app: App,
  file: TFile,
  verse: number,
  part: string | null
): Promise<string | null> {
  const content = await app.vault.cachedRead(file);
  const core = buildSingleCore(content, verse, part);
  if (!core) return null;
  return appendMissingFootnoteDefinitions(core, content);
}

/**
 * Builds the preview markdown for a (possibly disjoint) multi-segment verse
 * reference, e.g. `verse-4:6/8:10`. Each segment is rendered in order with the
 * verses it excludes (7, here) omitted; segments are separated by a blank
 * line. A single shared `maxVerses` budget is spent across all segments, and
 * footnote definitions are appended once over the whole result.
 *
 * Returns null if the file can't be read or no segment yields content.
 */
export async function buildSegmentsPreviewMarkdown(
  app: App,
  file: TFile,
  segments: VerseSegment[],
  maxVerses: number
): Promise<string | null> {
  const content = await app.vault.cachedRead(file);
  const blocks: string[] = [];
  let remaining = maxVerses;

  for (const seg of segments) {
    if (remaining <= 0) break;
    const isSingle = seg.start === seg.end && seg.startPart === seg.endPart;
    if (isSingle) {
      const core = buildSingleCore(content, seg.start, seg.startPart);
      if (core) {
        blocks.push(core);
        remaining -= 1;
      }
    } else {
      const core = buildRangeCore(
        content,
        seg.start,
        seg.end,
        remaining,
        seg.startPart,
        seg.endPart
      );
      if (core) {
        blocks.push(core.markdown);
        remaining -= core.versesUsed;
      }
    }
  }

  if (blocks.length === 0) return null;
  return appendMissingFootnoteDefinitions(blocks.join("\n\n"), content);
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
  let node: PopoverNode | null = null;
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

  /**
   * Schedules a hide unless this popover has open child popovers — in that
   * case the user is still interacting with a descendant and we must not
   * tear down the chain. The child's own hide() will re-trigger this on
   * its way out, so the parent collapses naturally afterwards.
   */
  const scheduleHide = (): void => {
    cancelHide();
    if (node && node.children.size > 0) return;
    hideTimer = window.setTimeout(hide, HIDE_DELAY_MS);
  };

  const hide = (): void => {
    cancelHide();
    showToken++; // invalidate any in-flight show()

    // Hide all descendants first so the subtree disappears as a unit.
    // Iterate over a copy because each child.hide() removes itself from
    // node.children via its parent-bookkeeping below.
    if (node) {
      const children = Array.from(node.children);
      for (const c of children) c.hide();
    }

    if (popoverComponent) {
      popoverComponent.unload();
      popoverComponent = null;
    }
    if (node) {
      if (node.el.parentNode) node.el.parentNode.removeChild(node.el);
      popoverNodes.delete(node.el);
      const parent = node.parent;
      if (parent) {
        parent.children.delete(node);
        // If the cursor is no longer over the parent's frame, the chain
        // should now collapse: schedule the parent's hide. If the cursor
        // IS over the parent, scheduleHide is a no-op until mouseleave.
        if (!parent.hovered) parent.scheduleHide();
      }
      node = null;
    }
  };

  const show = async (ev: MouseEvent): Promise<void> => {
    cancelHide();
    if (!plugin.settings.enableHoverPreviews) return;
    // Already visible — don't rebuild.
    if (node) return;

    const hashIndex = linkText.indexOf("#");
    if (hashIndex === -1) return;

    const filePart = linkText.slice(0, hashIndex);
    const fragment = linkText.slice(hashIndex + 1);
    const allowShorthand = plugin.settings.enableShorthandSyntax;

    const file = plugin.app.metadataCache.getFirstLinkpathDest(filePart, "");
    if (!(file instanceof TFile)) return;

    // Identify parent popover (if this anchor lives inside one) and bail
    // out early if we'd exceed the depth cap. Using `>=` because the new
    // popover would sit one level deeper than its parent.
    const parentNode = findEnclosingPopoverNode(anchorEl);
    if (parentNode && parentNode.depth >= MAX_POPOVER_DEPTH - 1) return;

    const myToken = ++showToken;

    // One unified path handles single verses, ranges, and disjoint
    // multi-segment references (verse-4:6/8:10) alike.
    let markdown: string | null = null;
    const segments = parseVerseSegments(fragment, allowShorthand);
    if (segments) {
      markdown = await buildSegmentsPreviewMarkdown(
        plugin.app,
        file,
        segments,
        plugin.settings.hoverPreviewMaxVerses
      );
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

    // Build the node up-front so closures below can reference it by capture.
    const newNode: PopoverNode = {
      el,
      parent: parentNode,
      children: new Set(),
      depth: parentNode ? parentNode.depth + 1 : 0,
      hovered: false,
      cancelHide,
      scheduleHide,
      hide,
    };

    // Mouse on this popover: cancel hide for every ancestor too, so
    // moving the cursor into a deeply-nested popover keeps the whole
    // chain alive.
    el.addEventListener("mouseenter", () => {
      newNode.hovered = true;
      cancelHideUpChain(newNode);
    });
    el.addEventListener("mouseleave", () => {
      newNode.hovered = false;
      scheduleHide();
    });

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
      // Closing from the root collapses the whole chain at once.
      hideRoot(newNode);
      await resolveVerseLink(plugin.app, file, fragment, allowShorthand);
    });
    embed.appendChild(openLink);

    // Initial placement: under the link, left-aligned with the link's
    // start. Final placement runs again after render once we know the
    // popover's actual size (so we can flip above / clip to viewport).
    positionPopover(el, anchorEl);
    document.body.appendChild(el);

    // Register parent ↔ child link as soon as the DOM is in place. This is
    // intentionally before the async render: if the parent's hide timer
    // was already running (because mouseleave fired during the await
    // above), the child's existence must block it from firing.
    if (parentNode) {
      parentNode.children.add(newNode);
      cancelHideUpChain(parentNode);
    }
    popoverNodes.set(el, newNode);

    const component = new Component();
    component.load();
    await MarkdownRenderer.renderMarkdown(markdown, previewEl, file.path, component);

    // Re-position now that the rendered content has determined the size.
    positionPopover(el, anchorEl);

    // Yet another cancellation window — render might be slow.
    if (myToken !== showToken) {
      component.unload();
      if (parentNode) parentNode.children.delete(newNode);
      popoverNodes.delete(el);
      if (el.parentNode) el.parentNode.removeChild(el);
      return;
    }

    // Wire hover + click on every verse anchor inside the rendered
    // preview, so links nested in the popover behave the same as those in
    // the reading view: hovering opens a (deeper) popover, clicking
    // navigates and closes the chain. Disposers are tied to the
    // popover's Component so they're released on hide().
    const innerDisposers = wirePopoverContent(plugin, previewEl, newNode);
    component.register(() => {
      for (const d of innerDisposers) d();
    });

    node = newNode;
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

  // Anchor enter/leave keep ancestors alive too: hovering a verse link
  // inside a popover should not let any ancestor time out.
  const onAnchorEnter = (ev: MouseEvent): void => {
    const enclosing = findEnclosingPopoverNode(anchorEl);
    cancelHideUpChain(enclosing);
    void show(ev);
  };

  anchorEl.addEventListener("mouseover", suppressNative);
  anchorEl.addEventListener("mouseenter", onAnchorEnter);
  anchorEl.addEventListener("mouseleave", scheduleHide);
  anchorEl.addEventListener("click", onClickHide);

  return () => {
    anchorEl.removeEventListener("mouseover", suppressNative);
    anchorEl.removeEventListener("mouseenter", onAnchorEnter);
    anchorEl.removeEventListener("mouseleave", scheduleHide);
    anchorEl.removeEventListener("click", onClickHide);
    hide();
  };
}

/** Walks up the popover chain from `node` and hides the root, cascading. */
function hideRoot(node: PopoverNode): void {
  let cur: PopoverNode = node;
  while (cur.parent) cur = cur.parent;
  cur.hide();
}

/**
 * Wires hover + click handlers on every verse-reference anchor inside an
 * already-rendered popover preview. Returns disposer callbacks the caller
 * is responsible for invoking on teardown (we attach them to the
 * popover's own Component).
 *
 * Click closes the entire chain (root popover + descendants) before
 * navigating, so the user lands on the target note with a clean viewport.
 */
function wirePopoverContent(
  plugin: VerseMarkersPlugin,
  contentEl: HTMLElement,
  ownerNode: PopoverNode
): Array<() => void> {
  const allowShorthand = plugin.settings.enableShorthandSyntax;
  const anchors = collectVerseAnchors(contentEl, allowShorthand);
  const disposers: Array<() => void> = [];
  for (const a of anchors) {
    const href = a.getAttribute("data-href") ?? a.getAttribute("href") ?? "";
    const hashIdx = href.indexOf("#");
    if (hashIdx === -1) continue;
    const filePart = href.slice(0, hashIdx);
    const fragment = href.slice(hashIdx + 1);

    const onClick = async (ev: MouseEvent): Promise<void> => {
      const file = plugin.app.metadataCache.getFirstLinkpathDest(filePart, "");
      if (!(file instanceof TFile)) return;
      ev.preventDefault();
      hideRoot(ownerNode);
      await resolveVerseLink(plugin.app, file, fragment, allowShorthand);
    };
    a.addEventListener("click", onClick);
    disposers.push(() => a.removeEventListener("click", onClick));

    const dispose = attachVerseHoverPreview(plugin, a as HTMLElement, href);
    disposers.push(dispose);
  }
  return disposers;
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
 * For a disjoint multi-segment reference ("verse-4:6/8:10") navigation jumps
 * to the first segment's start; the flash then highlights every segment,
 * leaving the excluded verses (7, here) untouched.
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
  const segments = parseVerseSegments(fragment, allowShorthand);
  if (!segments || segments.length === 0) return false;

  let startVerse = segments[0].start;
  let startPart = segments[0].startPart;

  const leaf = app.workspace.getMostRecentLeaf();
  if (!leaf) return false;

  // Pre-compute the verse's source line and anchor IDs once so we can
  // decide whether eState's forced scroll is even needed.
  const content = await app.vault.cachedRead(file);

  // Interior footnote parts have no scroll anchor in the reading view (only
  // heading-boundary parts and part "a" do). When the referenced part isn't
  // anchored, drop the part suffix so navigation scrolls to and flashes the
  // complete verse instead of nothing. Heading-split parts are unaffected.
  // Normalize every segment's endpoints the same way for the flash below.
  const flashSegments: VerseSegment[] = segments.map((seg) => ({
    start: seg.start,
    startPart: partHasAnchor(content, seg.start, seg.startPart)
      ? seg.startPart
      : null,
    end: seg.end,
    endPart: partHasAnchor(content, seg.end, seg.endPart) ? seg.endPart : null,
  }));
  startPart = flashSegments[0].startPart;

  const targetLine = findVerseLine(content, startVerse);
  const primaryId = startPart
    ? `verse-${startVerse}${startPart}`
    : `verse-${startVerse}`;
  // A whole-verse reference to a verse authored as scattered fragments has no
  // plain `verse-N` element (only `verse-Na`, `verse-Nb`, …). Fall back to the
  // first fragment's anchor so navigation still lands on the verse.
  const firstPart = firstFragmentPart(content, startVerse);
  const fallbackId =
    !startPart && firstPart ? `verse-${startVerse}${firstPart}` : `verse-${startVerse}`;

  // Decide whether to ask Obsidian to pre-scroll via eState. eState is
  // necessary when the verse anchor isn't currently rendered (Obsidian's
  // reading view virtualizes far-off chunks; without forcing a render,
  // the anchor never exists). But it has a side effect: eState parks
  // the verse at the TOP of the viewport, then our scrollIntoView would
  // need a second pass to re-center — visibly jarring in fast cases
  // where the anchor was already on screen.
  //
  // So: skip eState (and its sibling applyScroll forced render) when we
  // already have the anchor in the DOM. This gives the smooth direct-
  // to-center motion in the fast path while still supporting cold loads
  // and far-off mobile virtualized targets.
  const sameFileOpen =
    leaf.view instanceof MarkdownView && leaf.view.file === file;
  const anchorAlreadyMounted =
    sameFileOpen &&
    (document.getElementById(primaryId) !== null ||
      document.getElementById(fallbackId) !== null);
  const needForcedScroll = !anchorAlreadyMounted && targetLine !== null;

  const openState: { eState?: { line: number } } | undefined = needForcedScroll
    ? { eState: { line: targetLine as number } }
    : undefined;

  // Suppress Obsidian's native scroll-flash for the duration of this
  // navigation. eState: { line } both scrolls the preview AND triggers
  // Obsidian's own block-flash on the target — which visibly overlaps
  // with our custom verse-range flash. The observer actively strips the
  // native flash classes the moment Obsidian tries to apply them, and
  // is scoped to this navigation only so unrelated native flashes still
  // fire normally. Only armed when eState is actually used, since
  // Obsidian's flash is what eState triggers.
  if (needForcedScroll) {
    suppressNativeFlashFor(NATIVE_FLASH_SUPPRESS_MS);
  }

  await leaf.openFile(file, openState);

  // Belt-and-suspenders applyScroll only on the cold path. We need it
  // there for the same-file case where openFile may not re-apply eState
  // because the file was already open. On the warm path (anchor already
  // mounted) calling applyScroll would re-park the verse at the top and
  // cancel the "smooth direct-to-center" feel of the warm navigation.
  if (
    needForcedScroll &&
    targetLine !== null &&
    leaf.view instanceof MarkdownView
  ) {
    const scrollableView = leaf.view as unknown as {
      applyScroll?: (scroll: number) => void;
    };
    scrollableView.applyScroll?.(targetLine);
  }

  // Wait for the verse anchor to actually exist in the rendered DOM
  // instead of guessing with a fixed timeout. The reading view's markdown
  // postprocessor runs asynchronously after openFile() resolves, and the
  // delay varies per platform — desktop is typically <50ms, but mobile
  // (iOS/iPadOS) can take several hundred ms on larger notes. A
  // MutationObserver lets us run as soon as the anchor exists while still
  // capping the total wait so we don't hang forever on a missing verse.
  const anchor =
    (await waitForElementById(primaryId, ANCHOR_WAIT_TIMEOUT_MS)) ??
    document.getElementById(fallbackId);
  if (anchor) {
    // We deliberately avoid Element.scrollIntoView({block: "center"}). Two
    // problems made it unreliable in our setup:
    //
    //   1. It SHORT-CIRCUITS when the browser already considers the
    //      element "sufficiently visible". WebKit (iOS/iPadOS) is
    //      especially aggressive: after Obsidian's eState parks the
    //      verse at the top of the viewport, scrollIntoView({center})
    //      sometimes does nothing because the element is technically
    //      visible — and the verse stays at the top.
    //
    //   2. It LOSES RACES to async scroll commands fired by Obsidian
    //      (e.g. eState's smooth scroll, which can land after openFile
    //      resolves). The browser treats the latest scroll call as
    //      authoritative, but it's hard to guarantee ours runs last.
    //
    // smoothScrollAnchorToCenter computes the target offset and uses
    // scrollTo, which never short-circuits. It also cancels any
    // in-flight smooth scroll before issuing ours so it can't be
    // overwritten.
    //
    // We wait one animation frame before scrolling so any rAF-scheduled
    // scroll command from eState (Obsidian commonly queues its scroll
    // for the next frame after openFile resolves) has already committed.
    // After that frame, our cancel-then-scroll sequence is guaranteed
    // to be the last writer and wins deterministically.
    requestAnimationFrame(() => {
      if (document.body.contains(anchor)) {
        smoothScrollAnchorToCenter(anchor);
      }
    });
  }
  flashVerseSegments(flashSegments);

  return true;
}

/**
 * Maximum time we'll keep watching for a verse anchor to appear after
 * navigation. 1500ms comfortably covers slow mobile renders on large
 * notes; on desktop we usually return in well under 50ms.
 */
const ANCHOR_WAIT_TIMEOUT_MS = 1500;

/**
 * Walks up from `el` looking for the nearest scrollable ancestor —
 * the element whose own scrollbar would actually move when you scroll
 * inside `el`. Returns null if the element scrolls with the document
 * itself (in which case the caller should use window.scrollTo).
 *
 * We need this because Obsidian's reading view scrolls inside a
 * dedicated container (`.markdown-preview-view`), not the document.
 * Calling window.scrollTo there would do nothing.
 */
function findScrollAncestor(el: Element): HTMLElement | null {
  let parent = el.parentElement;
  while (parent) {
    const style = getComputedStyle(parent);
    const overflowY = style.overflowY;
    const scrollable = overflowY === "auto" || overflowY === "scroll";
    if (scrollable && parent.scrollHeight > parent.clientHeight) {
      return parent;
    }
    parent = parent.parentElement;
  }
  return null;
}

/**
 * Smoothly scrolls so that `anchor` lands vertically centered in its
 * scroll container. We deliberately compute the target offset and call
 * scrollTo ourselves instead of using Element.scrollIntoView({block:
 * "center"}) because:
 *
 *   1. scrollIntoView short-circuits when the browser already considers
 *      the element "sufficiently visible" — particularly in WebKit,
 *      this happens after eState has just parked the verse at the top
 *      of the viewport, leaving us stuck at the top.
 *   2. scrollIntoView competes badly with other in-flight scroll
 *      animations (Obsidian's eState fires asynchronously after
 *      openFile resolves); the latest scroll command wins, and we
 *      can't always guarantee ours runs last.
 *
 * scrollTo with an explicit pixel target has neither problem: it
 * always moves to that exact offset, and being a fresh smooth scroll
 * request it cleanly overrides any in-flight animation.
 */
function smoothScrollAnchorToCenter(anchor: HTMLElement): void {
  const container = findScrollAncestor(anchor);
  const anchorRect = anchor.getBoundingClientRect();

  if (!container) {
    // Cancel any in-flight smooth scroll on the document before issuing
    // ours. Without this, an Obsidian eState scroll fired right before
    // us (or scheduled during openFile but not yet committed) will land
    // after we do and clobber our centering. `behavior: "auto"` is
    // instant per CSSOM spec and interrupts any pending smooth scroll.
    window.scrollTo({ top: window.scrollY, behavior: "auto" });

    const target =
      window.scrollY +
      anchorRect.top +
      anchorRect.height / 2 -
      window.innerHeight / 2;
    window.scrollTo({ top: target, behavior: "smooth" });
    return;
  }

  // Same race-prevention trick on the scroll container. This is the
  // critical fix for the "verse parks at top, then 400ms later jumps
  // to center" symptom: that wait was caused by eState's deferred
  // smooth scroll winning the race against ours. Cancelling it here
  // means our smooth scroll always animates straight from the current
  // position to centered, with no parking step.
  container.scrollTo({ top: container.scrollTop, behavior: "auto" });

  const containerRect = container.getBoundingClientRect();
  const relTop = anchorRect.top - containerRect.top;
  const target =
    container.scrollTop +
    relTop +
    anchorRect.height / 2 -
    container.clientHeight / 2;
  container.scrollTo({ top: target, behavior: "smooth" });
}

/**
 * How long the native scroll-flash suppression stays armed during a verse
 * navigation. Generous: covers slow mobile renders where Obsidian adds the
 * flash class some time after openFile resolves (the class can be applied
 * once the target chunk finally renders, which on a long iCloud-synced
 * note may be well after our own flash starts). Outside this window
 * unrelated native flashes (e.g. backlinks panel) behave normally.
 */
const NATIVE_FLASH_SUPPRESS_MS = 5000;

/**
 * Class names Obsidian adds to elements when it paints its scroll-flash.
 * `is-flashing` is the canonical one; the others are belt-and-suspenders
 * for theme/version variants we've seen in the wild.
 */
const NATIVE_FLASH_CLASSES = [
  "is-flashing",
  "is-flashing-block",
  "has-active-flash",
  "is-flash",
];

function stripNativeFlashClasses(el: Element): void {
  for (const cls of NATIVE_FLASH_CLASSES) {
    if (el.classList.contains(cls)) el.classList.remove(cls);
  }
}

/**
 * Actively suppresses Obsidian's native scroll-flash for `durationMs`.
 *
 * A MutationObserver watches document.body for any element gaining one
 * of the native flash class names (or being inserted with one) and
 * removes the class before the browser paints. This is more reliable
 * than a CSS-only override because:
 *   1. It works even if Obsidian's class names change in a future
 *      version (we check a small allowlist; easy to extend).
 *   2. It strips the class outright, so even if the suppression window
 *      ends mid-animation the flash cannot resume.
 *   3. It only runs while WE triggered the navigation — native flashes
 *      from unrelated sources (backlink jumps, search results, normal
 *      heading links, etc.) fire as Obsidian intends.
 *
 * Returns a disposer in case a follow-up navigation needs to disarm
 * early; otherwise the timer disconnects automatically.
 */
function suppressNativeFlashFor(durationMs: number): () => void {
  const root = document.body;

  // Strip anything already flagged before we started — covers the rare
  // case where the previous navigation's flash hasn't decayed yet.
  for (const cls of NATIVE_FLASH_CLASSES) {
    root.querySelectorAll(`.${cls}`).forEach(stripNativeFlashClasses);
  }

  const observer = new MutationObserver((mutations) => {
    for (const m of mutations) {
      if (m.type === "attributes" && m.attributeName === "class") {
        stripNativeFlashClasses(m.target as Element);
      } else if (m.type === "childList") {
        for (const node of Array.from(m.addedNodes)) {
          if (node.nodeType !== Node.ELEMENT_NODE) continue;
          const el = node as Element;
          stripNativeFlashClasses(el);
          for (const cls of NATIVE_FLASH_CLASSES) {
            el.querySelectorAll(`.${cls}`).forEach(stripNativeFlashClasses);
          }
        }
      }
    }
  });

  observer.observe(root, {
    attributes: true,
    attributeFilter: ["class"],
    childList: true,
    subtree: true,
  });

  let disposed = false;
  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    observer.disconnect();
    window.clearTimeout(timer);
  };
  const timer = window.setTimeout(dispose, durationMs);
  return dispose;
}

/**
 * Resolves with the element matching `id` as soon as it exists in the
 * document, or null if `timeoutMs` elapses without it appearing.
 *
 * Uses a MutationObserver scoped to document.body so we react the moment
 * the reading view's postprocessor injects our verse anchors. Falls back
 * to a one-shot poll on timeout in case the element appeared between the
 * initial check and observer setup (very rare race).
 */
function waitForElementById(
  id: string,
  timeoutMs: number
): Promise<HTMLElement | null> {
  const existing = document.getElementById(id);
  if (existing) return Promise.resolve(existing);

  return new Promise((resolve) => {
    let settled = false;
    const finish = (el: HTMLElement | null): void => {
      if (settled) return;
      settled = true;
      observer.disconnect();
      window.clearTimeout(timer);
      resolve(el);
    };

    const observer = new MutationObserver(() => {
      const el = document.getElementById(id);
      if (el) finish(el);
    });
    observer.observe(document.body, { childList: true, subtree: true });

    const timer = window.setTimeout(() => {
      finish(document.getElementById(id));
    }, timeoutMs);
  });
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
 * reference — not their containing blocks. We wrap the text nodes that fall
 * inside each in-range verse's DOM Range with `<span class="verse-flash">`
 * elements, then toggle `.verse-flash-active` to drive a CSS background
 * transition. The rounded-corner / padded look is therefore real CSS box
 * decoration (impossible with the CSS Custom Highlight API, which only
 * accepts color/background-color/text-decoration on `::highlight()`).
 *
 * Works for a single verse, a range, or a disjoint multi-segment reference:
 * each verse that belongs to the reference is highlighted up to (but not
 * including) the next anchor, so verses excluded by a gap (e.g. 7 in
 * 4:6/8:10) are never highlighted. Rounded end-caps are applied per
 * contiguous run, so each highlighted block reads as its own pill.
 *
 * Spans are unwrapped after the fade-out completes so the DOM ends up
 * exactly as it started.
 */
function flashVerseSegments(segments: VerseSegment[]): void {
  const flashRanges = buildVerseFlashRanges(segments);
  if (flashRanges.length === 0) return;

  // Tear down any in-flight previous flash before starting this one.
  if (flashTimer !== null) {
    window.clearTimeout(flashTimer);
    flashTimer = null;
  }
  unwrapFlashSpans();

  const spans: HTMLSpanElement[] = [];
  for (const fr of flashRanges) {
    const rangeSpans = wrapRangeWithSpans(fr.range, "verse-flash");
    if (rangeSpans.length > 0) {
      // Cap a run's outer edges only (the first span of a run-start and the
      // last span of a run-end) so interior seams stay square and seamless.
      if (fr.capStart) rangeSpans[0].classList.add("verse-flash-start");
      if (fr.capEnd) {
        rangeSpans[rangeSpans.length - 1].classList.add("verse-flash-end");
      }
    }
    for (const span of rangeSpans) spans.push(span);
  }
  if (spans.length === 0) return;

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
 * Reports whether a verse anchor numbered `n` with part `part` (null for a
 * plain marker) falls inside `seg`, honoring part-trims at the endpoints.
 */
function anchorInSegment(
  n: number,
  part: string | null,
  seg: VerseSegment
): boolean {
  if (n < seg.start || n > seg.end) return false;
  if (n === seg.start && seg.startPart !== null) {
    if (part === null) return false;
    if (part.charCodeAt(0) < seg.startPart.charCodeAt(0)) return false;
  }
  if (n === seg.end && seg.endPart !== null && part !== null) {
    if (part.charCodeAt(0) > seg.endPart.charCodeAt(0)) return false;
  }
  return true;
}

/**
 * Returns the verse-anchor elements that fall within ANY of the reference's
 * segments, applying part-trim rules at each segment's endpoints. Verses that
 * lie in a gap between segments (e.g. 7 in 4:6/8:10) are excluded. Returned in
 * document order — `querySelectorAll` already provides that.
 */
function collectInSegmentsAnchors(segments: VerseSegment[]): HTMLElement[] {
  const all = document.querySelectorAll<HTMLElement>('[id^="verse-"]');
  const inRange: HTMLElement[] = [];
  for (let i = 0; i < all.length; i++) {
    const el = all[i];
    const m = /^verse-(\d+)([a-z]+)?$/.exec(el.id);
    if (!m) continue;
    const n = parseInt(m[1], 10);
    const part = m[2] ?? null;
    if (segments.some((seg) => anchorInSegment(n, part, seg))) inRange.push(el);
  }
  return inRange;
}

/**
 * Selectors for elements that should always stop a flash range, regardless
 * of whether the selection continues into the next verse. Footnote sections
 * (rendered at the bottom of a note) must never be highlighted along with
 * the last verse when the verse is the final entry before the footnotes.
 *
 * Different Obsidian versions / themes name the wrapper differently, so
 * the list is intentionally broad.
 */
const FLASH_STOP_FOOTNOTE_SELECTORS = [
  "section.footnotes",
  ".footnotes",
  "ol.footnote-list",
];

/**
 * Selectors for ATX heading elements. Treated as a flash stop only when
 * the next verse anchor is NOT in the selection — this keeps headings
 * INSIDE the highlight when the selection continues into a heading-split
 * sub-part (verse-Nb, verse-Nc, …).
 */
const FLASH_STOP_HEADING_SELECTORS = ["h1", "h2", "h3", "h4", "h5", "h6"];

/**
 * Returns the first stop element (heading and/or footnote section) that
 * sits after `a` and, if given, before `b` in document order. Returns
 * null when no candidate exists in that range.
 *
 * Footnotes are always candidates. Headings are candidates only when
 * `includeHeadings` is true — typically when this anchor's range does
 * NOT continue into the next verse (a section heading immediately
 * preceding an unrelated next verse must not bleed into the highlight).
 *
 * `querySelectorAll` already returns matches in document order, so the
 * first one that satisfies the bounds is the earliest stop.
 */
function findFlashStopBetween(
  a: Element,
  b: Element | null,
  includeHeadings: boolean
): Element | null {
  const selectors = includeHeadings
    ? [...FLASH_STOP_FOOTNOTE_SELECTORS, ...FLASH_STOP_HEADING_SELECTORS]
    : FLASH_STOP_FOOTNOTE_SELECTORS;
  const candidates = document.querySelectorAll<HTMLElement>(selectors.join(","));
  for (let i = 0; i < candidates.length; i++) {
    const el = candidates[i];
    if (!(a.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING)) {
      continue;
    }
    if (b && !(el.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING)) {
      continue;
    }
    return el;
  }
  return null;
}

/**
/** A flash range plus whether it begins/ends a contiguous highlighted run. */
interface FlashRange {
  range: Range;
  capStart: boolean;
  capEnd: boolean;
}

/**
 * Builds DOM Ranges that cover the text of each verse belonging to the
 * reference's segments: from the verse's anchor element up to (but not
 * including) the next verse anchor in the document. The final in-range verse
 * extends to end-of-document.
 *
 * Disjoint support: membership is tested against ALL segments, so verses in a
 * gap (7 in 4:6/8:10) are skipped — and because each in-range verse stops at
 * the very next anchor (which, before a gap, is the excluded verse), the
 * excluded text is never highlighted. Each range is tagged capStart/capEnd
 * when it begins/ends a contiguous run, so the caller rounds only the true
 * outer edges of each highlighted block.
 *
 * Heading clamp: when the verse AFTER the current anchor is NOT itself in the
 * selection (a trailing edge of a run), the range stops before any heading
 * between the two anchors. For interior verses, headings stay inside the range
 * so heading-split verses (parts b, c, …) still highlight fully.
 */
function buildVerseFlashRanges(segments: VerseSegment[]): FlashRange[] {
  const inRange = collectInSegmentsAnchors(segments);
  if (inRange.length === 0) return [];

  // Need every verse-* anchor in document order to find the immediate
  // next stopping point for each in-range one (the next anchor may itself
  // be out of range — e.g. the verse right after the end of a segment).
  const allValidAnchors: HTMLElement[] = [];
  const all = document.querySelectorAll<HTMLElement>('[id^="verse-"]');
  for (let i = 0; i < all.length; i++) {
    if (/^verse-\d+[a-z]*$/.test(all[i].id)) allValidAnchors.push(all[i]);
  }

  const inRangeSet = new Set<HTMLElement>(inRange);

  const ranges: FlashRange[] = [];
  for (const anchor of inRange) {
    const idx = allValidAnchors.indexOf(anchor);
    const next = idx >= 0 ? allValidAnchors[idx + 1] : undefined;
    const prev = idx > 0 ? allValidAnchors[idx - 1] : undefined;
    const nextInSelection = next !== undefined && inRangeSet.has(next);
    const prevInSelection = prev !== undefined && inRangeSet.has(prev);

    // Headings act as a stop only when the selection does NOT continue
    // into the next anchor (i.e. this is the trailing edge of a run). When
    // it does continue (heading-split parts), headings stay inside the
    // highlight. Footnotes are always a stop.
    const includeHeadings = !nextInSelection;

    const range = document.createRange();
    try {
      range.setStartBefore(anchor);
      const stop = findFlashStopBetween(anchor, next ?? null, includeHeadings);
      if (stop) {
        range.setEndBefore(stop);
      } else if (next) {
        range.setEndBefore(next);
      } else {
        // No next anchor and no stop — extend through end of body.
        const last = document.body.lastChild;
        if (!last) continue;
        range.setEndAfter(last);
      }
      ranges.push({
        range,
        capStart: !prevInSelection,
        capEnd: !nextInSelection,
      });
    } catch {
      // setStart/setEnd can throw on detached nodes; just skip.
      continue;
    }
  }
  return ranges;
}
