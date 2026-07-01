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
  Component,
  HoverPopover,
  MarkdownRenderer,
  MarkdownView,
  TFile,
  WorkspaceLeaf,
  setIcon,
  type HoverParent,
  type OpenViewState,
} from "obsidian";
import {
  enumerateCitableRefsInSegment,
  findVerseLineByRef,
  firstFragmentPartByRef,
  finalizePreviewMarkdown,
  stripAllFootnoteRefs,
  getVerseContentByRef,
  getVerseFragmentsByRef,
  getVersePartsByRef,
  getVerseRangeRawTextByRef,
  parseVerseSegments,
  parseVerseRefEndpoint,
  partHasAnchorByRef,
  anchorRefIsInSegment,
  segmentIsDegenerateSingle,
  getSourceStartForRef,
  verseBlockquotePrefixByRef,
  verseRefToAnchorId,
  verseRefToLabel,
  verseRefToDisplayLabel,
  verseRefsEqual,
  flatVerseRef,
  type VerseRef,
  type VerseSegment,
} from "./detection";
import { collectVerseAnchors, getShowRomanParentInNestedVerses, styleVerseMarkers } from "./postprocessor";
import { convertHighlightSyntaxToHtml } from "./highlights";
import { flashVerseSegmentsInEditor } from "./flashLivePreview";
import {
  scrollEditorWithoutFlash,
  scrollReadingViewToLine,
  setVerseHighlightActive,
} from "./nativeFlash";
import { notifyVerseHighlightShown } from "./highlightDismiss";
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

/** Selectors for the rendered footnote-definition block at the end of a preview. */
const FOOTNOTE_DEFINITION_BLOCK_SELECTORS = [
  "section.footnotes",
  ".footnotes",
  "ol.footnote-list",
] as const;

/**
 * Toggles visibility of the appended footnote-definition section. Inline
 * `[^id]` refs stay wired; only the bottom definition list is hidden.
 */
export function applyFootnotePreviewDisplay(
  root: HTMLElement,
  showDefinitionBlock: boolean
): void {
  root.toggleClass("verse-hide-footnote-defs", !showDefinitionBlock);
  if (showDefinitionBlock) return;
  for (const selector of FOOTNOTE_DEFINITION_BLOCK_SELECTORS) {
    root.querySelectorAll(selector).forEach((el) => {
      if (el.instanceOf(HTMLElement)) el.hide();
    });
  }
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
  seg: VerseSegment,
  maxVerses: number,
  showRomanParentInNested: boolean
): { markdown: string; versesUsed: number } | null {
  const start = seg.start;
  const end = seg.end;

  if (start.part === null && end.part === null) {
    const raw = getVerseRangeRawTextByRef(content, start, end);
    if (!raw || raw.length === 0) return null;
    const count = enumerateCitableRefsInSegment(content, seg).length;
    return {
      markdown: raw,
      versesUsed: Math.min(Math.max(count, 1), maxVerses),
    };
  }

  const blocks: string[] = [];
  let versesUsed = 0;
  for (const ref of enumerateCitableRefsInSegment(content, seg)) {
    if (versesUsed >= maxVerses) break;

    const trimStart = verseRefsEqual(ref, start) && start.part !== null;
    const trimEnd = verseRefsEqual(ref, end) && end.part !== null;

    let verseText: string | null;
    let label = verseRefToDisplayLabel(ref, showRomanParentInNested);

    if (trimStart || trimEnd) {
      const parts = getVersePartsByRef(content, ref);
      if (!parts) continue;
      const sliceStart =
        trimStart && start.part !== null ? partToIndex(start.part) : 0;
      const sliceEnd =
        trimEnd && end.part !== null
          ? partToIndex(end.part) + 1
          : parts.length;
      if (sliceStart < 0 || sliceStart >= parts.length) continue;
      if (sliceEnd <= sliceStart) continue;
      const sliced = parts
        .slice(sliceStart, sliceEnd)
        .filter((p) => p.length > 0);
      if (sliced.length === 0) continue;
      verseText = sliced.join(" ");
      if (trimStart && start.part !== null) {
        label = verseRefToDisplayLabel(
          { ...ref, part: start.part },
          showRomanParentInNested
        );
      }
    } else {
      verseText = getVerseContentByRef(content, ref);
      if (verseText === null) continue;
    }

    const line = `${verseMarkerLabel(label)} ${verseText}`;
    blocks.push(
      applyBlockquotePrefix(line, verseBlockquotePrefixByRef(content, ref))
    );
    versesUsed++;
  }

  if (blocks.length === 0) return null;
  return { markdown: blocks.join("\n\n"), versesUsed };
}

/**
 * Builds the preview markdown for a single verse, WITHOUT footnote append.
 */
function buildSingleCore(
  content: string,
  ref: VerseRef,
  showRomanParentInNested: boolean
): string | null {
  const part = ref.part;

  if (ref.number === null) {
    const raw = getVerseRangeRawTextByRef(content, ref, ref);
    return raw && raw.length > 0 ? raw : null;
  }

  const prefix = verseBlockquotePrefixByRef(content, ref);

  if (part !== null) {
    const verseText = getVerseContentByRef(content, ref);
    if (verseText === null || verseText.length === 0) return null;
    const line = `${verseMarkerLabel(verseRefToDisplayLabel(ref, showRomanParentInNested))} ${verseText}`;
    return applyBlockquotePrefix(line, prefix);
  }

  const baseRef: VerseRef = { ...ref, part: null };
  const fragments = getVerseFragmentsByRef(content, baseRef);
  if (fragments.length === 0) return null;

  if (
    fragments.length === 1 &&
    fragments[0].part === null &&
    segmentIsDegenerateSingle({ start: ref, end: ref })
  ) {
    const raw = getVerseRangeRawTextByRef(content, ref, ref);
    if (raw && raw.length > 0) return raw;
  }

  const blocks = fragments
    .filter((f) => f.content.length > 0)
    .map((f) => {
      const label = f.part
        ? verseRefToDisplayLabel(
            { ...baseRef, part: f.part },
            showRomanParentInNested
          )
        : verseRefToDisplayLabel(baseRef, showRomanParentInNested);
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
  const seg: VerseSegment = {
    start: flatVerseRef(start, startPart),
    end: flatVerseRef(end, endPart),
  };
  const showRoman = getShowRomanParentInNestedVerses();
  const core = buildRangeCore(content, seg, maxVerses, showRoman);
  if (!core) return null;
  return finalizePreviewMarkdown(core.markdown, content);
}

export async function buildSinglePreviewMarkdown(
  app: App,
  file: TFile,
  verse: number,
  part: string | null
): Promise<string | null> {
  const content = await app.vault.cachedRead(file);
  const showRoman = getShowRomanParentInNestedVerses();
  const core = buildSingleCore(content, flatVerseRef(verse, part), showRoman);
  if (!core) return null;
  return finalizePreviewMarkdown(core, content);
}

/**
 * Result of building preview markdown for a verse reference.
 */
export interface SegmentsPreviewResult {
  markdown: string;
  /** Offset in the source file where the excerpt begins (for hierarchical styling). */
  sourceStart: number;
}

/** Markdown for Obsidian's native subpath-not-found embed message (H5 + curly quotes). */
export function versePreviewNotFoundMarkdown(
  subpath: string,
  fileBasename: string
): string {
  return `##### Unable to find \u201c${subpath}\u201d in ${fileBasename}`;
}

/** Renders Obsidian's native embed not-found message into `parent`. */
export async function renderVersePreviewNotFound(
  app: App,
  parent: HTMLElement,
  file: TFile,
  component: Component,
  subpath: string,
  previewCls = "markdown-rendered"
): Promise<void> {
  const content = parent.createDiv({ cls: "markdown-embed-content" });
  const preview = content.createDiv({ cls: previewCls });
  await MarkdownRenderer.render(
    app,
    versePreviewNotFoundMarkdown(subpath, file.basename),
    preview,
    file.path,
    component
  );
}

/** Corner "open" affordance on a `.markdown-embed` card (native embed chrome). */
export function wireVerseEmbedOpenLink(
  embedEl: HTMLElement,
  onClick: (ev: MouseEvent) => void
): void {
  const openLink = embedEl.createEl("a", {
    cls: "markdown-embed-link",
    attr: { "aria-label": "Open link" },
  });
  setIcon(openLink, "lucide-maximize-2");
  openLink.addEventListener("click", (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    onClick(ev);
  });
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
  maxVerses: number,
  showFootnotes = true,
  showRomanParentInNested = getShowRomanParentInNestedVerses()
): Promise<SegmentsPreviewResult | null> {
  const content = await app.vault.cachedRead(file);
  const blocks: string[] = [];
  let remaining = maxVerses;
  let sourceStart: number | null = null;

  for (const seg of segments) {
    if (remaining <= 0) break;
    if (segmentIsDegenerateSingle(seg)) {
      const core = buildSingleCore(content, seg.start, showRomanParentInNested);
      if (!core) return null;
      blocks.push(core);
      if (sourceStart === null) {
        sourceStart = getSourceStartForRef(content, seg.start);
      }
      remaining -= 1;
    } else {
      const core = buildRangeCore(
        content,
        seg,
        remaining,
        showRomanParentInNested
      );
      if (!core) return null;
      blocks.push(core.markdown);
      if (sourceStart === null) {
        sourceStart = getSourceStartForRef(content, seg.start);
      }
      remaining -= core.versesUsed;
    }
  }

  if (blocks.length === 0) return null;
  let markdown = blocks.join("\n\n");
  if (!showFootnotes) markdown = stripAllFootnoteRefs(markdown);
  else markdown = finalizePreviewMarkdown(markdown, content);
  return {
    markdown,
    sourceStart: sourceStart ?? 0,
  };
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

    const original = instance.onLinkHover.bind(instance);
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
 * Routes verse-fragment link clicks through `resolveVerseLink` so Live Preview
 * direct clicks get the CM6 verse flash (not only hover-popover navigation).
 */
export function registerVerseLinkNavigation(plugin: VerseMarkersPlugin): void {
  const { workspace } = plugin.app;
  const original = workspace.openLinkText.bind(workspace);

  workspace.openLinkText = async (
    linktext: string,
    sourcePath: string,
    newLeaf?: boolean,
    openViewState?: OpenViewState
  ): Promise<void> => {
    const allowShorthand = plugin.settings.enableShorthandSyntax;
    const fragment = verseFragmentOf(linktext, allowShorthand);
    if (fragment) {
      const hashIdx = linktext.indexOf("#");
      const filePart = linktext.slice(0, hashIdx);
      const file = plugin.app.metadataCache.getFirstLinkpathDest(
        filePart,
        sourcePath
      );
      if (file instanceof TFile) {
        const handled = await resolveVerseLink(
          plugin.app,
          file,
          fragment,
          allowShorthand,
          { newLeaf }
        );
        if (handled) return;
      }
    }
    return original(linktext, sourcePath, newLeaf, openViewState);
  };

  plugin.register(() => {
    workspace.openLinkText = original;
  });
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
  // arrives. The class only sets visibility:hidden, which still lays out so we
  // can measure it (styles live in CSS, not inline).
  popover.hoverEl.addClass("verse-hover-measuring");

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
  const previewData = segments
    ? await buildSegmentsPreviewMarkdown(
        plugin.app,
        file,
        segments,
        plugin.settings.hoverPreviewMaxVerses,
        plugin.settings.showFootnotesInPopovers,
        plugin.settings.showRomanParentInNestedVerses
      )
    : null;

  if (!isAlive()) return;

  const hoverEl = popover.hoverEl;
  const win = hoverEl.ownerDocument.defaultView ?? window;
  let frames = 0;
  while (!hoverEl.isConnected && isAlive() && frames++ < 60) {
    await new Promise<void>((resolve) =>
      win.requestAnimationFrame(() => resolve())
    );
  }
  if (!isAlive()) return;

  if (!segments || !previewData) {
    await renderVersePopoverNotFound(
      plugin,
      popover,
      hoverEl,
      file,
      fragment,
      sourcePath
    );
    revealVersePopover(popover, hoverEl);
    return;
  }

  const { markdown, sourceStart } = previewData;
  const fileContent = await plugin.app.vault.cachedRead(file);

  // Obsidian's class hierarchy, so themes style the popover like the native
  // page-preview: .markdown-embed > .markdown-embed-content > .markdown-rendered.
  hoverEl.empty();
  const embed = hoverEl.createDiv({ cls: "markdown-embed is-loaded" });
  const content = embed.createDiv({ cls: "markdown-embed-content" });
  const preview = content.createDiv({
    cls: "markdown-preview-view markdown-rendered",
  });

  await MarkdownRenderer.render(
    plugin.app,
    convertHighlightSyntaxToHtml(markdown),
    preview,
    file.path,
    popover
  );
  if (!isAlive()) return;

  styleVerseMarkers(preview, {
    fullText: fileContent,
    sourceStart,
    showRomanParentInNested: plugin.settings.showRomanParentInNestedVerses,
  });

  applyFootnotePreviewDisplay(preview, plugin.settings.showFootnotesInPopovers);

  wireVerseEmbedOpenLink(embed, () => {
    hidePopover(popover);
    void resolveVerseLink(plugin.app, file, fragment, allowShorthand);
  });

  wirePopoverAnchors(plugin, preview, popover, sourcePath);

  revealVersePopover(popover, hoverEl);
}

async function renderVersePopoverNotFound(
  plugin: VerseMarkersPlugin,
  popover: VerseHoverPopover,
  hoverEl: HTMLElement,
  file: TFile,
  fragment: string,
  sourcePath: string
): Promise<void> {
  hoverEl.empty();
  const embed = hoverEl.createDiv({ cls: "markdown-embed is-loaded" });
  await renderVersePreviewNotFound(
    plugin.app,
    embed,
    file,
    popover,
    fragment,
    "markdown-preview-view markdown-rendered"
  );
  wireVerseEmbedOpenLink(embed, () => {
    hidePopover(popover);
    void plugin.app.workspace.openLinkText(
      `${file.basename}#${fragment}`,
      sourcePath
    );
  });
}

/** Positions and reveals a verse hover popover after content (or an error) is ready. */
function revealVersePopover(
  popover: VerseHoverPopover,
  hoverEl: HTMLElement
): void {
  const targetEl = popover.__verseTargetEl ?? null;
  if (targetEl) positionVersePopover(hoverEl, targetEl);
  hoverEl.removeClass("verse-hover-measuring");
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
export interface ResolveVerseLinkOptions {
  newLeaf?: boolean;
}

function markdownViewForFile(
  app: App,
  leaf: WorkspaceLeaf,
  file: TFile
): MarkdownView | null {
  if (leaf.view instanceof MarkdownView && leaf.view.file === file) {
    return leaf.view;
  }
  const active = app.workspace.getActiveViewOfType(MarkdownView);
  if (active?.file === file) return active;
  return null;
}

function readingPreviewRoot(view: MarkdownView): HTMLElement {
  return (
    view.containerEl.querySelector<HTMLElement>(".markdown-preview-view") ??
    view.contentEl
  );
}

function verseAnchorIn(root: ParentNode, id: string): HTMLElement | null {
  try {
    return root.querySelector<HTMLElement>(`#${CSS.escape(id)}`);
  } catch {
    return root.querySelector<HTMLElement>(`#${id}`);
  }
}

function verseAnchorMounted(
  root: ParentNode,
  primaryId: string,
  fallbackId: string
): boolean {
  return (
    verseAnchorIn(root, primaryId) !== null ||
    verseAnchorIn(root, fallbackId) !== null
  );
}

export async function resolveVerseLink(
  app: App,
  file: TFile,
  fragment: string,
  allowShorthand: boolean = false,
  options?: ResolveVerseLinkOptions
): Promise<boolean> {
  const segments = parseVerseSegments(fragment, allowShorthand);
  if (!segments || segments.length === 0) return false;

  const startRef = segments[0].start;

  const activeMd = app.workspace.getActiveViewOfType(MarkdownView);
  const leaf = options?.newLeaf
    ? app.workspace.getLeaf(true)
    : activeMd?.leaf ?? app.workspace.getMostRecentLeaf();
  if (!leaf) return false;

  const content = await app.vault.cachedRead(file);

  const flashSegments: VerseSegment[] = segments.map((seg) => ({
    start: {
      ...seg.start,
      part: partHasAnchorByRef(content, seg.start) ? seg.start.part : null,
    },
    end: {
      ...seg.end,
      part: partHasAnchorByRef(content, seg.end) ? seg.end.part : null,
    },
  }));
  const navStart = flashSegments[0].start;

  const targetLine = findVerseLineByRef(content, navStart);
  const primaryId = verseRefToAnchorId(navStart);
  const firstPart = firstFragmentPartByRef(content, {
    ...navStart,
    part: null,
  });
  const fallbackId =
    navStart.part === null &&
    firstPart &&
    navStart.number !== null
      ? verseRefToAnchorId({ ...navStart, part: firstPart })
      : primaryId;

  // Decide whether we need a scroll-only jump after open. Reading-view
  // anchors that are already mounted get smoothScrollAnchorToCenter; cold
  // targets use applyScroll (scroll only — no native flash). Never pass
  // eState.line on openFile: Obsidian flashes the block when opening with it.
  const mdViewBefore = leaf.view instanceof MarkdownView ? leaf.view : null;
  const isLivePreviewBefore =
    mdViewBefore?.getMode() === "source" && mdViewBefore.file === file;
  const sameFileOpen = mdViewBefore?.file === file;
  const anchorAlreadyMounted =
    sameFileOpen &&
    !isLivePreviewBefore &&
    mdViewBefore !== null &&
    verseAnchorMounted(
      readingPreviewRoot(mdViewBefore),
      primaryId,
      fallbackId
    );
  const needForcedScroll = !anchorAlreadyMounted && targetLine !== null;

  setVerseHighlightActive(true);

  // Do not pass eState.line — Obsidian flashes the block when opening with it.
  await leaf.openFile(file);

  const mdView = markdownViewForFile(app, leaf, file);
  const isLivePreview = mdView?.getMode() === "source";

  if (needForcedScroll && targetLine !== null && mdView && isLivePreview) {
    const pos = { line: targetLine, ch: 0 };
    mdView.editor.setCursor(pos);
    scrollEditorWithoutFlash(mdView.editor, { from: pos, to: pos }, true);
  }

  if (isLivePreview && mdView) {
    // Live Preview: scroll the CM6 editor, then flash via decorations (not DOM
    // spans — those are destroyed on the next CM update). Double rAF so scroll
    // and openFile layout settle before we measure source ranges.
    const runFlash = (): void => {
      if (targetLine !== null) {
        const pos = { line: targetLine, ch: 0 };
        mdView.editor.setCursor(pos);
        scrollEditorWithoutFlash(mdView.editor, { from: pos, to: pos }, true);
      }
      flashVerseSegmentsInEditor(
        mdView.editor,
        mdView.editor.getValue(),
        flashSegments
      );
    };
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(runFlash);
    });
  } else if (mdView) {
    // Reading view: scope anchor lookup and flash to THIS preview pane only.
    // `getElementById` is document-wide and can match a hidden split leaf,
    // which makes scroll/flash appear to do nothing in the active pane.
    const previewRoot = readingPreviewRoot(mdView);

    if (targetLine !== null && needForcedScroll) {
      await scrollReadingViewToLine(mdView, targetLine);
    }

    let anchor =
      (await waitForElementById(
        primaryId,
        ANCHOR_WAIT_TIMEOUT_MS,
        previewRoot
      )) ?? verseAnchorIn(previewRoot, fallbackId);

    if (!anchor && targetLine !== null) {
      await scrollReadingViewToLine(mdView, targetLine);
      anchor =
        (await waitForElementById(
          primaryId,
          ANCHOR_WAIT_TIMEOUT_MS,
          previewRoot
        )) ?? verseAnchorIn(previewRoot, fallbackId);
    }

    if (anchor) {
      const scrollTarget = anchor;
      window.requestAnimationFrame(() => {
        if (previewRoot.contains(scrollTarget)) {
          smoothScrollAnchorToCenter(scrollTarget);
        }
      });
    }
    flashVerseSegments(flashSegments, previewRoot, content);
  }

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
  timeoutMs: number,
  root: ParentNode
): Promise<HTMLElement | null> {
  const existing = verseAnchorIn(root, id);
  if (existing) return Promise.resolve(existing);

  const rootNode = root as Node;
  const observeTarget = rootNode.instanceOf(Document)
    ? rootNode.body
    : (root as Element);

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
      const el = verseAnchorIn(root, id);
      if (el) finish(el);
    });
    observer.observe(observeTarget, { childList: true, subtree: true });

    const timer = window.setTimeout(() => {
      finish(verseAnchorIn(root, id));
    }, timeoutMs);
  });
}

/**
 * Flash lifecycle constants. Fade-out duration when the user dismisses.
 */
const FLASH_FADE_MS = 220;

/** Inline content that must not get its own flash wrap (keeps band height even). */
const FLASH_SKIP_INLINE = "h1,h2,h3,h4,h5,h6,.verse-editorial";

/** Tracks wrapped spans so dismiss can unwrap them. */
let activeFlashSpans: HTMLSpanElement[] = [];
let flashFadeTimer: number | null = null;

/** Removes the reading-view verse highlight (optional fade-out). */
export function clearReadingViewHighlight(fadeOut = true): void {
  if (flashFadeTimer !== null) {
    window.clearTimeout(flashFadeTimer);
    flashFadeTimer = null;
  }

  const spans = activeFlashSpans;
  if (spans.length === 0) return;

  if (!fadeOut) {
    unwrapFlashSpans();
    if (activeFlashSpans.length === 0) setVerseHighlightActive(false);
    return;
  }

  for (const s of spans) s.classList.remove("verse-flash-active");

  flashFadeTimer = window.setTimeout(() => {
    if (activeFlashSpans === spans) {
      unwrapFlashSpans();
      setVerseHighlightActive(false);
    }
    flashFadeTimer = null;
  }, FLASH_FADE_MS);
}

/**
 * Highlights in-range verse text in reading view via wrapped spans.
 */
function flashVerseSegments(
  segments: VerseSegment[],
  root: ParentNode,
  text: string
): void {
  const flashRanges = buildVerseFlashRanges(segments, root, text);
  if (flashRanges.length === 0) return;

  clearReadingViewHighlight(false);

  const spans: HTMLSpanElement[] = [];
  for (const fr of flashRanges) {
    const rangeSpans = wrapRangeWithSpans(fr.range, "verse-flash", fr.capEnd);
    if (rangeSpans.length > 0) {
      if (fr.capStart) rangeSpans[0].classList.add("verse-flash-start");
      if (fr.capEnd) {
        rangeSpans[rangeSpans.length - 1].classList.add("verse-flash-end");
      }
    }
    for (const span of rangeSpans) spans.push(span);
  }
  if (spans.length === 0) return;

  activeFlashSpans = spans;
  setVerseHighlightActive(true);

  window.requestAnimationFrame(() => {
    for (const s of spans) s.classList.add("verse-flash-active");
    notifyVerseHighlightShown();
  });
}

function wrapRangeWithSpans(
  range: Range,
  className: string,
  trimTrailingEnd = false
): HTMLSpanElement[] {
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
    const owner = t.parentElement;
    if (owner && owner.closest(FLASH_SKIP_INLINE)) continue;
    if (range.intersectsNode(t)) candidates.push(t);
  }

  if (trimTrailingEnd) {
    while (candidates.length > 0) {
      const last = candidates[candidates.length - 1];
      if (!last.nodeValue) {
        candidates.pop();
        continue;
      }
      if (!/\S/.test(last.nodeValue)) {
        candidates.pop();
        continue;
      }
      const trimmedLen = last.nodeValue.replace(/\s+$/, "").length;
      if (trimmedLen === 0) {
        candidates.pop();
        continue;
      }
      if (trimmedLen < last.nodeValue.length) {
        last.splitText(trimmedLen);
      }
      break;
    }
  }

  for (let i = 0; i < candidates.length; i++) {
    const node = candidates[i];
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

function collectInSegmentsAnchors(
  segments: VerseSegment[],
  root: ParentNode,
  text: string
): HTMLElement[] {
  const all = root.querySelectorAll<HTMLElement>('[id^="verse-"]');
  const inRange: HTMLElement[] = [];
  for (let i = 0; i < all.length; i++) {
    const el = all[i];
    const ref = parseVerseRefEndpoint(el.id.slice("verse-".length));
    if (!ref) continue;
    if (segments.some((seg) => anchorRefIsInSegment(text, ref, seg))) {
      inRange.push(el);
    }
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
  includeHeadings: boolean,
  root: ParentNode
): Element | null {
  const selectors = includeHeadings
    ? [...FLASH_STOP_FOOTNOTE_SELECTORS, ...FLASH_STOP_HEADING_SELECTORS]
    : FLASH_STOP_FOOTNOTE_SELECTORS;
  const candidates = root.querySelectorAll<HTMLElement>(selectors.join(","));
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
function buildVerseFlashRanges(
  segments: VerseSegment[],
  root: ParentNode,
  text: string
): FlashRange[] {
  const inRange = collectInSegmentsAnchors(segments, root, text);
  if (inRange.length === 0) return [];

  const allValidAnchors: HTMLElement[] = [];
  const all = root.querySelectorAll<HTMLElement>('[id^="verse-"]');
  for (let i = 0; i < all.length; i++) {
    const ref = parseVerseRefEndpoint(all[i].id.slice("verse-".length));
    if (ref) allValidAnchors.push(all[i]);
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
      const stop = findFlashStopBetween(
        anchor,
        next ?? null,
        includeHeadings,
        root
      );
      if (stop) {
        range.setEndBefore(stop);
      } else if (next) {
        range.setEndBefore(next);
      } else {
        const last = (root as Node).instanceOf(Element)
          ? (root as Element).lastElementChild ?? root.lastChild
          : root.lastChild;
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
