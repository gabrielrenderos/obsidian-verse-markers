// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2025 Gabriel Renderos

/**
 * livePreview.ts
 * Live Preview accents for verse markers and `[//]` breaks inside ==highlight==
 * (label / `//` only). Outside highlights, `[//]` also gets muted brackets
 * because Obsidian does not style that token natively like `[N]`.
 */

import {
  Decoration,
  DecorationSet,
  EditorView,
  ViewPlugin,
} from "@codemirror/view";
import { RangeSetBuilder } from "@codemirror/state";
import {
  execVerseMarker,
  findVerseBreakIndex,
  getVerseRegex,
  VERSE_BREAK_TOKEN,
} from "./detection";
import { findHighlightRanges, type HighlightRange } from "./highlights";

interface RangeDecorationSpec {
  from: number;
  to: number;
  className: string;
}

function markerInsideHighlight(
  from: number,
  to: number,
  highlights: HighlightRange[]
): boolean {
  return highlights.some((h) => from >= h.start && to <= h.end);
}

function collectDecorations(view: EditorView): RangeDecorationSpec[] {
  const doc = view.state.doc;
  const fullText = doc.toString();
  const highlights = findHighlightRanges(fullText);
  const specs: RangeDecorationSpec[] = [];

  for (const { from, to } of view.visibleRanges) {
    let pos = from;
    while (pos < to) {
      const slice = doc.sliceString(pos, to);
      const brRel = findVerseBreakIndex(slice);
      const markerRe = getVerseRegex();
      const m = execVerseMarker(markerRe, slice);
      const brIdx = brRel === -1 ? -1 : pos + brRel;
      const markerIdx = m ? pos + m.index : -1;

      if (brIdx === -1 && markerIdx === -1) break;

      if (markerIdx === -1 || (brIdx !== -1 && brIdx < markerIdx)) {
        const breakFrom = brIdx;
        const breakTo = brIdx + VERSE_BREAK_TOKEN.length;
        if (markerInsideHighlight(breakFrom, breakTo, highlights)) {
          specs.push({
            from: breakFrom + 1,
            to: breakTo - 1,
            className: "verse-marker",
          });
        } else {
          specs.push(
            { from: breakFrom, to: breakFrom + 1, className: "verse-marker-bracket" },
            { from: breakFrom + 1, to: breakTo - 1, className: "verse-marker" },
            { from: breakTo - 1, to: breakTo, className: "verse-marker-bracket" }
          );
        }
        pos = breakTo;
        continue;
      }

      const matchFrom = markerIdx;
      const matchTo = markerIdx + m![0].length;
      if (markerInsideHighlight(matchFrom, matchTo, highlights)) {
        specs.push({
          from: matchFrom + 1,
          to: matchTo - 1,
          className: "verse-marker",
        });
      }
      pos = matchTo;
    }
  }

  specs.sort((a, b) => a.from - b.from);
  return specs;
}

function buildDecorations(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  for (const { from, to, className } of collectDecorations(view)) {
    builder.add(from, to, Decoration.mark({ class: className }));
  }
  return builder.finish();
}

class VerseMarkerLivePreviewPlugin {
  decorations: DecorationSet;

  constructor(view: EditorView) {
    this.decorations = buildDecorations(view);
  }

  update(update: { docChanged: boolean; viewportChanged: boolean; view: EditorView }): void {
    if (update.docChanged || update.viewportChanged) {
      this.decorations = buildDecorations(update.view);
    }
  }
}

/** Editor extension registered from main.ts. */
export function verseMarkerLivePreviewExtension() {
  return ViewPlugin.fromClass(VerseMarkerLivePreviewPlugin, {
    decorations: (plugin) => plugin.decorations,
  });
}
