// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2025 Gabriel Renderos

/**
 * embeds.ts
 * Native-embed support for verse fragments: ![[File#verse-3:7]].
 *
 * Obsidian's built-in transclusion can only resolve a fragment that names a
 * real heading (#Heading) or block (#^id). Our verse anchors (verse-3, verse-
 * 3:7, verse-4:6/8:10, …) are synthetic spans injected at render time, so the
 * core resolver can't find them and renders an empty embed.
 *
 * We hook the SAME pipeline Obsidian's own embeds use — the embed registry —
 * by wrapping the markdown ("md") embed creator. For a verse fragment we render
 * the verse content ourselves (reusing the hover-preview content builder);
 * for everything else we delegate to the original creator untouched. Because
 * both Reading view and Live Preview create embeds through this registry, the
 * single wrapper covers both views.
 *
 * NOTE: `app.embedRegistry` is a non-public Obsidian API. We access it
 * defensively: if it (or the original "md" creator) is missing, we simply skip
 * registration and leave native embeds exactly as they were.
 */

import { App, Component, MarkdownRenderer, TFile, setIcon } from "obsidian";
import { parseVerseSegments } from "./detection";
import { buildSegmentsPreviewMarkdown, resolveVerseLink } from "./references";
import { styleVerseMarkers } from "./postprocessor";
import { convertHighlightSyntaxToHtml } from "./highlights";
import type VerseMarkersPlugin from "./main";

const verseEmbedInstances = new Set<VerseEmbed>();

/** Re-render every verse embed on the current page (e.g. after settings change). */
export function refreshAllVerseEmbeds(): void {
  for (const embed of verseEmbedInstances) {
    void embed.reload();
  }
}

/** Minimal shape of the context Obsidian passes to an embed creator. */
interface EmbedContext {
  app: App;
  containerEl: HTMLElement;
  sourcePath?: string;
  linktext?: string;
  depth?: number;
  displayMode?: boolean;
}

/** An embed component is a Component that Obsidian can ask to (re)load. */
type EmbedComponent = Component & {
  loadFile?: (file?: TFile) => unknown;
};

/** Factory Obsidian calls to build an embed for a file + subpath. */
type EmbedCreator = (
  ctx: EmbedContext,
  file: TFile,
  subpath: string
) => EmbedComponent;

/**
 * The non-public registry that maps a file extension to its embed creator.
 * We override by assigning `embedByExtension["md"]` directly: the public
 * `registerExtension` THROWS when an extension is already registered (and the
 * core always registers "md"), so calling it here would abort plugin load.
 */
interface EmbedRegistry {
  embedByExtension: Record<string, EmbedCreator | undefined>;
}

/**
 * Wraps each top-level block of a freshly-rendered markdown container in a
 * `div.el-<tagname>` element, mirroring how Obsidian's reading view structures
 * a document (`div.el-blockquote > blockquote`, `div.el-h3 > h3`, …). These
 * wrappers carry the block-spacing rules, so reproducing them makes embedded
 * content lay out identically to the live note for every block type.
 */
function wrapAsDocumentBlocks(preview: HTMLElement): void {
  const doc = preview.ownerDocument;
  for (const child of Array.from(preview.children)) {
    const wrapper = doc.createElement("div");
    wrapper.className = `el-${child.tagName.toLowerCase()}`;
    preview.insertBefore(wrapper, child);
    wrapper.appendChild(child);
  }
}

/**
 * Renders a verse fragment inside a native embed container. Built to look like
 * Obsidian's own markdown embed card (border, corner "open" link) so themes
 * style it for free; the verse markdown is rendered through Obsidian's renderer
 * so our reading-view post-processor styles the `[N]` markers and wires hovers
 * exactly as it does in the page body.
 */
class VerseEmbed extends Component {
  private renderToken = 0;

  constructor(
    private readonly plugin: VerseMarkersPlugin,
    private readonly ctx: EmbedContext,
    private readonly file: TFile,
    private readonly fragment: string
  ) {
    super();
  }

  onload(): void {
    verseEmbedInstances.add(this);
    this.register(() => verseEmbedInstances.delete(this));
    void this.render();
  }

  /** Re-render after settings change or source file update. */
  async reload(): Promise<void> {
    await this.render();
  }

  /** Obsidian calls this to (re)render when the source file changes. */
  async loadFile(): Promise<void> {
    await this.render();
  }

  private async render(): Promise<void> {
    const myToken = ++this.renderToken;
    const allowShorthand = this.plugin.settings.enableShorthandSyntax;

    const segments = parseVerseSegments(this.fragment, allowShorthand);
    let markdown: string | null = null;
    if (segments) {
      markdown = await buildSegmentsPreviewMarkdown(
        this.plugin.app,
        this.file,
        segments,
        this.plugin.settings.hoverPreviewMaxVerses,
        this.plugin.settings.showFootnotesInEmbeds
      );
    }

    // A newer render superseded this one while we were reading the file.
    if (myToken !== this.renderToken) return;

    const container = this.ctx.containerEl;
    container.empty();
    container.removeClass("verse-embed-empty");
    container.addClasses(["markdown-embed", "is-loaded", "verse-embed"]);

    // Title row: always the file name (no extension). We reuse Obsidian's own
    // native embed-title classes (`embed-title markdown-embed-title`) so it
    // matches a whole-file embed title exactly — the `embed-title` class is the
    // one that carries the bold weight, and using both means any theme that
    // restyles them restyles ours identically. Link display text after "|" is
    // intentionally ignored.
    container.createDiv({
      cls: "embed-title markdown-embed-title",
      text: this.file.basename,
    });

    if (!markdown) {
      container.addClass("verse-embed-empty");
      container.createDiv({
        cls: "markdown-embed-content",
        text: `Couldn't find "${this.fragment}"`,
      });
      return;
    }

    const content = container.createDiv({ cls: "markdown-embed-content" });

    // Render ATTACHED, straight into the card. We previously rendered into a
    // detached element so the page post-processor would style the [N] markers
    // (it skips `.internal-embed`), but detached rendering breaks footnotes:
    // their refs/definitions and click-to-scroll only wire up correctly inside
    // the live document tree. So we render attached (footnotes work, exactly
    // like the hover popover) and style the markers ourselves below.
    // NOTE: only `markdown-rendered` here — deliberately NOT
    // `markdown-preview-view`. That class is the full document-pane preview
    // class, and Obsidian gives it context-dependent horizontal padding that
    // differs between reading view and Live Preview (the source of the uneven
    // left gap). `markdown-rendered` alone styles the content the same in both.
    const preview = content.createDiv({
      cls: "markdown-rendered verse-embed-preview",
    });
    await MarkdownRenderer.render(
      this.plugin.app,
      convertHighlightSyntaxToHtml(markdown),
      preview,
      this.file.path,
      this
    );
    if (myToken !== this.renderToken) return;

    // The page post-processor skipped the [N] markers here (this card is an
    // `.internal-embed`), so style them ourselves — this variant doesn't skip
    // embed containers. Verse-link hovers are still wired by the page
    // post-processor's anchor pass, which DOES run inside embeds.
    styleVerseMarkers(preview);

    wrapAsDocumentBlocks(preview);

    // Corner "open" affordance, mirroring Obsidian's native embed chrome.
    const link = container.createEl("a", {
      cls: "markdown-embed-link",
      attr: { "aria-label": "Open link" },
    });
    setIcon(link, "lucide-maximize-2");
    link.addEventListener("click", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      void resolveVerseLink(
        this.plugin.app,
        this.file,
        this.fragment,
        allowShorthand
      );
    });
  }
}

/**
 * Wraps the markdown embed creator so verse fragments render through our
 * VerseEmbed and everything else falls through to Obsidian's native creator.
 * Restores the original creator on plugin unload. No-op if the non-public
 * embed registry isn't available.
 */
export function registerVerseEmbeds(plugin: VerseMarkersPlugin): void {
  // Wrapped defensively: this touches a non-public API, and must NEVER throw
  // out of onload (a throw here would abort the whole plugin, including the
  // reading-view marker post-processor).
  try {
    const registry = (
      plugin.app as unknown as { embedRegistry?: EmbedRegistry }
    ).embedRegistry;
    if (!registry || typeof registry.embedByExtension !== "object") return;

    const original = registry.embedByExtension["md"];
    // Without a creator to delegate to we'd break normal note embeds — bail.
    if (typeof original !== "function") return;

    const creator: EmbedCreator = (ctx, file, subpath) => {
      const fragment = (subpath ?? "").replace(/^#/, "");
      if (fragment) {
        const segments = parseVerseSegments(
          fragment,
          plugin.settings.enableShorthandSyntax
        );
        if (segments) return new VerseEmbed(plugin, ctx, file, fragment);
      }
      return original(ctx, file, subpath);
    };

    // Override by direct assignment (registerExtension would throw on the
    // already-registered "md"). Restore the original creator on unload.
    registry.embedByExtension["md"] = creator;
    plugin.register(() => {
      registry.embedByExtension["md"] = original;
    });
  } catch {
    // Embed support is best-effort; everything else keeps working.
  }
}
