// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2025 Gabriel Renderos

/**
 * Verse Markers — plugin entry point.
 *
 * REFERENCE SYNTAX:
 *   Default (always on):
 *     [[File#verse-3]]          whole verse
 *     [[File#verse-3a]]         first heading-split part of verse 3
 *     [[File#verse-3b]]         second part (and c, d, … for further splits)
 *     [[File#verse-3:7]]        range (verses 3..7; whole verses only)
 *
 *   Shorthand (opt-in via settings.enableShorthandSyntax):
 *     [[File#3]] [[File#3a]] [[File#3b]] [[File#3:7]]
 *
 * Copy-reference commands always emit the EXPLICIT form regardless of the
 * shorthand toggle, so generated refs remain collision-safe.
 * Multi-line verses and heading-split verses are supported natively — see
 * detection.ts for the canonical contract.
 */
import { Plugin, TFile } from "obsidian";
import { versePostProcessor, collectVerseAnchors } from "./postprocessor";
import { registerCommands } from "./commands";
import { resolveVerseLink, registerVersePagePreview } from "./references";
import { registerVerseEmbeds } from "./embeds";
import { verseMarkerLivePreviewExtension } from "./livePreview";
import {
  VerseMarkersSettings,
  DEFAULT_SETTINGS,
  VerseMarkersSettingTab,
} from "./settings";

export default class VerseMarkersPlugin extends Plugin {
  settings!: VerseMarkersSettings;

  /** Disposers for hover-preview listeners attached to rendered anchors. */
  private hoverDisposers: Array<() => void> = [];

  async onload(): Promise<void> {
    await this.loadSettings();

    // Settings tab
    this.addSettingTab(new VerseMarkersSettingTab(this.app, this));

    // Live Preview: one CM6 wrapper per ==highlight== interior so theme chrome
    // (incl. dotted underlines) stays continuous across [N] markers.
    this.registerEditorExtension(verseMarkerLivePreviewExtension());

    // Reading view post-processor: rewrites [N] text → spans, injects
    // part-b/c/… continuation anchors for heading-split verses, and wires
    // click navigation on verse-fragment links.
    this.registerMarkdownPostProcessor((el, ctx) => {
      versePostProcessor(el, ctx);
      this.wireVerseAnchors(el);
    });

    // Hover previews: intercept the core "Page preview" plugin so verse
    // fragments render through Obsidian's own HoverPopover, with native
    // nesting/keep-alive in every context (see references.ts).
    registerVersePagePreview(this);

    // Native embed support: ![[File#verse-3:7]] in Reading view AND Live
    // Preview, by wrapping the markdown embed creator (see embeds.ts).
    registerVerseEmbeds(this);

    // Commands
    registerCommands(this);

    // Handle obsidian://verse-markers?file=...&verse=N (&part=a) links.
    // We use our own action name because Obsidian owns the "open" action.
    this.registerObsidianProtocolHandler("verse-markers", async (params) => {
      const verse = params["verse"];
      const filePath = params["file"];
      if (!verse || !filePath) return;

      const file = this.app.vault.getAbstractFileByPath(filePath);
      if (!(file instanceof TFile)) return;

      // Accept a numeric verse ("5") or one carrying an authored part ("5a"),
      // plus an optional separate &part= for the plain-number form.
      const vm = /^(\d+)([a-z]*)$/.exec(verse);
      if (!vm) return;
      const verseNum = parseInt(vm[1], 10);
      const part = vm[2] || params["part"] || "";
      const fragment = part ? `verse-${verseNum}${part}` : `verse-${verseNum}`;
      await resolveVerseLink(this.app, file, fragment);
    });
  }

  onunload(): void {
    for (const dispose of this.hoverDisposers) dispose();
    this.hoverDisposers = [];
  }

  async loadSettings(): Promise<void> {
    const data = (await this.loadData()) as Partial<VerseMarkersSettings> | null;
    this.settings = Object.assign({}, DEFAULT_SETTINGS, data ?? {});
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  /**
   * For each rendered anchor whose fragment is verse-N or verse-N:M, attach a
   * click handler that invokes our verse-aware navigator. Hover previews are
   * handled separately by the page-preview hook (registerVersePagePreview).
   */
  private wireVerseAnchors(el: HTMLElement): void {
    // Our own hover popovers render their content through MarkdownRenderer,
    // which re-runs this post-processor on the popover body. Those anchors are
    // already wired (click + nested hover) by references.ts; wiring them again
    // here would stack a duplicate click handler. Skip popover content.
    if (el.closest(".verse-hover-preview")) return;

    const allowShorthand = this.settings.enableShorthandSyntax;

    const anchors = collectVerseAnchors(el, allowShorthand);
    for (const a of anchors) {
      const href = a.getAttribute("data-href") ?? a.getAttribute("href") ?? "";
      const hashIdx = href.indexOf("#");
      if (hashIdx === -1) continue;
      const filePart = href.slice(0, hashIdx);
      const fragment = href.slice(hashIdx + 1);

      // Click: resolve verse fragments ourselves so scrolling works even
      // when Obsidian's heading resolver doesn't know about verse-N.
      // stopPropagation prevents Obsidian's document-level link handler
      // from also opening the link with its default scroll-to-heading
      // logic — on mobile that race could overwrite our scroll target.
      const onClick = (ev: MouseEvent): void => {
        const file = this.app.metadataCache.getFirstLinkpathDest(filePart, "");
        if (!(file instanceof TFile)) return;
        ev.preventDefault();
        ev.stopPropagation();
        void resolveVerseLink(this.app, file, fragment, allowShorthand);
      };
      a.addEventListener("click", onClick);
      this.hoverDisposers.push(() => a.removeEventListener("click", onClick));
    }
  }
}
