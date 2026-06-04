// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2025 Gabriel Renderos

/**
 * commands.ts
 * "Copy verse reference" and "Copy verse range reference" commands.
 */

import { Editor, Notice } from "obsidian";
import { execVerseMarker, getVerseRegex, parseMarkerToken } from "./detection";
import type VerseMarkersPlugin from "./main";

/** Renders a marker token's value as a reference label ("5" or "5a"). */
function markerLabel(token: string): string {
  const { number, part } = parseMarkerToken(token);
  return `${number}${part ?? ""}`;
}

/**
 * Returns the label of the verse marker nearest to the given cursor offset
 * within the full document text ("5" or, for an authored part, "5a"), or null
 * if none found.
 */
function nearestVerseAtOffset(text: string, cursorOffset: number): string | null {
  const re = getVerseRegex();
  let match: RegExpExecArray | null;
  let best: string | null = null;
  let bestDist = Infinity;

  while ((match = execVerseMarker(re, text)) !== null) {
    const start = match.index;
    const end = start + match[0].length;
    const dist = Math.min(Math.abs(cursorOffset - start), Math.abs(cursorOffset - end));
    if (dist < bestDist) {
      bestDist = dist;
      best = markerLabel(match[0]);
    }
  }

  return best;
}

/**
 * Returns the first and last verse marker labels found within the selected
 * text range ("5"/"5a"), or null if fewer than two markers exist.
 */
function verseRangeInSelection(
  text: string,
  selFrom: number,
  selTo: number
): { first: string; last: string } | null {
  const slice = text.slice(selFrom, selTo);
  const re = getVerseRegex();
  const found: string[] = [];
  let match: RegExpExecArray | null;

  while ((match = execVerseMarker(re, slice)) !== null) {
    found.push(markerLabel(match[0]));
  }

  if (found.length < 2) return null;
  return { first: found[0], last: found[found.length - 1] };
}

/**
 * Registers both verse-reference commands on the plugin.
 */
export function registerCommands(plugin: VerseMarkersPlugin): void {
  // -----------------------------------------------------------------------
  // Command 1: Copy verse reference  →  [[FILE#verse-N]]
  // -----------------------------------------------------------------------
  plugin.addCommand({
    id: "copy-verse-reference",
    name: "Copy verse reference",
    editorCallback(editor: Editor) {
      const cursor = editor.getCursor();
      const fullText = editor.getValue();

      // Convert cursor position to a character offset
      const lines = fullText.split("\n");
      let offset = 0;
      for (let i = 0; i < cursor.line; i++) {
        offset += lines[i].length + 1; // +1 for the newline
      }
      offset += cursor.ch;

      const verseNum = nearestVerseAtOffset(fullText, offset);
      if (verseNum === null) {
        new Notice("No verse marker found near cursor.");
        return;
      }

      const fileName = plugin.app.workspace.getActiveFile()?.basename ?? "";
      const ref = `[[${fileName}#verse-${verseNum}]]`;
      void navigator.clipboard.writeText(ref).then(() => {
        new Notice(`Copied: ${ref}`);
      });
    },
  });

  // -----------------------------------------------------------------------
  // Command 2: Copy verse range reference  →  [[FILE#verse-N:M]]
  // -----------------------------------------------------------------------
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

      // Convert line/ch positions to offsets
      const lines = fullText.split("\n");
      const toOffset = (pos: { line: number; ch: number }): number => {
        let off = 0;
        for (let i = 0; i < pos.line; i++) off += lines[i].length + 1;
        return off + pos.ch;
      };

      const selFrom = toOffset(from);
      const selTo = toOffset(to);
      const range = verseRangeInSelection(fullText, selFrom, selTo);

      if (!range) {
        new Notice("Selection must span at least two verse markers.");
        return;
      }

      const fileName = plugin.app.workspace.getActiveFile()?.basename ?? "";
      const ref = `[[${fileName}#verse-${range.first}:${range.last}]]`;
      void navigator.clipboard.writeText(ref).then(() => {
        new Notice(`Copied: ${ref}`);
      });
    },
  });
}
