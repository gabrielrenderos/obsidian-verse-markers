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
import { versePostProcessor } from "./postprocessor";
import { registerCommands } from "./commands";
import { resolveVerseLink, registerVerseLinkNavigation, registerVersePagePreview } from "./references";
import { registerVerseEmbeds } from "./embeds";
import { verseFlashExtension, clearActiveLivePreviewFlash } from "./flashLivePreview";
import { verseMarkerLivePreviewExtension } from "./livePreview";
import {
  registerVerseHighlightDismiss,
  onVerseHighlightDismiss,
  configureVerseHighlightBehavior,
} from "./highlightDismiss";
import { registerNativeFlashPrevention } from "./nativeFlash";
import { clearReadingViewHighlight } from "./references";
import {
  VerseMarkersSettings,
  DEFAULT_SETTINGS,
  VerseMarkersSettingTab,
} from "./settings";

export default class VerseMarkersPlugin extends Plugin {
  settings!: VerseMarkersSettings;

  async onload(): Promise<void> {
    await this.loadSettings();

    // Settings tab
    this.addSettingTab(new VerseMarkersSettingTab(this.app, this));

    // Live Preview: one CM6 wrapper per ==highlight== interior so theme chrome
    // (incl. dotted underlines) stays continuous across [N] markers.
    this.registerEditorExtension([
      verseMarkerLivePreviewExtension(),
      verseFlashExtension(),
    ]);

    // Reading view post-processor: rewrites [N] text → spans, injects
    // part-b/c/… continuation anchors for heading-split verses.
    this.registerMarkdownPostProcessor((el, ctx) => {
      versePostProcessor(el, ctx);
    });

    // Hover previews: intercept the core "Page preview" plugin so verse
    // fragments render through Obsidian's own HoverPopover, with native
    // nesting/keep-alive in every context (see references.ts).
    registerVersePagePreview(this);

    // Live Preview: verse-fragment clicks go through our navigator + CM6 flash.
    registerVerseLinkNavigation(this);

    // Verse navigation highlight: timed fade (default) or keep until click.
    configureVerseHighlightBehavior(() => this.settings);
    registerVerseHighlightDismiss(this);
    onVerseHighlightDismiss(() => clearReadingViewHighlight());
    onVerseHighlightDismiss(() => clearActiveLivePreviewFlash());

    // Verse links scroll without Obsidian's native is-flashing block highlight.
    registerNativeFlashPrevention(this);

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

  async loadSettings(): Promise<void> {
    const data = (await this.loadData()) as Partial<VerseMarkersSettings> | null;
    this.settings = Object.assign({}, DEFAULT_SETTINGS, data ?? {});
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }
}
