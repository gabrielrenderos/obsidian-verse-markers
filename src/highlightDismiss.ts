// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2025 Gabriel Renderos

/**
 * highlightDismiss.ts
 * Clears reading-view and Live Preview verse highlights after navigation.
 * Default: auto-fade after a short timer; optional keep-until-click mode.
 */

import type { Plugin } from "obsidian";
import type { VerseMarkersSettings } from "./settings";
import { setVerseHighlightActive } from "./nativeFlash";

/** How long the navigation highlight stays visible in timed mode. */
const VERSE_FLASH_AUTO_MS = 2000;

const dismissHandlers: Array<() => void> = [];
let getSettings: (() => VerseMarkersSettings) | null = null;
let autoDismissTimer: number | null = null;

/** Supplies plugin settings to the highlight-dismiss module. */
export function configureVerseHighlightBehavior(
  getter: () => VerseMarkersSettings
): void {
  getSettings = getter;
}

function keepHighlightUntilClick(): boolean {
  return getSettings?.().keepHighlightUntilClick ?? false;
}

function clearAutoDismissTimer(): void {
  if (autoDismissTimer !== null) {
    window.clearTimeout(autoDismissTimer);
    autoDismissTimer = null;
  }
}

/** Register a callback invoked when the active verse highlight is dismissed. */
export function onVerseHighlightDismiss(handler: () => void): () => void {
  dismissHandlers.push(handler);
  return () => {
    const i = dismissHandlers.indexOf(handler);
    if (i !== -1) dismissHandlers.splice(i, 1);
  };
}

/** Clears custom verse highlights. */
export function dismissVerseHighlight(): void {
  clearAutoDismissTimer();
  for (const handler of dismissHandlers) handler();
  setVerseHighlightActive(false);
}

/**
 * Call once the navigation highlight is visible. Starts the auto-dismiss
 * timer unless keep-until-click mode is enabled.
 */
export function notifyVerseHighlightShown(): void {
  clearAutoDismissTimer();
  if (keepHighlightUntilClick()) return;
  autoDismissTimer = window.setTimeout(() => {
    dismissVerseHighlight();
    autoDismissTimer = null;
  }, VERSE_FLASH_AUTO_MS);
}

/** Document-level click dismisses the highlight in keep-until-click mode. */
export function registerVerseHighlightDismiss(plugin: Plugin): void {
  plugin.registerDomEvent(
    activeDocument,
    "mousedown",
    (ev: MouseEvent) => {
      if (!keepHighlightUntilClick()) return;
      const target = ev.target as HTMLElement;
      if (isVerseNavigationTarget(target)) return;
      dismissVerseHighlight();
    },
    { capture: true }
  );
}

function isVerseNavigationTarget(target: HTMLElement): boolean {
  const link = target.closest(
    "a.internal-link, a.cm-underline, .cm-link, span.cm-link"
  );
  if (!link) return false;
  const href =
    link.getAttribute("data-href") ?? link.getAttribute("href") ?? "";
  const hashIdx = href.indexOf("#");
  if (hashIdx === -1) return false;
  return href.slice(hashIdx + 1).startsWith("verse-");
}
