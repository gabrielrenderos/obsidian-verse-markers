// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2025 Gabriel Renderos

/**
 * highlights.ts
 * Converts Obsidian ==highlight== syntax to <mark> for programmatic renders
 * (popover/embed), and locates highlight spans for Live Preview decorations.
 */

/** ATX-style heading line (matches detection.ts). */
const HEADING_LINE_REGEX = /^\s*#{1,6}\s+\S.*$/;

function stripBlockquoteMarker(line: string): string {
  return line.replace(/^\s*>\s?/, "");
}

/** Inner content boundaries of a highlight (after opening ==, before closing ==). */
export interface HighlightRange {
  start: number;
  end: number;
}

/**
 * Finds every ==highlight== region in `text`. Ranges are half-open
 * [start, end) covering the highlighted content only (delimiters excluded).
 * Respects paragraph boundaries, code fences, inline code, and \\== escapes.
 */
export function findHighlightRanges(
  text: string,
  baseOffset = 0
): HighlightRange[] {
  const ranges: HighlightRange[] = [];
  let paraLines: string[] = [];
  let paraStart = 0;
  let cursor = 0;
  let inFence = false;

  const flushPara = (): void => {
    if (paraLines.length === 0) return;
    const para = paraLines.join("\n");
    findHighlightPairsInParagraph(para, baseOffset + paraStart, ranges);
    paraLines = [];
  };

  for (const line of text.split("\n")) {
    const lineStart = cursor;
    cursor += line.length + 1;

    if (line.trimStart().startsWith("```")) {
      flushPara();
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;

    const stripped = stripBlockquoteMarker(line);
    if (/^\s*$/.test(stripped) || HEADING_LINE_REGEX.test(stripped)) {
      flushPara();
      continue;
    }

    if (paraLines.length === 0) paraStart = lineStart;
    paraLines.push(line);
  }
  flushPara();
  return ranges;
}

function findHighlightPairsInParagraph(
  paragraph: string,
  baseOffset: number,
  out: HighlightRange[]
): void {
  let inInlineCode = false;
  let i = 0;
  while (i < paragraph.length) {
    if (paragraph[i] === "`") {
      inInlineCode = !inInlineCode;
      i++;
      continue;
    }
    if (!inInlineCode && paragraph.slice(i, i + 2) === "==") {
      if (i > 0 && paragraph[i - 1] === "\\") {
        i += 2;
        continue;
      }
      const innerStart = i + 2;
      const close = findClosingHighlight(paragraph, innerStart, inInlineCode);
      if (close !== -1) {
        out.push({ start: baseOffset + innerStart, end: baseOffset + close });
        i = close + 2;
        continue;
      }
    }
    i++;
  }
}

function findClosingHighlight(
  paragraph: string,
  from: number,
  startInCode: boolean
): number {
  let inInlineCode = startInCode;
  let i = from;
  while (i < paragraph.length) {
    if (paragraph[i] === "`") {
      inInlineCode = !inInlineCode;
      i++;
      continue;
    }
    if (!inInlineCode && paragraph.slice(i, i + 2) === "==") {
      if (i > from && paragraph[i - 1] === "\\") {
        i += 2;
        continue;
      }
      return i;
    }
    i++;
  }
  return -1;
}

/**
 * Replaces balanced ==highlight== pairs with <mark>…</mark> so
 * MarkdownRenderer output matches reading-view highlight styling.
 * Popover/embed renders do not always parse == via MarkdownRenderer alone.
 */
export function convertHighlightSyntaxToHtml(text: string): string {
  const out: string[] = [];
  let paraLines: string[] = [];
  let inFence = false;

  const flushPara = (): void => {
    if (paraLines.length > 0) {
      out.push(convertHighlightInParagraph(paraLines.join("\n")));
      paraLines = [];
    }
  };

  for (const line of text.split("\n")) {
    if (line.trimStart().startsWith("```")) {
      flushPara();
      inFence = !inFence;
      out.push(line);
      continue;
    }
    if (inFence) {
      out.push(line);
      continue;
    }

    const stripped = stripBlockquoteMarker(line);
    if (/^\s*$/.test(stripped) || HEADING_LINE_REGEX.test(stripped)) {
      flushPara();
      out.push(line);
      continue;
    }
    paraLines.push(line);
  }
  flushPara();
  return out.join("\n");
}

function convertHighlightInParagraph(paragraph: string): string {
  let result = "";
  let inInlineCode = false;
  let i = 0;

  while (i < paragraph.length) {
    if (paragraph[i] === "`") {
      inInlineCode = !inInlineCode;
      result += paragraph[i];
      i++;
      continue;
    }
    if (!inInlineCode && paragraph.slice(i, i + 2) === "==") {
      if (i > 0 && paragraph[i - 1] === "\\") {
        result += "==";
        i += 2;
        continue;
      }
      const innerStart = i + 2;
      const close = findClosingHighlight(paragraph, innerStart, inInlineCode);
      if (close !== -1) {
        result += `<mark>${paragraph.slice(innerStart, close)}</mark>`;
        i = close + 2;
        continue;
      }
    }
    result += paragraph[i];
    i++;
  }
  return result;
}
