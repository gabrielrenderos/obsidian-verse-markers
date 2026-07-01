// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2025 Gabriel Renderos

/**
 * commands.ts
 * "Copy verse reference" and "Copy verse range reference" commands.
 */

import { Editor, Notice } from "obsidian";
import {
  nearestVerseRefAtOffset,
  verseRefToLabel,
  verseRefsInSelection,
} from "./detection";
import type VerseMarkersPlugin from "./main";

/**
 * Registers both verse-reference commands on the plugin.
 */
export function registerCommands(plugin: VerseMarkersPlugin): void {
  plugin.addCommand({
    id: "copy-verse-reference",
    name: "Copy verse reference",
    editorCallback(editor: Editor) {
      const cursor = editor.getCursor();
      const fullText = editor.getValue();

      const lines = fullText.split("\n");
      let offset = 0;
      for (let i = 0; i < cursor.line; i++) {
        offset += lines[i].length + 1;
      }
      offset += cursor.ch;

      const ref = nearestVerseRefAtOffset(fullText, offset);
      if (ref === null) {
        new Notice("No verse marker found near cursor.");
        return;
      }

      const fileName = plugin.app.workspace.getActiveFile()?.basename ?? "";
      const label = verseRefToLabel(ref);
      const link = `[[${fileName}#verse-${label}]]`;
      void navigator.clipboard.writeText(link).then(() => {
        new Notice(`Copied: ${link}`);
      });
    },
  });

  plugin.addCommand({
    id: "copy-verse-range-reference",
    name: "Copy verse range reference",
    editorCallback(editor: Editor) {
      const fullText = editor.getValue();
      const from = editor.getCursor("from");
      const to = editor.getCursor("to");

      if (from.line === to.line && from.ch === to.ch) {
        new Notice("Select a range spanning at least two verse markers.");
        return;
      }

      const lines = fullText.split("\n");
      const toOffset = (pos: { line: number; ch: number }): number => {
        let off = 0;
        for (let i = 0; i < pos.line; i++) off += lines[i].length + 1;
        return off + pos.ch;
      };

      const selFrom = toOffset(from);
      const selTo = toOffset(to);
      const refs = verseRefsInSelection(fullText, selFrom, selTo);

      if (refs.length < 2) {
        new Notice("Selection must span at least two verse markers.");
        return;
      }

      const fileName = plugin.app.workspace.getActiveFile()?.basename ?? "";
      const first = verseRefToLabel(refs[0]);
      const last = verseRefToLabel(refs[refs.length - 1]);
      const link = `[[${fileName}#verse-${first}:${last}]]`;
      void navigator.clipboard.writeText(link).then(() => {
        new Notice(`Copied: ${link}`);
      });
    },
  });
}
