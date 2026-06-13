// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2025 Gabriel Renderos

/**
 * flashLivePreview.ts
 * Navigation flash for Live Preview (CM6). Reading view uses DOM spans in
 * references.ts; the editor cannot host those without the next CM update
 * wiping them.
 */

import type { Editor } from "obsidian";
import { RangeSetBuilder, StateEffect, StateField } from "@codemirror/state";
import { Decoration, DecorationSet, EditorView } from "@codemirror/view";
import {
  getVerseFlashRuns,
  type VerseFlashRun,
  type VerseSegment,
} from "./detection";
import { setVerseHighlightActive } from "./nativeFlash";
import { notifyVerseHighlightShown } from "./highlightDismiss";

const FLASH_FADE_MS = 220;

interface FlashMark {
  from: number;
  to: number;
  capStart: boolean;
  capEnd: boolean;
}

interface FlashSpec {
  marks: FlashMark[];
  phase: "inactive" | "active";
}

export const setVerseFlashEffect = StateEffect.define<FlashSpec | null>();

let activeSpec: FlashSpec | null = null;

function marksFromRuns(runs: VerseFlashRun[]): FlashMark[] {
  const marks: FlashMark[] = [];
  for (const run of runs) {
    for (let i = 0; i < run.ranges.length; i++) {
      const r = run.ranges[i];
      marks.push({
        from: r.from,
        to: r.to,
        capStart: run.capStart && i === 0,
        capEnd: run.capEnd && i === run.ranges.length - 1,
      });
    }
  }
  return normalizeGlobalCaps(marks);
}

/** Only the document-first mark may cap start; only the document-last may cap end. */
function normalizeGlobalCaps(marks: FlashMark[]): FlashMark[] {
  if (marks.length <= 1) return marks;
  let firstIdx = 0;
  let lastIdx = 0;
  for (let i = 1; i < marks.length; i++) {
    if (marks[i].from < marks[firstIdx].from) firstIdx = i;
    if (marks[i].to > marks[lastIdx].to) lastIdx = i;
  }
  return marks.map((m, i) => ({
    ...m,
    capStart: m.capStart && i === firstIdx,
    capEnd: m.capEnd && i === lastIdx,
  }));
}

function lastCappedChar(text: string, from: number, to: number): number {
  let i = to - 1;
  while (i >= from && /\s/.test(text[i])) i--;
  return i >= from ? i : to - 1;
}

function flashClassMid(phase: "inactive" | "active"): string {
  return phase === "active"
    ? "verse-flash-cm verse-flash-cm-active"
    : "verse-flash-cm";
}

/**
 * Mirrors reading-view caps: only the outermost edges of a run get radius
 * classes. Interior spans (and wrapped line fragments) stay square so corners
 * do not overlap.
 */
function addCappedMark(
  builder: RangeSetBuilder<Decoration>,
  mark: FlashMark,
  phase: "inactive" | "active",
  text: string,
  globalEndChar: number
): void {
  const { from, to, capStart, capEnd } = mark;
  if (to <= from) return;

  const mid = flashClassMid(phase);
  const endChar = capEnd ? globalEndChar : -1;

  if (to - from === 1) {
    const caps = [
      capStart && "verse-flash-cm-start",
      capEnd && endChar === from && "verse-flash-cm-end",
    ].filter(Boolean);
    builder.add(from, to, Decoration.mark({ class: [mid, ...caps].join(" ") }));
    return;
  }

  let pos = from;
  if (capStart) {
    builder.add(
      pos,
      pos + 1,
      Decoration.mark({ class: `${mid} verse-flash-cm-start` })
    );
    pos++;
  }

  const bodyEnd = capEnd && endChar >= pos ? endChar : to;
  if (bodyEnd > pos) {
    builder.add(pos, bodyEnd, Decoration.mark({ class: mid }));
  }

  if (capEnd && endChar >= from && endChar < to) {
    builder.add(
      endChar,
      endChar + 1,
      Decoration.mark({ class: `${mid} verse-flash-cm-end` })
    );
    if (endChar + 1 < to) {
      builder.add(endChar + 1, to, Decoration.mark({ class: mid }));
    }
  }
}

/**
 * Flash classes for a replace-widget marker (`[N] [^id]`). CM6 marks do not
 * paint on replaced ranges, so only the footnote-adjacent widget needs this.
 */
export function flashClassesForWidget(from: number, to: number): string {
  if (!activeSpec) return "";
  for (const m of activeSpec.marks) {
    if (m.from >= to || m.to <= from) continue;
    const parts = ["verse-flash-cm"];
    if (activeSpec.phase === "active") parts.push("verse-flash-cm-active");
    if (m.capStart && from <= m.from) parts.push("verse-flash-cm-start");
    if (m.capEnd && to >= m.to) parts.push("verse-flash-cm-end");
    return parts.join(" ");
  }
  return "";
}

const verseFlashField = StateField.define<DecorationSet>({
  create() {
    return Decoration.none;
  },
  update(deco, tr) {
    for (const e of tr.effects) {
      if (e.is(setVerseFlashEffect)) {
        activeSpec = e.value;
        if (!e.value || e.value.marks.length === 0) {
          return Decoration.none;
        }
        const doc = tr.state.doc.toString();
        const marks = e.value.marks;
        const globalEndChar = lastCappedChar(
          doc,
          0,
          Math.max(...marks.map((m) => m.to))
        );
        const builder = new RangeSetBuilder<Decoration>();
        for (const mark of marks) {
          addCappedMark(builder, mark, e.value.phase, doc, globalEndChar);
        }
        return builder.finish();
      }
    }
    return deco.map(tr.changes);
  },
  provide: (f) => EditorView.decorations.from(f),
});

/** Editor extension registered from main.ts. */
export function verseFlashExtension() {
  return verseFlashField;
}

let fadeTimer: number | null = null;
let activeEditor: Editor | null = null;
let activeMarks: FlashMark[] = [];

function editorView(editor: Editor): EditorView | null {
  const cm = (editor as unknown as { cm?: EditorView }).cm;
  return cm ?? null;
}

/** Clears the Live Preview verse highlight (optional fade-out). */
export function clearLivePreviewFlash(
  editor: Editor | null,
  fadeOut = true
): void {
  if (fadeTimer !== null) {
    window.clearTimeout(fadeTimer);
    fadeTimer = null;
  }

  const view = editor
    ? editorView(editor)
    : activeEditor
      ? editorView(activeEditor)
      : null;
  if (!view) {
    activeEditor = null;
    activeMarks = [];
    activeSpec = null;
    return;
  }

  if (!fadeOut) {
    activeEditor = null;
    activeMarks = [];
    activeSpec = null;
    view.dispatch({ effects: setVerseFlashEffect.of(null) });
    return;
  }

  if (activeMarks.length === 0) {
    activeEditor = null;
    activeSpec = null;
    view.dispatch({ effects: setVerseFlashEffect.of(null) });
    return;
  }

  view.dispatch({
    effects: setVerseFlashEffect.of({ marks: activeMarks, phase: "inactive" }),
  });
  fadeTimer = window.setTimeout(() => {
    view.dispatch({ effects: setVerseFlashEffect.of(null) });
    fadeTimer = null;
    activeEditor = null;
    activeMarks = [];
    activeSpec = null;
  }, FLASH_FADE_MS);
}

/**
 * Highlights verse text in Live Preview using CM6 marks.
 */
export function flashVerseSegmentsInEditor(
  editor: Editor,
  content: string,
  segments: VerseSegment[]
): void {
  const view = editorView(editor);
  if (!view) return;

  const runs = getVerseFlashRuns(content, segments);
  const marks = marksFromRuns(runs);
  if (marks.length === 0) {
    setVerseHighlightActive(false);
    return;
  }

  clearLivePreviewFlash(editor, false);

  activeEditor = editor;
  activeMarks = marks;
  setVerseHighlightActive(true);

  const dispatch = (phase: "inactive" | "active"): void => {
    view.dispatch({ effects: setVerseFlashEffect.of({ marks, phase }) });
  };

  dispatch("inactive");
  window.requestAnimationFrame(() => {
    dispatch("active");
    notifyVerseHighlightShown();
  });
}

/** Clears LP highlight on whichever editor last flashed. */
export function clearActiveLivePreviewFlash(fadeOut = true): void {
  clearLivePreviewFlash(activeEditor, fadeOut);
}
