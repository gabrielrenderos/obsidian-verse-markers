// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2025 Gabriel Renderos

import { App, PluginSettingTab, Setting } from "obsidian";
import { refreshAllVerseEmbeds } from "./embeds";
import type VerseMarkersPlugin from "./main";

export interface VerseMarkersSettings {
  enableHoverPreviews: boolean;
  hoverPreviewMaxVerses: number;
  /**
   * When true, the plugin ALSO recognizes shorthand references like
   * [[File#3]] and [[File#3:7]]. Off by default because it can conflict
   * with real headings that happen to be numeric. See detection.ts.
   */
  enableShorthandSyntax: boolean;
  /**
   * When true, the post-navigation verse highlight stays until the user
   * clicks elsewhere. When false (default), it auto-fades after a few seconds.
   */
  keepHighlightUntilClick: boolean;
  /** Append footnote definitions to verse hover popovers. */
  showFootnotesInPopovers: boolean;
  /** Append footnote definitions to verse embeds. */
  showFootnotesInEmbeds: boolean;
}

export const DEFAULT_SETTINGS: VerseMarkersSettings = {
  enableHoverPreviews: true,
  hoverPreviewMaxVerses: 20,
  enableShorthandSyntax: false,
  keepHighlightUntilClick: false,
  showFootnotesInPopovers: true,
  showFootnotesInEmbeds: true,
};

export class VerseMarkersSettingTab extends PluginSettingTab {
  plugin: VerseMarkersPlugin;

  constructor(app: App, plugin: VerseMarkersPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl).setName("Reference syntax").setHeading();

    // Syntax reference block (visible to users in the settings pane)
    const syntaxEl = containerEl.createEl("div", {
      cls: "setting-item-description verse-markers-syntax-ref",
    });
    syntaxEl.createEl("strong", { text: "Reference syntax:" });
    syntaxEl.createEl("br");
    syntaxEl.appendText(
      "Default — [[File#verse-3]], [[File#verse-3a]] / [[File#verse-3b]] (heading-split parts), [[File#verse-3:7]] (range)"
    );
    syntaxEl.createEl("br");
    syntaxEl.appendText(
      "Shorthand (opt-in below) — [[File#3]] / [[File#3a]] / [[File#3:7]]"
    );

    new Setting(containerEl)
      .setName("Enable range hover previews")
      .setDesc("Show a popover with verse content when hovering over [[FILE#verse-N:M]] links.")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.enableHoverPreviews)
          .onChange(async (value) => {
            this.plugin.settings.enableHoverPreviews = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Enable shorthand reference syntax")
      .setDesc(
        "Recognize [[File#3]] and [[File#3:7]] in addition to the default [[File#verse-3]] form. " +
        "Warning: enabling this will intercept links to headings literally named \"3\" or \"3:7\"."
      )
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.enableShorthandSyntax)
          .onChange(async (value) => {
            this.plugin.settings.enableShorthandSyntax = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl).setName("Navigation highlight").setHeading();

    new Setting(containerEl)
      .setName("Keep temporary highlight until click")
      .setDesc(
        "When off (default), the verse highlight after navigation fades automatically after a few seconds. " +
          "When on, it stays visible until you click elsewhere."
      )
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.keepHighlightUntilClick)
          .onChange(async (value) => {
            this.plugin.settings.keepHighlightUntilClick = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Max verses in hover preview")
      .setDesc("Maximum number of verses to display in a range hover preview.")
      .addText((text) =>
        text
          .setPlaceholder("20")
          .setValue(String(this.plugin.settings.hoverPreviewMaxVerses))
          .onChange(async (value) => {
            const num = parseInt(value, 10);
            if (!isNaN(num) && num > 0) {
              this.plugin.settings.hoverPreviewMaxVerses = num;
              await this.plugin.saveSettings();
            }
          })
      );

    new Setting(containerEl).setName("Show footnotes").setHeading();

    new Setting(containerEl)
      .setName("Show footnotes in popovers")
      .setDesc(
        "Show the footnote list at the bottom of hover previews. Footnote references in the verse text stay hoverable either way."
      )
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.showFootnotesInPopovers)
          .onChange(async (value) => {
            this.plugin.settings.showFootnotesInPopovers = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Show footnotes in embeds")
      .setDesc(
        "Show footnote references and the footnote list in verse embeds. When off, no footnote content appears in embeds."
      )
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.showFootnotesInEmbeds)
          .onChange(async (value) => {
            this.plugin.settings.showFootnotesInEmbeds = value;
            await this.plugin.saveSettings();
            refreshAllVerseEmbeds();
          })
      );
  }
}
