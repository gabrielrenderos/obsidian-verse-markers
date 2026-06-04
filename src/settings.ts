// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2025 Gabriel Renderos

import { App, PluginSettingTab, Setting } from "obsidian";
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
}

export const DEFAULT_SETTINGS: VerseMarkersSettings = {
  enableHoverPreviews: true,
  hoverPreviewMaxVerses: 20,
  enableShorthandSyntax: false,
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
  }
}
