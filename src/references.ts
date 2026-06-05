// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2025 Gabriel Renderos

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
  HoverPopover,
  MarkdownRenderer,
  MarkdownView,
  TFile,
  setIcon,
  type HoverParent,
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
      const sliceStart = trimStart && startPart !== null ? partToIndex(startPart) : 0;
      const sliceEnd = trimEnd && endPart !== null ? partToIndex(endPart) + 1 : parts.length;
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

/* ---------------------------------------------------------------------------
 * Hover previews via the core "Page preview" plugin
 * ---------------------------------------------------------------------------
 * Verse fragments render through Obsidian's own `HoverPopover`, created with the
 * SAME `hoverParent` the core page-preview plugin hands us. Obsidian then
 * manages the parent⇄child popover chain itself, so nesting and keep-alive work
 * natively in EVERY context — a verse link inside a native footnote popover
 * keeps that footnote popover open, nested verse popovers stay open while the
 * cursor is in any descendant, etc.
 *
 * We hook by wrapping page-preview's `onLinkHover` (the handler behind the
 * `hover-link` event): for a verse fragment we open our popover and stop; for
 * any other link we defer to the original. Intercepting also means the native
 * "Unable to find 'verse-N'" popover never fires for our synthetic anchors.
 * For verse links inside OUR OWN popover (which Obsidian doesn't watch for
 * hovers) we re-emit `hover-link` ourselves with our popover as the parent, so
 * the same path opens the nested popover and links it into the chain.
 *
 * `onLinkHover` / `internalPlugins` are non-public, so this is all wrapped
 * defensively: if the shape ever changes we leave native behavior untouched.
 * ------------------------------------------------------------------------- */

type OnLinkHover = (
  hoverParent: HoverParent,
  targetEl: HTMLElement | null,
  linktext: string,
  sourcePath: string,
  ...rest: unknown[]
) => unknown;

interface PagePreviewInstance {
  onLinkHover: OnLinkHover;
}

/**
 * Our popovers double as HoverParents for their nested children and carry a
 * marker (the source anchor) so we can recognize and de-dupe them.
 */
type VerseHoverPopover = HoverPopover &
  HoverParent & { __verseTargetEl?: HTMLElement | null };

/** Reaches the non-public core "page-preview" plugin instance, or null. */
function getPagePreviewInstance(app: App): PagePreviewInstance | null {
  const internal = (
    app as unknown as {
      internalPlugins?: {
        getPluginById?: (id: string) => { instance?: unknown } | null;
        plugins?: Record<string, { instance?: unknown } | undefined>;
      };
    }
  ).internalPlugins;
  const plugin =
    internal?.getPluginById?.("page-preview") ??
    internal?.plugins?.["page-preview"];
  const instance = plugin?.instance as PagePreviewInstance | undefined;
  if (!instance || typeof instance.onLinkHover !== "function") return null;
  return instance;
}

/** Returns the verse fragment of a link target, or null if it isn't one. */
function verseFragmentOf(
  linktext: string,
  allowShorthand: boolean
): string | null {
  const hashIndex = linktext.indexOf("#");
  if (hashIndex === -1) return null;
  const fragment = linktext.slice(hashIndex + 1);
  return parseVerseSegments(fragment, allowShorthand) ? fragment : null;
}

/**
 * Wraps the core page-preview's `onLinkHover` so verse fragments render through
 * our HoverPopover. Restores the original on unload. No-op (native behavior
 * untouched) if the non-public hook isn't available.
 */
export function registerVersePagePreview(plugin: VerseMarkersPlugin): void {
  try {
    const instance = getPagePreviewInstance(plugin.app);
    if (!instance) return;

    const original = instance.onLinkHover.bind(instance) as OnLinkHover;
    const wrapped: OnLinkHover = (
      hoverParent,
      targetEl,
      linktext,
      sourcePath,
      ...rest
    ) => {
      try {
        if (verseFragmentOf(linktext, plugin.settings.enableShorthandSyntax)) {
          // Always suppress the native (unresolvable) popover for verse
          // anchors; only build our own when previews are enabled.
          if (plugin.settings.enableHoverPreviews) {
            openVersePopover(
              plugin,
              hoverParent,
              targetEl,
              linktext,
              sourcePath ?? ""
            );
          }
          return;
        }
      } catch {
        // Fall through to native on any unexpected error.
      }
      return original(hoverParent, targetEl, linktext, sourcePath, ...rest);
    };

    instance.onLinkHover = wrapped;
    plugin.register(() => {
      if (instance.onLinkHover === wrapped) instance.onLinkHover = original;
    });
  } catch {
    // Best effort: previews simply won't show if the private API shape changed.
  }
}

/**
 * Opens a verse hover popover for `linktext` anchored at `targetEl`, parented
 * to `hoverParent` so Obsidian links it into the popover chain.
 */
function openVersePopover(
  plugin: VerseMarkersPlugin,
  hoverParent: HoverParent,
  targetEl: HTMLElement | null,
  linktext: string,
  sourcePath: string
): void {
  const allowShorthand = plugin.settings.enableShorthandSyntax;
  const hashIndex = linktext.indexOf("#");
  if (hashIndex === -1) return;
  const filePart = linktext.slice(0, hashIndex);
  const fragment = linktext.slice(hashIndex + 1);

  const file = plugin.app.metadataCache.getFirstLinkpathDest(filePart, sourcePath);
  if (!(file instanceof TFile)) return;

  // De-dupe: a live popover for this exact anchor is already (being) shown.
  const current = hoverParent.hoverPopover as VerseHoverPopover | null;
  if (current && current.__verseTargetEl === targetEl) return;

  const popover = new HoverPopover(hoverParent, targetEl) as VerseHoverPopover;
  popover.__verseTargetEl = targetEl;
  popover.hoverPopover = null; // act as a HoverParent for nested popovers
  popover.hoverEl.addClass("verse-hover-preview");
  // Keep it invisible until our async content has rendered and we've placed it
  // against the viewport. Obsidian positions the popover at show time based on
  // the still-empty frame, so without this the popover would flash in the wrong
  // spot (and never flip above/clamp like the native one) before our content
  // arrives. visibility:hidden still lays out, so we can measure it.
  popover.hoverEl.style.visibility = "hidden";

  let alive = true;
  popover.register(() => {
    alive = false;
  });

  void renderVersePopover(
    plugin,
    popover,
    () => alive,
    file,
    fragment,
    sourcePath,
    allowShorthand
  );
}

/** Hides a HoverPopover (`hide` is internal-but-present; fall back to unload). */
function hidePopover(popover: HoverPopover): void {
  const h = popover as unknown as { hide?: () => void };
  if (typeof h.hide === "function") h.hide();
  else popover.unload();
}

/**
 * Renders verse content into a popover once Obsidian has attached it. We wait
 * for `hoverEl` to be connected before rendering: footnote refs/scroll only
 * wire up correctly in the live DOM (detached rendering breaks them).
 */
async function renderVersePopover(
  plugin: VerseMarkersPlugin,
  popover: VerseHoverPopover,
  isAlive: () => boolean,
  file: TFile,
  fragment: string,
  sourcePath: string,
  allowShorthand: boolean
): Promise<void> {
  const segments = parseVerseSegments(fragment, allowShorthand);
  if (!segments) return;

  const markdown = await buildSegmentsPreviewMarkdown(
    plugin.app,
    file,
    segments,
    plugin.settings.hoverPreviewMaxVerses
  );
  if (!isAlive() || !markdown) return;

  const hoverEl = popover.hoverEl;
  const win = hoverEl.ownerDocument.defaultView ?? window;
  let frames = 0;
  while (!hoverEl.isConnected && isAlive() && frames++ < 60) {
    await new Promise<void>((resolve) =>
      win.requestAnimationFrame(() => resolve())
    );
  }
  if (!isAlive()) return;

  // Obsidian's class hierarchy, so themes style the popover like the native
  // page-preview: .markdown-embed > .markdown-embed-content > .markdown-rendered.
  hoverEl.empty();
  const embed = hoverEl.createDiv({ cls: "markdown-embed is-loaded" });
  const content = embed.createDiv({ cls: "markdown-embed-content" });
  const preview = content.createDiv({
    cls: "markdown-preview-view markdown-rendered",
  });

  await MarkdownRenderer.render(plugin.app, markdown, preview, file.path, popover);
  if (!isAlive()) return;

  // Corner "open" affordance, same chrome class as the native popover.
  const openLink = embed.createEl("a", {
    cls: "markdown-embed-link",
    attr: { "aria-label": "Open link" },
  });
  setIcon(openLink, "lucide-maximize-2");
  openLink.addEventListener("click", (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    hidePopover(popover);
    void resolveVerseLink(plugin.app, file, fragment, allowShorthand);
  });

  wirePopoverAnchors(plugin, preview, popover, sourcePath);

  // Now that the real content is in place we know the popover's true size, so
  // place it against the viewport (flip above / clamp to edges) the way the
  // native popover does, then reveal it. Obsidian's own placement ran while the
  // frame was still empty, hence this final pass.
  const targetEl = popover.__verseTargetEl ?? null;
  if (targetEl) positionVersePopover(hoverEl, targetEl);
  hoverEl.style.visibility = "";
}

/** Vertical gap between the link and the popover, and viewport edge margin. */
const POPOVER_GAP_PX = 4;
const POPOVER_VIEWPORT_MARGIN_PX = 8;

/**
 * Places `hoverEl` under (or above, when there's no room below) `targetEl`,
 * left-aligned with it and clamped inside the viewport — mirroring Obsidian's
 * native page-preview placement. The popover's max-height/scroll (from the
 * theme) handles content taller than the viewport.
 *
 * We move the popover by the DELTA between its desired and current viewport
 * position rather than assigning absolute coordinates, so this is independent
 * of whatever container/coordinate basis Obsidian positioned it in.
 */
function positionVersePopover(hoverEl: HTMLElement, targetEl: HTMLElement): void {
  const win = hoverEl.ownerDocument.defaultView ?? window;
  const link = targetEl.getBoundingClientRect();
  const pop = hoverEl.getBoundingClientRect();
  if (pop.width === 0 && pop.height === 0) return;
  const vw = win.innerWidth;
  const vh = win.innerHeight;
  const gap = POPOVER_GAP_PX;
  const margin = POPOVER_VIEWPORT_MARGIN_PX;

  // Horizontal: align with the link's left, shifting left to stay on-screen.
  let left = link.left;
  if (left + pop.width > vw - margin) left = vw - pop.width - margin;
  if (left < margin) left = margin;

  // Vertical: below by default; flip above when there's more room there, else
  // clamp so the popover stays within the viewport.
  let top = link.bottom + gap;
  if (top + pop.height > vh - margin) {
    const above = link.top - pop.height - gap;
    const roomAbove = link.top;
    const roomBelow = vh - link.bottom;
    if (above >= margin && roomAbove > roomBelow) top = above;
    else top = Math.max(margin, vh - pop.height - margin);
  }

  const curLeft = parseFloat(hoverEl.style.left || "") || 0;
  const curTop = parseFloat(hoverEl.style.top || "") || 0;
  hoverEl.style.left = `${curLeft + (left - pop.left)}px`;
  hoverEl.style.top = `${curTop + (top - pop.top)}px`;
}

/**
 * Wires verse anchors inside our popover. Unlike the document and native
 * popovers (whose hovers Obsidian emits as `hover-link` itself), our popover
 * lives outside the views Obsidian watches, so we re-emit `hover-link` on hover
 * with THIS popover as the parent — the same `onLinkHover` path then opens the
 * nested popover and Obsidian keeps the chain alive. Click navigates.
 */
function wirePopoverAnchors(
  plugin: VerseMarkersPlugin,
  contentEl: HTMLElement,
  popover: VerseHoverPopover,
  sourcePath: string
): void {
  const allowShorthand = plugin.settings.enableShorthandSyntax;
  const anchors = collectVerseAnchors(contentEl, allowShorthand);
  for (const a of anchors) {
    const href = a.getAttribute("data-href") ?? a.getAttribute("href") ?? "";
    const hashIdx = href.indexOf("#");
    if (hashIdx === -1) continue;
    const filePart = href.slice(0, hashIdx);
    const fragment = href.slice(hashIdx + 1);

    const onClick = (ev: MouseEvent): void => {
      const file = plugin.app.metadataCache.getFirstLinkpathDest(
        filePart,
        sourcePath
      );
      if (!(file instanceof TFile)) return;
      ev.preventDefault();
      ev.stopPropagation();
      hidePopover(popover);
      void resolveVerseLink(plugin.app, file, fragment, allowShorthand);
    };
    const onOver = (ev: MouseEvent): void => {
      // Open the nested popover DIRECTLY, parented to THIS popover. We don't
      // route through the page-preview `hover-link` event here: that path is
      // modifier-gated by Page-preview's per-source settings, so in a view
      // where preview-on-hover needs no modifier the nested hover gets
      // suppressed and the chain never grows past one level. Calling
      // openVersePopover ourselves bypasses that gating entirely.
      //
      // stopPropagation keeps Obsidian's own document-level page-preview
      // handler from ALSO firing for this link (in no-modifier views) and
      // opening a competing popover parented to the underlying VIEW — which,
      // since a HoverParent keeps at most one child, would evict THIS popover.
      // (It doesn't affect the popover's window-level mousemove keep-alive.)
      ev.stopPropagation();
      openVersePopover(plugin, popover, a, href, sourcePath);
    };
    a.addEventListener("click", onClick);
    a.addEventListener("mouseover", onOver);
    popover.register(() => {
      a.removeEventListener("click", onClick);
      a.removeEventListener("mouseover", onOver);
    });
  }
}

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
    (activeDocument.getElementById(primaryId) !== null ||
      activeDocument.getElementById(fallbackId) !== null);
  const needForcedScroll = !anchorAlreadyMounted && targetLine !== null;

  const openState: { eState?: { line: number } } | undefined =
    needForcedScroll && targetLine !== null
      ? { eState: { line: targetLine } }
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
    activeDocument.getElementById(fallbackId);
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
    window.requestAnimationFrame(() => {
      if (activeDocument.body.contains(anchor)) {
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
  const root = activeDocument.body;

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
  const existing = activeDocument.getElementById(id);
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
      const el = activeDocument.getElementById(id);
      if (el) finish(el);
    });
    observer.observe(activeDocument.body, { childList: true, subtree: true });

    const timer = window.setTimeout(() => {
      finish(activeDocument.getElementById(id));
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
  window.requestAnimationFrame(() => {
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

  const walker = activeDocument.createTreeWalker(walkRoot, NodeFilter.SHOW_TEXT);
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
    const span = activeDocument.createElement("span");
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
  const all = activeDocument.querySelectorAll<HTMLElement>('[id^="verse-"]');
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
  const candidates = activeDocument.querySelectorAll<HTMLElement>(selectors.join(","));
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
  const all = activeDocument.querySelectorAll<HTMLElement>('[id^="verse-"]');
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

    const range = activeDocument.createRange();
    try {
      range.setStartBefore(anchor);
      const stop = findFlashStopBetween(anchor, next ?? null, includeHeadings);
      if (stop) {
        range.setEndBefore(stop);
      } else if (next) {
        range.setEndBefore(next);
      } else {
        // No next anchor and no stop — extend through end of body.
        const last = activeDocument.body.lastChild;
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
