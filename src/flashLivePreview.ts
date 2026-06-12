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
import { getVerseFlashSourceRanges, type VerseSegment } from "./detection";

const FLASH_FADE_MS = 220;
const FLASH_HOLD_MS = 2000;

interface FlashSpec {
  ranges: Array<{ from: number; to: number }>;
  phase: "inactive" | "active";
}

const setVerseFlashEffect = StateEffect.define<FlashSpec | null>();

const verseFlashField = StateField.define<DecorationSet>({
  create() {
    return Decoration.none;
  },
  update(deco, tr) {
    for (const e of tr.effects) {
      if (e.is(setVerseFlashEffect)) {
        if (!e.value || e.value.ranges.length === 0) return Decoration.none;
        const cls =
          e.value.phase === "active"
            ? "verse-flash-cm verse-flash-cm-active"
            : "verse-flash-cm";
        const builder = new RangeSetBuilder<Decoration>();
        for (const r of e.value.ranges) {
          if (r.to > r.from) {
            builder.add(r.from, r.to, Decoration.mark({ class: cls }));
          }
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

let flashTimer: number | null = null;

function editorView(editor: Editor): EditorView | null {
  const cm = (editor as unknown as { cm?: EditorView }).cm;
  return cm ?? null;
}

/** Clears any in-flight Live Preview flash on `editor`. */
export function clearLivePreviewFlash(editor: Editor): void {
  if (flashTimer !== null) {
    window.clearTimeout(flashTimer);
    flashTimer = null;
  }
  const view = editorView(editor);
  if (!view) return;
  view.dispatch({ effects: setVerseFlashEffect.of(null) });
}

/**
 * Briefly highlights verse text in the Live Preview editor using CM6 mark
 * decorations (mirrors reading-view flash timing).
 */
export function flashVerseSegmentsInEditor(
  editor: Editor,
  content: string,
  segments: VerseSegment[]
): void {
  const view = editorView(editor);
  if (!view) return;

  const ranges = getVerseFlashSourceRanges(content, segments);
  if (ranges.length === 0) return;

  clearLivePreviewFlash(editor);

  const dispatch = (phase: "inactive" | "active"): void => {
    view.dispatch({ effects: setVerseFlashEffect.of({ ranges, phase }) });
  };

  dispatch("inactive");
  window.requestAnimationFrame(() => {
    dispatch("active");
    flashTimer = window.setTimeout(() => {
      dispatch("inactive");
      flashTimer = window.setTimeout(() => {
        view.dispatch({ effects: setVerseFlashEffect.of(null) });
        flashTimer = null;
      }, FLASH_FADE_MS);
    }, FLASH_HOLD_MS);
  });
}
