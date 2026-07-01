// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2025 Gabriel Renderos

/**
 * livePreview.ts
 * Live Preview styling for verse markers and `[//]` breaks.
 *
 * `[N]` and Roman section markers (`[I]`, …) always get explicit muted-bracket +
 * accent-label marks. When ` [` (one space, then `[`) immediately follows a
 * closed marker — e.g. `[1] [^1]` or `[I] [1]` — Obsidian would normally hide
 * the `[`/`]` of the marker (reference-link parse). Two display modes guard
 * that case, both ranked above Obsidian's decorations via Prec.highest:
 *   - caret outside: one replace widget covers the whole `[N]` token, so the
 *     marker reads as an atomic styled chip and Obsidian's link decoration
 *     can't reach the inner digits.
 *   - caret touching: bracket replace widgets at `[` and `]`, native digits
 *     in between. Obsidian drops its link decoration when the caret is in
 *     the range, so the digits become normal editable text.
 *
 * Widgets handle their own clicks (`ignoreEvent`): a click anywhere on the
 * chip places the caret just before `]` (`[N|]`), which counts as touching —
 * so the next decoration rebuild swaps in the editable form.
 *
 * `[//]` inside ==highlight== accents `//` only; outside, full bracket marks.
 * `[///]` uses the same bracket styling as other break tokens.
 */

import {
  Decoration,
  DecorationSet,
  EditorView,
  ViewPlugin,
  WidgetType,
  type ViewUpdate,
} from "@codemirror/view";
import { Prec, RangeSetBuilder, EditorSelection, type StateEffect } from "@codemirror/state";
import {
  isFollowedByFootnoteRef,
  nextProcessToken,
} from "./detection";
import { findHighlightRanges, type HighlightRange } from "./highlights";
import {
  flashClassesForWidget,
  setVerseFlashEffect,
} from "./flashLivePreview";

/** Single-char replace widget — renders `[` or `]` over the hidden source char. */
class VerseMarkerBracketWidget extends WidgetType {
  constructor(
    readonly bracket: "[" | "]",
    readonly flashClass: string
  ) {
    super();
  }

  eq(other: WidgetType): boolean {
    return (
      other instanceof VerseMarkerBracketWidget &&
      other.bracket === this.bracket &&
      other.flashClass === this.flashClass
    );
  }

  /** Let CM6 process mouse events natively (posAtCoords placement). */
  ignoreEvent(): boolean {
    return false;
  }

  toDOM(): HTMLElement {
    const wrap = activeDocument.createElement("span");
    wrap.className = ["verse-marker-bracket", "verse-marker-widget", this.flashClass]
      .filter(Boolean)
      .join(" ");
    wrap.textContent = this.bracket;
    return wrap;
  }
}

/** Full-token replace widget — used when caret is away from `[N] [^id]`. */
class VerseMarkerWidget extends WidgetType {
  constructor(
    readonly label: string,
    readonly flashClass: string,
    readonly markerFrom: number,
    readonly markerTo: number
  ) {
    super();
  }

  eq(other: WidgetType): boolean {
    return (
      other instanceof VerseMarkerWidget &&
      other.label === this.label &&
      other.flashClass === this.flashClass &&
      other.markerFrom === this.markerFrom &&
      other.markerTo === this.markerTo
    );
  }

  /** Handle clicks on the chip so the caret lands inside the brackets. */
  ignoreEvent(): boolean {
    return true;
  }

  toDOM(view: EditorView): HTMLElement {
    const wrap = activeDocument.createElement("span");
    wrap.className = ["verse-marker-widget", this.flashClass]
      .filter(Boolean)
      .join(" ");

    const open = activeDocument.createElement("span");
    open.className = "verse-marker-bracket";
    open.textContent = "[";

    const label = activeDocument.createElement("span");
    label.className = "verse-marker";
    label.textContent = this.label;

    const close = activeDocument.createElement("span");
    close.className = "verse-marker-bracket";
    close.textContent = "]";

    wrap.append(open, label, close);

    const placeCaretInside = (event: MouseEvent) => {
      event.preventDefault();
      event.stopPropagation();
      view.focus();
      view.dispatch({
        selection: EditorSelection.cursor(this.markerTo - 1),
        scrollIntoView: true,
      });
    };
    wrap.addEventListener("mousedown", placeCaretInside, true);

    return wrap;
  }
}

interface BuiltDecorations {
  all: DecorationSet;
}

function buildDecorations(view: EditorView): BuiltDecorations {
  const specs = collectDecorationSpecs(view);
  const allBuilder = new RangeSetBuilder<Decoration>();
  for (const { from, to, decoration } of specs) {
    allBuilder.add(from, to, decoration);
  }
  return { all: allBuilder.finish() };
}

function markerInsideHighlight(
  from: number,
  to: number,
  highlights: HighlightRange[]
): boolean {
  return highlights.some((h) => from >= h.start && to <= h.end);
}

function widgetFlashClass(markerFrom: number, markerTo: number): string {
  return flashClassesForWidget(markerFrom, markerTo);
}

/** Caret inside `[from, to)` — excludes the position after `]`. */
function selectionTouchesMarker(
  view: EditorView,
  from: number,
  to: number
): boolean {
  return view.state.selection.ranges.some((range) => {
    if (!range.empty) return range.from < to && range.to > from;
    const pos = range.from;
    return pos >= from && pos < to;
  });
}

function bracketReplaceDecoration(
  bracket: "[" | "]",
  flashClass: string
): Decoration {
  return Decoration.replace({
    widget: new VerseMarkerBracketWidget(bracket, flashClass),
    inclusive: false,
    inclusiveStart: true,
    inclusiveEnd: true,
    block: false,
  });
}

/** Caret away from marker: one replace widget covers the whole `[N]`. */
function pushFootnoteWidgetMarks(
  specs: Array<{ from: number; to: number; decoration: Decoration }>,
  matchFrom: number,
  matchTo: number,
  label: string
): void {
  specs.push({
    from: matchFrom,
    to: matchTo,
    decoration: Decoration.replace({
      widget: new VerseMarkerWidget(
        label,
        widgetFlashClass(matchFrom, matchTo),
        matchFrom,
        matchTo
      ),
      inclusive: false,
      inclusiveStart: true,
      inclusiveEnd: true,
      block: false,
    }),
  });
}

/** Caret touching marker: bracket widgets at edges, native digits between. */
function pushFootnoteEditingMarks(
  specs: Array<{ from: number; to: number; decoration: Decoration }>,
  matchFrom: number,
  matchTo: number
): void {
  const flashClass = widgetFlashClass(matchFrom, matchTo);
  const innerFrom = matchFrom + 1;
  const innerTo = matchTo - 1;

  specs.push({
    from: matchFrom,
    to: matchFrom + 1,
    decoration: bracketReplaceDecoration("[", flashClass),
  });

  if (innerTo > innerFrom) {
    specs.push({
      from: innerFrom,
      to: innerTo,
      decoration: Decoration.mark({ class: "verse-marker" }),
    });
  }

  specs.push({
    from: matchTo - 1,
    to: matchTo,
    decoration: bracketReplaceDecoration("]", flashClass),
  });
}

/** Muted `[` `]` + accent label — shared by `[N]` marks and break tokens. */
function pushBracketLabelMarks(
  specs: Array<{ from: number; to: number; decoration: Decoration }>,
  tokenFrom: number,
  tokenTo: number,
  innerClass = "verse-marker"
): void {
  specs.push(
    {
      from: tokenFrom,
      to: tokenFrom + 1,
      decoration: Decoration.mark({ class: "verse-marker-bracket" }),
    },
    {
      from: tokenFrom + 1,
      to: tokenTo - 1,
      decoration: Decoration.mark({ class: innerClass }),
    },
    {
      from: tokenTo - 1,
      to: tokenTo,
      decoration: Decoration.mark({ class: "verse-marker-bracket" }),
    }
  );
}

/** Muted `[` `]` + accent label, or footnote-adjacent widget when ` [` follows. */
function pushMarkerDecorations(
  specs: Array<{ from: number; to: number; decoration: Decoration }>,
  view: EditorView,
  fullText: string,
  matchFrom: number,
  matchTo: number,
  label: string
): void {
  const beforeFootnote = isFollowedByFootnoteRef(fullText, matchTo);
  const touching =
    beforeFootnote && selectionTouchesMarker(view, matchFrom, matchTo);

  if (beforeFootnote && touching) {
    pushFootnoteEditingMarks(specs, matchFrom, matchTo);
  } else if (beforeFootnote) {
    pushFootnoteWidgetMarks(specs, matchFrom, matchTo, label);
  } else {
    pushBracketLabelMarks(specs, matchFrom, matchTo);
  }
}

function collectDecorationSpecs(
  view: EditorView
): Array<{ from: number; to: number; decoration: Decoration }> {
  const doc = view.state.doc;
  const fullText = doc.toString();
  const highlights = findHighlightRanges(fullText);
  const specs: Array<{ from: number; to: number; decoration: Decoration }> = [];

  for (const { from, to } of view.visibleRanges) {
    let pos = from;
    while (pos < to) {
      const tok = nextProcessToken(fullText, pos, to);
      if (!tok) break;

      if (tok.kind === "verseBreak" || tok.kind === "flowBreak") {
        const breakFrom = tok.index;
        const breakTo = tok.index + tok.length;
        if (markerInsideHighlight(breakFrom, breakTo, highlights)) {
          const innerFrom = breakFrom + 1;
          const innerTo = breakTo - 1;
          specs.push({
            from: innerFrom,
            to: innerTo,
            decoration: Decoration.mark({ class: "verse-marker" }),
          });
        } else {
          pushBracketLabelMarks(specs, breakFrom, breakTo);
        }
        pos = breakTo;
        continue;
      }

      const raw = tok.raw;
      const matchFrom = raw.index;
      const matchTo = raw.index + raw.length;
      const label =
        raw.kind === "roman" ? raw.roman : raw.token.slice(1, -1);
      pushMarkerDecorations(
        specs,
        view,
        fullText,
        matchFrom,
        matchTo,
        label
      );

      pos = matchTo;
    }
  }

  specs.sort((a, b) => a.from - b.from);
  return specs;
}

function transactionHasFlashChange(tr: {
  effects: readonly StateEffect<unknown>[];
}): boolean {
  for (const e of tr.effects) {
    if (e.is(setVerseFlashEffect)) return true;
  }
  return false;
}

class VerseMarkerLivePreviewPlugin {
  decorations: DecorationSet;

  constructor(view: EditorView) {
    this.decorations = buildDecorations(view).all;
  }

  update(update: ViewUpdate): void {
    const flashChanged = update.transactions.some(transactionHasFlashChange);
    if (
      update.docChanged ||
      update.viewportChanged ||
      flashChanged ||
      update.selectionSet
    ) {
      this.decorations = buildDecorations(update.view).all;
    }
  }
}

/** Editor extension registered from main.ts. */
export function verseMarkerLivePreviewExtension() {
  return Prec.highest(
    ViewPlugin.fromClass(VerseMarkerLivePreviewPlugin, {
      decorations: (p) => p.decorations,
    })
  );
}
