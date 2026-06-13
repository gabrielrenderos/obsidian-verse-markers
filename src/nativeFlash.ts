// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2025 Gabriel Renderos

/**
 * nativeFlash.ts
 * Prevents Obsidian's native block scroll-flash during verse navigation.
 * Verse links scroll without `is-flashing`; our custom highlight replaces it.
 */

import type { Editor, EditorRange, Plugin } from "obsidian";
import { MarkdownView } from "obsidian";
import { EditorView } from "@codemirror/view";

const VERSE_HIGHLIGHT_ACTIVE_CLASS = "verse-highlight-active";

interface PatchedEditor extends Editor {
  __verseMarkersFlashPatched?: boolean;
  addHighlights?: (
    ranges: unknown[],
    style: string,
    removePrevious: boolean,
    range?: EditorRange
  ) => void;
}

/** True while a custom verse navigation highlight is on screen. */
export function isVerseHighlightActive(): boolean {
  return activeDocument.body.classList.contains(VERSE_HIGHLIGHT_ACTIVE_CLASS);
}

/** Set while our verse highlight is shown (blocks native flash APIs). */
export function setVerseHighlightActive(active: boolean): void {
  activeDocument.body.classList.toggle(VERSE_HIGHLIGHT_ACTIVE_CLASS, active);
}

function cmView(editor: Editor): EditorView | null {
  return (editor as unknown as { cm?: EditorView }).cm ?? null;
}

/** Scroll the CM6 editor without Obsidian's `is-flashing` highlight layer. */
export function scrollEditorWithoutFlash(
  editor: Editor,
  range: EditorRange,
  center = false
): void {
  const view = cmView(editor);
  if (!view) return;

  const from = editor.posToOffset(range.from);
  const to = editor.posToOffset(range.to);
  const anchor = center ? Math.round((from + to) / 2) : from;
  view.dispatch({
    effects: EditorView.scrollIntoView(anchor, {
      y: center ? "center" : "nearest",
    }),
  });
}

/**
 * Scroll reading view to `line` without the native line flash.
 * Uses the preview renderer's scroll-only APIs (not eState / setEphemeralState).
 */
export async function scrollReadingViewToLine(
  mdView: MarkdownView,
  line: number
): Promise<void> {
  const v = mdView as unknown as {
    applyScroll?: (scroll: number) => void;
    previewMode?: {
      applyScroll?: (scroll: number) => void;
      renderer?: {
        applyScroll?: (scroll: number) => void;
        applyScrollDelayed?: (
          scroll: number,
          opts?: { highlight?: boolean; center?: boolean }
        ) => void;
      };
    };
  };

  const renderer = v.previewMode?.renderer;
  if (renderer?.applyScrollDelayed) {
    renderer.applyScrollDelayed(line, { highlight: false });
  } else if (renderer?.applyScroll) {
    renderer.applyScroll(line);
  } else if (v.previewMode?.applyScroll) {
    v.previewMode.applyScroll(line);
  } else if (v.applyScroll) {
    v.applyScroll(line);
  }

  await new Promise<void>((resolve) => {
    window.requestAnimationFrame(() => window.requestAnimationFrame(() => resolve()));
  });
}

function patchEditor(editor: Editor): void {
  const ed = editor as PatchedEditor;
  if (ed.__verseMarkersFlashPatched) return;
  ed.__verseMarkersFlashPatched = true;

  const origHighlights = ed.addHighlights?.bind(ed);
  if (origHighlights) {
    ed.addHighlights = (ranges, style, removePrevious, range?) => {
      if (isVerseHighlightActive() && style === "is-flashing") return;
      return origHighlights(ranges, style, removePrevious, range);
    };
  }

  const origScroll = ed.scrollIntoView.bind(ed);
  ed.scrollIntoView = (range, center?) => {
    if (isVerseHighlightActive()) {
      scrollEditorWithoutFlash(ed, range, center ?? false);
      return;
    }
    return origScroll(range, center);
  };
}

function patchMarkdownView(view: MarkdownView | null | undefined): void {
  if (view?.editor) patchEditor(view.editor);
}

/** Block native `is-flashing` on editors while our verse highlight is active. */
export function registerNativeFlashPrevention(plugin: Plugin): void {
  plugin.app.workspace.iterateAllLeaves((leaf) => {
    if (leaf.view instanceof MarkdownView) patchMarkdownView(leaf.view);
  });

  plugin.registerEvent(
    plugin.app.workspace.on("active-leaf-change", () => {
      patchMarkdownView(plugin.app.workspace.getActiveViewOfType(MarkdownView));
    })
  );

  plugin.registerEvent(
    plugin.app.workspace.on("file-open", () => {
      patchMarkdownView(plugin.app.workspace.getActiveViewOfType(MarkdownView));
    })
  );
}
