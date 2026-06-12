// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2025 Gabriel Renderos

/**
 * livePreview.ts
 * Live Preview styling for verse markers and `[//]` breaks.
 *
 * `[N]` always gets explicit muted-bracket + accent-label marks (same look
 * everywhere in the editor). Before a footnote ref (`[1] [^1]`) a replace
 * widget is used instead so Markdown does not treat the marker as a reference
 * link — the widget reuses the same CSS classes, styling only.
 *
 * `[//]` inside ==highlight== accents `//` only; outside, full bracket marks.
 */

import {
  Decoration,
  DecorationSet,
  EditorView,
  ViewPlugin,
  WidgetType,
} from "@codemirror/view";
import { RangeSetBuilder } from "@codemirror/state";
import {
  execVerseMarker,
  findVerseBreakIndex,
  getVerseRegex,
  isFollowedByFootnoteRef,
  parseMarkerToken,
  VERSE_BREAK_TOKEN,
} from "./detection";
import { findHighlightRanges, type HighlightRange } from "./highlights";

/** Renders `[N]` with visible brackets when a footnote ref would swallow it. */
class VerseMarkerWidget extends WidgetType {
  constructor(readonly label: string) {
    super();
  }

  eq(other: WidgetType): boolean {
    return other instanceof VerseMarkerWidget && other.label === this.label;
  }

  /** Pass clicks/edits through; footnote `[^1]` after the widget stays interactive. */
  ignoreEvent(): boolean {
    return true;
  }

  toDOM(): HTMLElement {
    const wrap = document.createElement("span");
    wrap.className = "verse-marker-widget";
    const open = document.createElement("span");
    open.className = "verse-marker-bracket";
    open.textContent = "[";
    const label = document.createElement("span");
    label.className = "verse-marker";
    label.textContent = this.label;
    const close = document.createElement("span");
    close.className = "verse-marker-bracket";
    close.textContent = "]";
    wrap.append(open, label, close);
    return wrap;
  }
}

interface BuiltDecorations {
  all: DecorationSet;
  atomic: DecorationSet;
}

function markerInsideHighlight(
  from: number,
  to: number,
  highlights: HighlightRange[]
): boolean {
  return highlights.some((h) => from >= h.start && to <= h.end);
}

function verseMarkerLabel(token: string): string {
  const { number, part } = parseMarkerToken(token);
  return `${number}${part ?? ""}`;
}

/** Muted `[` `]` + accent label — shared by `[N]` marks and the footnote widget. */
function pushBracketLabelMarks(
  specs: Array<{
    from: number;
    to: number;
    decoration: Decoration;
    atomic: boolean;
  }>,
  tokenFrom: number,
  tokenTo: number
): void {
  specs.push(
    {
      from: tokenFrom,
      to: tokenFrom + 1,
      decoration: Decoration.mark({ class: "verse-marker-bracket" }),
      atomic: false,
    },
    {
      from: tokenFrom + 1,
      to: tokenTo - 1,
      decoration: Decoration.mark({ class: "verse-marker" }),
      atomic: false,
    },
    {
      from: tokenTo - 1,
      to: tokenTo,
      decoration: Decoration.mark({ class: "verse-marker-bracket" }),
      atomic: false,
    }
  );
}

function collectDecorationSpecs(
  view: EditorView
): Array<{ from: number; to: number; decoration: Decoration; atomic: boolean }> {
  const doc = view.state.doc;
  const fullText = doc.toString();
  const highlights = findHighlightRanges(fullText);
  const specs: Array<{
    from: number;
    to: number;
    decoration: Decoration;
    atomic: boolean;
  }> = [];

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
            decoration: Decoration.mark({ class: "verse-marker" }),
            atomic: false,
          });
        } else {
          pushBracketLabelMarks(specs, breakFrom, breakTo);
        }
        pos = breakTo;
        continue;
      }

      const matchFrom = markerIdx;
      const matchTo = markerIdx + m![0].length;
      const beforeFootnote = isFollowedByFootnoteRef(fullText, matchTo);

      if (beforeFootnote) {
        specs.push({
          from: matchFrom,
          to: matchTo,
          decoration: Decoration.replace({
            widget: new VerseMarkerWidget(verseMarkerLabel(m![0])),
            inclusive: false,
            block: false,
          }),
          atomic: true,
        });
      } else {
        pushBracketLabelMarks(specs, matchFrom, matchTo);
      }

      pos = matchTo;
    }
  }

  specs.sort((a, b) => a.from - b.from);
  return specs;
}

function buildDecorations(view: EditorView): BuiltDecorations {
  const specs = collectDecorationSpecs(view);
  const allBuilder = new RangeSetBuilder<Decoration>();
  const atomicBuilder = new RangeSetBuilder<Decoration>();
  for (const { from, to, decoration, atomic } of specs) {
    allBuilder.add(from, to, decoration);
    if (atomic) atomicBuilder.add(from, to, decoration);
  }
  return {
    all: allBuilder.finish(),
    atomic: atomicBuilder.finish(),
  };
}

class VerseMarkerLivePreviewPlugin {
  decorations: DecorationSet;
  atomicDeco: DecorationSet;

  constructor(view: EditorView) {
    const built = buildDecorations(view);
    this.decorations = built.all;
    this.atomicDeco = built.atomic;
  }

  update(update: {
    docChanged: boolean;
    viewportChanged: boolean;
    view: EditorView;
  }): void {
    if (update.docChanged || update.viewportChanged) {
      const built = buildDecorations(update.view);
      this.decorations = built.all;
      this.atomicDeco = built.atomic;
    }
  }
}

/** Editor extension registered from main.ts. */
export function verseMarkerLivePreviewExtension() {
  let plugin: ViewPlugin<VerseMarkerLivePreviewPlugin>;
  plugin = ViewPlugin.fromClass(VerseMarkerLivePreviewPlugin, {
    decorations: (p) => p.decorations,
    provide: () =>
      EditorView.atomicRanges.of(
        (view) => view.plugin(plugin)?.atomicDeco ?? Decoration.none
      ),
  });
  return plugin;
}
