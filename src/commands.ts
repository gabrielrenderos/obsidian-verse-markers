/**
 * commands.ts
 * "Copy verse reference" and "Copy verse range reference" commands.
 */

import { Editor, Notice } from "obsidian";
import { getVerseRegex } from "./detection";
import type VerseMarkersPlugin from "./main";

/**
 * Returns the verse number of the marker nearest to the given cursor offset
 * within the full document text, or null if none found.
 */
function nearestVerseAtOffset(text: string, cursorOffset: number): number | null {
  const re = getVerseRegex();
  let match: RegExpExecArray | null;
  let bestNum: number | null = null;
  let bestDist = Infinity;

  while ((match = re.exec(text)) !== null) {
    const start = match.index;
    const end = start + match[0].length;
    const dist = Math.min(Math.abs(cursorOffset - start), Math.abs(cursorOffset - end));
    if (dist < bestDist) {
      bestDist = dist;
      bestNum = parseInt(match[0].slice(1, -1), 10);
    }
  }

  return bestNum;
}

/**
 * Returns the first and last verse numbers found within the selected text range,
 * or null if fewer than two distinct markers exist.
 */
function verseRangeInSelection(
  text: string,
  selFrom: number,
  selTo: number
): { first: number; last: number } | null {
  const slice = text.slice(selFrom, selTo);
  const re = getVerseRegex();
  const found: number[] = [];
  let match: RegExpExecArray | null;

  while ((match = re.exec(slice)) !== null) {
    found.push(parseInt(match[0].slice(1, -1), 10));
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
      navigator.clipboard.writeText(ref).then(() => {
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
      navigator.clipboard.writeText(ref).then(() => {
        new Notice(`Copied: ${ref}`);
      });
    },
  });
}
