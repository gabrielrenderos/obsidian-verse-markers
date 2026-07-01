// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2025 Gabriel Renderos

/**
 * detection.ts
 * Single source of truth for the verse marker regex and content utilities.
 */

/**
 * Canonical verse marker regex.
 * Matches [N] or [N<part>] where N is one or more digits optionally followed
 * by lowercase letters (an *authored* part suffix, e.g. [5a], [12bc]), with
 * boundary conditions:
 * - preceded by start-of-string, >, whitespace, or inline-format delimiters
 *   (=, *, ~, _) so markers inside ==highlight== / **bold** / etc. match
 * - followed by whitespace or end-of-string
 *
 * The required leading digit keeps this from matching ordinary bracketed
 * Markdown like [note] or footnotes [^1], so broadening to a part suffix does
 * not introduce false positives. The trailing letters are an editorial part
 * label (some Bibles split a single canonical verse into [5a]…[5b]…), which
 * shares the same `verse-Na` addressing as heading/footnote-derived parts.
 *
 * The left boundary (start-of-line, ">", or whitespace) is enforced in code
 * via execVerseMarker/atVerseBoundary instead of a regex lookbehind, because
 * lookbehind is unsupported on iOS/WebKit before 16.4.
 */
export const VERSE_MARKER_REGEX = /\[\d+[a-z]*\](?=\s|$)/gm;

/**
 * Returns a fresh (lastIndex-reset) copy of the canonical regex.
 * Always use this instead of VERSE_MARKER_REGEX directly when iterating,
 * to avoid shared lastIndex state between callers.
 */
export function getVerseRegex(): RegExp {
  return new RegExp(VERSE_MARKER_REGEX.source, VERSE_MARKER_REGEX.flags);
}

/** Inline-format delimiter chars that may immediately precede a verse marker. */
const INLINE_FORMAT_DELIM = /=|[*~_]/;

/**
 * True when a marker found at `index` sits at a valid left boundary: the
 * start of the text, or immediately after ">" or any whitespace, optionally
 * preceded by a run of inline-format delimiters (==, **, ~~, __). This is the
 * lookbehind-free equivalent of the old `(?:^|(?<=[>\s]))` prefix, extended
 * so ==[N] and similar forms are recognized in raw-text scans.
 */
export function atVerseBoundary(text: string, index: number): boolean {
  if (index <= 0) return true;
  let pos = index - 1;
  while (pos >= 0) {
    if (INLINE_FORMAT_DELIM.test(text.charAt(pos))) {
      pos--;
      continue;
    }
    if (text.charAt(pos) === "\\") {
      pos--;
      continue;
    }
    break;
  }
  if (pos < 0) return true;
  const prev = text.charAt(pos);
  return prev === ">" || /\s/.test(prev);
}

/**
 * exec() wrapper that skips matches failing the left-boundary test, so the
 * canonical regex can stay lookbehind-free. `re` must be a fresh global regex
 * from getVerseRegex(); its lastIndex advances as usual between calls.
 */
export function execVerseMarker(
  re: RegExp,
  text: string
): RegExpExecArray | null {
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (atVerseBoundary(text, m.index)) return m;
  }
  return null;
}

/** True when `text` contains at least one boundary-valid verse or section marker. */
export function hasVerseMarker(text: string): boolean {
  if (execVerseMarker(getVerseRegex(), text) !== null) return true;
  return execRomanSectionMarker(getRomanSectionRegex(), text) !== null;
}

/**
 * Splits a verse marker token (e.g. "[5]" or "[5a]") into its numeric verse
 * and optional authored part letters. Returns `part: null` for a plain
 * numeric marker. Assumes `token` already matched VERSE_MARKER_REGEX.
 */
export function parseMarkerToken(token: string): {
  number: number;
  part: string | null;
} {
  const m = /^\[(\d+)([a-z]*)\]$/.exec(token);
  if (!m) return { number: NaN, part: null };
  return { number: parseInt(m[1], 10), part: m[2] === "" ? null : m[2] };
}

/** Zero-based index of a single-letter part ("a" → 0, "b" → 1, …). */
function partToIndex(part: string): number {
  return part.charCodeAt(0) - "a".charCodeAt(0);
}

/* ---------------------------------------------------------------------------
 * Hierarchical verses (Roman section markers + scoped children)
 * ---------------------------------------------------------------------------
 * When a note contains at least one Roman section marker ([I], [II], …),
 * Arabic [N] markers after a section and before the next section are scoped
 * children (I.1, II.3, …). [N] before the first section stays flat (verse-N).
 * ------------------------------------------------------------------------- */

/** Roman section marker: [I], [II], … — same boundary rules as [N]. */
const ROMAN_SECTION_MARKER_REGEX = /\[([IVXLCDM]+)\](?=\s|$)/g;

function getRomanSectionRegex(): RegExp {
  return new RegExp(
    ROMAN_SECTION_MARKER_REGEX.source,
    ROMAN_SECTION_MARKER_REGEX.flags
  );
}

function parseRomanNumeral(s: string): number {
  const values: Record<string, number> = {
    I: 1,
    V: 5,
    X: 10,
    L: 50,
    C: 100,
    D: 500,
    M: 1000,
  };
  let total = 0;
  let prev = 0;
  for (let i = s.length - 1; i >= 0; i--) {
    const v = values[s[i]] ?? 0;
    if (v < prev) total -= v;
    else {
      total += v;
      prev = v;
    }
  }
  return total;
}

function isValidRomanSection(s: string): boolean {
  return /^[IVXLCDM]+$/.test(s) && parseRomanNumeral(s) > 0;
}

function execRomanSectionMarker(
  re: RegExp,
  text: string
): RegExpExecArray | null {
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (atVerseBoundary(text, m.index) && isValidRomanSection(m[1])) {
      return m;
    }
  }
  return null;
}

/**
 * A verse address: flat `3` / `3a`, section-only `I`, or scoped child `I.3` /
 * `I.3a`. `number: null` means a section-only reference (verse-I).
 */
export interface VerseRef {
  section: string | null;
  number: number | null;
  part: string | null;
}

export type MarkerKind = "flat" | "section" | "child";

export interface MarkerHit {
  kind: MarkerKind;
  /** Roman section id for section/child hits; null for flat. */
  section: string | null;
  number: number;
  part: string | null;
  index: number;
  afterMarker: number;
}

export type RawMarkerToken =
  | { kind: "roman"; index: number; length: number; roman: string }
  | { kind: "numeric"; index: number; length: number; token: string };

export function nextRawMarkerToken(text: string, from: number): RawMarkerToken | null {
  const slice = text.slice(from);
  const numM = execVerseMarker(getVerseRegex(), slice);
  const numIdx = numM ? from + numM.index : -1;

  const romM = execRomanSectionMarker(getRomanSectionRegex(), slice);
  const romIdx = romM ? from + romM.index : -1;

  if (numIdx === -1 && romIdx === -1) return null;
  if (numIdx === -1 || (romIdx !== -1 && romIdx < numIdx)) {
    return {
      kind: "roman",
      index: romIdx,
      length: romM![0].length,
      roman: romM![1],
    };
  }
  return {
    kind: "numeric",
    index: numIdx,
    length: numM![0].length,
    token: numM![0],
  };
}

/**
 * Scans every verse marker in `text` in document order. Auto-detects hierarchy
 * when any Roman section marker is present (no extra pass). Respects `[///]`
 * structured-flow breaks after the first Roman marker.
 */
function scanMarkers(text: string): MarkerHit[] {
  const hits: MarkerHit[] = [];
  let pos = 0;
  let currentSection: string | null = null;
  let sawSection = false;
  let structuredFlowActive = true;
  let scopedChildrenActive = false;
  let resumableScopedChildren = false;

  while (pos < text.length) {
    const tok = nextProcessToken(text, pos);
    if (!tok) break;

    if (tok.kind === "flowBreak") {
      if (sawSection) {
        if (structuredFlowActive) {
          resumableScopedChildren = scopedChildrenActive;
          structuredFlowActive = false;
          scopedChildrenActive = false;
        } else {
          structuredFlowActive = true;
          scopedChildrenActive = resumableScopedChildren;
        }
      }
      pos = tok.index + tok.length;
      continue;
    }

    if (tok.kind === "verseBreak") {
      pos = tok.index + tok.length;
      continue;
    }

    const raw = tok.raw;
    if (raw.kind === "roman") {
      sawSection = true;
      currentSection = raw.roman;
      structuredFlowActive = true;
      scopedChildrenActive = true;
      hits.push({
        kind: "section",
        section: raw.roman,
        number: 0,
        part: null,
        index: raw.index,
        afterMarker: raw.index + raw.length,
      });
    } else {
      const { number, part } = parseMarkerToken(raw.token);
      if (!structuredFlowActive) {
        structuredFlowActive = true;
        scopedChildrenActive = false;
      }
      if (sawSection && currentSection !== null && scopedChildrenActive) {
        hits.push({
          kind: "child",
          section: currentSection,
          number,
          part,
          index: raw.index,
          afterMarker: raw.index + raw.length,
        });
      } else {
        hits.push({
          kind: "flat",
          section: null,
          number,
          part,
          index: raw.index,
          afterMarker: raw.index + raw.length,
        });
      }
    }
    pos = tok.index + tok.length;
  }
  return hits;
}

export function verseRefIsFlat(ref: VerseRef): boolean {
  return ref.section === null && ref.number !== null;
}

export function verseRefsEqual(a: VerseRef, b: VerseRef): boolean {
  return (
    a.section === b.section &&
    a.number === b.number &&
    a.part === b.part
  );
}

/** Link fragment label after `verse-` (e.g. `3`, `I`, `I.3`, `I.3a`). */
export function verseRefToLabel(ref: VerseRef): string {
  if (ref.section !== null && ref.number === null) return ref.section;
  const base =
    ref.section !== null ? `${ref.section}.${ref.number}` : `${ref.number}`;
  return ref.part ? `${base}${ref.part}` : base;
}

/**
 * Reading-view / popover / embed label for a verse ref. Anchor ids always use
 * {@link verseRefToLabel}; this controls whether scoped children include the
 * Roman parent and whether lone Roman markers are omitted at render time.
 */
export function verseRefToDisplayLabel(
  ref: VerseRef,
  showRomanParentInNested: boolean
): string {
  if (ref.section !== null && ref.number === null) return ref.section;
  if (
    ref.section !== null &&
    ref.number !== null &&
    !showRomanParentInNested
  ) {
    return ref.part ? `${ref.number}${ref.part}` : `${ref.number}`;
  }
  return verseRefToLabel(ref);
}

/**
 * True when a Roman marker at `afterRoman` should not be rendered because the
 * next marker is a scoped child of the same section with only whitespace between.
 */
export function shouldOmitLoneRomanMarker(
  text: string,
  afterRoman: number,
  romanSection: string
): boolean {
  const tok = nextProcessToken(text, afterRoman);
  if (!tok || tok.kind !== "marker" || tok.raw.kind !== "numeric") return false;
  const between = text.slice(afterRoman, tok.index);
  if (!/^\s*$/.test(between)) return false;
  const state = verseProcessStateAt(text, afterRoman);
  if (
    !state.scopedChildrenActive ||
    state.currentSection !== romanSection
  ) {
    return false;
  }
  const probe = { ...state };
  applyProcessToken(probe, tok);
  return (
    probe.openVerseRef?.section === romanSection &&
    probe.openVerseRef?.number !== null
  );
}

/** DOM / navigation id (e.g. `verse-3`, `verse-I`, `verse-I.3`). */
export function verseRefToAnchorId(ref: VerseRef): string {
  return `verse-${verseRefToLabel(ref)}`;
}

export function flatVerseRef(
  number: number,
  part: string | null = null
): VerseRef {
  return { section: null, number, part };
}

export function hitToRef(hit: MarkerHit): VerseRef | null {
  if (hit.kind === "section") {
    return { section: hit.section, number: null, part: null };
  }
  if (hit.kind === "child") {
    return {
      section: hit.section,
      number: hit.number,
      part: hit.part,
    };
  }
  return { section: null, number: hit.number, part: hit.part };
}

function refMatchesHit(ref: VerseRef, hit: MarkerHit): boolean {
  if (ref.number === null) {
    return hit.kind === "section" && hit.section === ref.section;
  }
  if (ref.section === null) {
    if (hit.kind !== "flat" || hit.number !== ref.number) return false;
    return ref.part === null || hit.part === ref.part;
  }
  if (hit.kind !== "child") return false;
  if (hit.section !== ref.section || hit.number !== ref.number) return false;
  return ref.part === null || hit.part === ref.part;
}

function findHitForRef(hits: MarkerHit[], ref: VerseRef): number {
  return hits.findIndex((h) => refMatchesHit(ref, h));
}

/** Parses one endpoint: `3`, `3a`, `I`, `I.3`, `I.3a`. */
export function parseVerseRefEndpoint(endpoint: string): VerseRef | null {
  const child = /^([IVXLCDM]+)\.(\d+)([a-z]*)$/.exec(endpoint);
  if (child && isValidRomanSection(child[1])) {
    return {
      section: child[1],
      number: parseInt(child[2], 10),
      part: child[3] === "" ? null : child[3],
    };
  }
  const section = /^([IVXLCDM]+)$/.exec(endpoint);
  if (section && isValidRomanSection(section[1])) {
    return { section: section[1], number: null, part: null };
  }
  const flat = /^(\d+)([a-z]*)$/.exec(endpoint);
  if (flat) {
    return {
      section: null,
      number: parseInt(flat[1], 10),
      part: flat[2] === "" ? null : flat[2],
    };
  }
  return null;
}

function isCitableHit(hit: MarkerHit): boolean {
  return hit.kind === "flat" || hit.kind === "child";
}

/** Index of the last child (or section if no children) belonging to `section`. */
function lastHitIndexInSection(hits: MarkerHit[], section: string): number {
  let last = -1;
  for (let i = 0; i < hits.length; i++) {
    if (hits[i].kind === "section" && hits[i].section === section) {
      last = i;
    } else if (hits[i].kind === "child" && hits[i].section === section) {
      last = i;
    }
  }
  return last;
}

function rangeStartHitIndex(hits: MarkerHit[], ref: VerseRef): number {
  if (ref.number === null) {
    return hits.findIndex(
      (h) => h.kind === "section" && h.section === ref.section
    );
  }
  return findHitForRef(hits, ref);
}

function rangeEndHitIndex(hits: MarkerHit[], ref: VerseRef): number {
  if (ref.number === null) {
    return lastHitIndexInSection(hits, ref.section!);
  }
  return findHitForRef(hits, ref);
}

function contentEndBeforeNextHit(
  text: string,
  hits: MarkerHit[],
  hitIndex: number
): number {
  const nextIdx = hitIndex + 1;
  if (nextIdx < hits.length) {
    return lineLeadStart(text, hits[nextIdx].index);
  }
  return text.length;
}

/* ---------------------------------------------------------------------------
 * Verse content extraction — multi-line and heading-split support
 * ---------------------------------------------------------------------------
 * A verse's content runs from the single space after its ']' up to the next
 * verse marker (which may be many lines later and/or inside a blockquote),
 * or to end of text if no further markers exist.
 *
 * The content is split into lettered sub-parts at two kinds of boundary:
 *   1. ATX headings (#..######) inside the span.
 *   2. *Interior* footnote references `[^id]` — a footnote that has verse
 *      text on BOTH sides of it (so footnotes at the very start/end of the
 *      verse, or sitting on a heading line, never split it).
 *   part "a" → text up to the first boundary
 *   part "b" → text between the first and second boundary
 *   ...
 * Heading lines (and any footnote on them) are never included in any part.
 * A reference without a part (verse-N) returns the parts joined by a single
 * space so the boundary-adjacent newlines don't leak through.
 *
 * A verse-break `[//]` (on its own line or inline) toggles between verse text
 * and editorial asides. Odd gaps (after 1st, 3rd, … break) are excluded; even
 * gaps (after 2nd, 4th, …) are verse again until the next `[N]` marker.
 *
 * A structured-flow break `[///]` (after the first Roman marker) toggles
 * between hierarchical citation and outside-flow plain text. While off, `[N]`
 * markers are flat; a Roman marker or `[///]` resume restores scoped children.
 * ------------------------------------------------------------------------- */

/** ATX-style heading line: optional indent, 1–6 `#`, at least one non-space char after. */
const HEADING_LINE_REGEX = /^\s*#{1,6}\s+\S.*$/;

/** Literal verse-break token (inline or on its own line). */
export const VERSE_BREAK_TOKEN = "[//]";

/** Structured-flow break — exits Roman + nested verse flow until resumed. */
export const SECTION_FLOW_BREAK_TOKEN = "[///]";

function isEscapedToken(text: string, index: number): boolean {
  return index > 0 && text[index - 1] === "\\";
}

/**
 * Index of the first `[//]` in `text` at or after `from`, or -1. Ignores a
 * backslash escape immediately before the token and does not match the prefix
 * of `[///]`.
 */
export function findVerseBreakIndex(
  text: string,
  from = 0,
  limit = text.length
): number {
  let pos = from;
  while (pos < limit) {
    const idx = text.indexOf(VERSE_BREAK_TOKEN, pos);
    if (idx === -1 || idx >= limit) return -1;
    if (isEscapedToken(text, idx)) {
      pos = idx + VERSE_BREAK_TOKEN.length;
      continue;
    }
    if (text.slice(idx, idx + SECTION_FLOW_BREAK_TOKEN.length) === SECTION_FLOW_BREAK_TOKEN) {
      pos = idx + 1;
      continue;
    }
    return idx;
  }
  return -1;
}

/** Index of the first `[///]` in `text` at or after `from`, or -1. */
export function findSectionFlowBreakIndex(
  text: string,
  from = 0,
  limit = text.length
): number {
  let pos = from;
  while (pos < limit) {
    const idx = text.indexOf(SECTION_FLOW_BREAK_TOKEN, pos);
    if (idx === -1 || idx >= limit) return -1;
    if (isEscapedToken(text, idx)) {
      pos = idx + SECTION_FLOW_BREAK_TOKEN.length;
      continue;
    }
    return idx;
  }
  return -1;
}

/**
 * True when `line` is only `[//]` (optional blockquote / indent). Optional
 * trailing spaces on the line are allowed.
 */
export function isVerseBreakLine(line: string): boolean {
  return /^\s*(?:>\s?)*\[\/\/\]\s*$/.test(line);
}

/** True when `line` is only `[///]` (optional blockquote / indent). */
export function isSectionFlowBreakLine(line: string): boolean {
  return /^\s*(?:>\s?)*\[\/\/\/\]\s*$/.test(line);
}

export type ProcessToken =
  | { kind: "marker"; index: number; length: number; raw: RawMarkerToken }
  | { kind: "verseBreak"; index: number; length: number }
  | { kind: "flowBreak"; index: number; length: number };

/** Next verse/section marker, `[//]`, or `[///]` in document order. */
export function nextProcessToken(
  text: string,
  from: number,
  limit = text.length
): ProcessToken | null {
  const flowRel = findSectionFlowBreakIndex(text, from, limit);
  const flowIdx = flowRel === -1 ? -1 : flowRel;
  const brIdx = findVerseBreakIndex(text, from, limit);
  const raw = nextRawMarkerToken(text, from);
  const markerIdx = raw && raw.index < limit ? raw.index : -1;

  let bestIdx = -1;
  let best: ProcessToken | null = null;

  if (flowIdx !== -1 && (bestIdx === -1 || flowIdx < bestIdx)) {
    bestIdx = flowIdx;
    best = {
      kind: "flowBreak",
      index: flowIdx,
      length: SECTION_FLOW_BREAK_TOKEN.length,
    };
  }
  if (brIdx !== -1 && (bestIdx === -1 || brIdx < bestIdx)) {
    bestIdx = brIdx;
    best = {
      kind: "verseBreak",
      index: brIdx,
      length: VERSE_BREAK_TOKEN.length,
    };
  }
  if (markerIdx !== -1 && (bestIdx === -1 || markerIdx < bestIdx) && raw) {
    best = {
      kind: "marker",
      index: markerIdx,
      length: raw.length,
      raw,
    };
  }
  return best;
}

/** Reading-view / flash state after markers, `[//]`, and `[///]` in source order. */
export interface VerseProcessState {
  inVerseSpan: boolean;
  inVerseMode: boolean;
  /** Roman section prose span is open (after `[I]`, before next `[II]`). */
  inSectionSpan: boolean;
  /** False in outside-flow gaps opened by `[///]`. */
  structuredFlowActive: boolean;
  /** When true, `[N]` after `[I]` classify as scoped children. */
  scopedChildrenActive: boolean;
  /** Active Roman section when hierarchy is in use. */
  currentSection: string | null;
  sawSection: boolean;
  /** Open citable unit before a `[///]` off toggle (for resume). */
  resumableRef: VerseRef | null;
  /** Current open verse address while structured flow is active. */
  openVerseRef: VerseRef | null;
}

export function defaultVerseProcessState(): VerseProcessState {
  return {
    inVerseSpan: false,
    inVerseMode: true,
    inSectionSpan: false,
    structuredFlowActive: true,
    scopedChildrenActive: false,
    currentSection: null,
    sawSection: false,
    resumableRef: null,
    openVerseRef: null,
  };
}

function currentResumableRef(state: VerseProcessState): VerseRef | null {
  if (state.openVerseRef) return { ...state.openVerseRef };
  if (state.inSectionSpan && state.currentSection) {
    return { section: state.currentSection, number: null, part: null };
  }
  return null;
}

function restoreResumableRef(state: VerseProcessState): void {
  const ref = state.resumableRef;
  if (!ref) {
    state.inVerseSpan = false;
    state.inSectionSpan = false;
    state.inVerseMode = true;
    state.openVerseRef = null;
    state.scopedChildrenActive = false;
    return;
  }
  if (ref.number === null && ref.section) {
    state.currentSection = ref.section;
    state.sawSection = true;
    state.inSectionSpan = true;
    state.inVerseSpan = false;
    state.scopedChildrenActive = true;
    state.openVerseRef = null;
  } else if (ref.section) {
    state.currentSection = ref.section;
    state.sawSection = true;
    state.inSectionSpan = true;
    state.inVerseSpan = true;
    state.scopedChildrenActive = true;
    state.openVerseRef = { ...ref };
  } else {
    state.inSectionSpan = false;
    state.inVerseSpan = true;
    state.scopedChildrenActive = false;
    state.openVerseRef = { ...ref };
  }
  state.inVerseMode = true;
}

/** Applies one scanned process token to `state` (mutates in place). */
export function applyProcessToken(
  state: VerseProcessState,
  tok: ProcessToken
): void {
  if (tok.kind === "flowBreak") {
    if (!state.sawSection) return;
    if (state.structuredFlowActive) {
      state.resumableRef = currentResumableRef(state);
      state.structuredFlowActive = false;
      state.scopedChildrenActive = false;
      state.inVerseSpan = false;
      state.inSectionSpan = false;
      state.inVerseMode = true;
      state.openVerseRef = null;
    } else {
      state.structuredFlowActive = true;
      restoreResumableRef(state);
      state.resumableRef = null;
    }
    return;
  }

  if (tok.kind === "verseBreak") {
    if (
      state.structuredFlowActive &&
      (state.inVerseSpan || state.inSectionSpan)
    ) {
      state.inVerseMode = !state.inVerseMode;
    }
    return;
  }

  if (tok.kind !== "marker") return;
  const raw = tok.raw;

  if (raw.kind === "roman") {
    state.sawSection = true;
    state.currentSection = raw.roman;
    state.inSectionSpan = true;
    state.inVerseSpan = false;
    state.inVerseMode = true;
    state.structuredFlowActive = true;
    state.scopedChildrenActive = true;
    state.openVerseRef = null;
    state.resumableRef = null;
    return;
  }

  const { number, part } = parseMarkerToken(raw.token);
  if (!state.structuredFlowActive) {
    state.structuredFlowActive = true;
    state.scopedChildrenActive = false;
  }
  state.inVerseSpan = true;
  state.inVerseMode = true;
  if (state.sawSection && state.currentSection && state.scopedChildrenActive) {
    state.inSectionSpan = true;
    state.openVerseRef = {
      section: state.currentSection,
      number,
      part,
    };
  } else {
    state.inSectionSpan = false;
    state.openVerseRef = flatVerseRef(number, part);
  }
}

/** Character offset at the start of `lineIndex` (0-based) in `text`. */
export function charOffsetForLine(text: string, lineIndex: number): number {
  if (lineIndex <= 0) return 0;
  let line = 0;
  for (let i = 0; i < text.length; i++) {
    if (line === lineIndex) return i;
    if (text[i] === "\n") line++;
  }
  return text.length;
}

/**
 * True when a closed marker at `markerEnd` is immediately followed by exactly
 * one space and an opening bracket (` [`). Obsidian's reference-link parse
 * hides the first marker's brackets in that case — e.g. `[1] [^1]` or
 * `[I] [1]`. The Live Preview replace widget guards both numeric and Roman
 * section markers.
 */
export function isFollowedByFootnoteRef(
  text: string,
  markerEnd: number
): boolean {
  return /^ \[/.test(text.slice(markerEnd));
}

/**
 * Verse/editorial toggle state in `text` immediately before `endOffset`, by
 * scanning `[N]` markers and `[//]` breaks from the start of the file.
 */
export function verseProcessStateAt(
  text: string,
  endOffset: number
): VerseProcessState {
  const state = defaultVerseProcessState();
  let pos = 0;
  const limit = Math.min(endOffset, text.length);
  while (pos < limit) {
    const tok = nextProcessToken(text, pos, limit);
    if (!tok) break;
    applyProcessToken(state, tok);
    pos = tok.index + tok.length;
  }
  return state;
}

/** Strips one level of leading "> " blockquote marker from a line. */
function stripBlockquoteMarker(line: string): string {
  return line.replace(/^\s*>\s?/, "");
}

/**
 * Drops outside-flow prose between `[///]` toggles while keeping verse/section
 * markers. No-op on `[///]` before the first Roman marker in `raw`.
 */
function stripStructuredFlowGaps(raw: string): string {
  const parts: string[] = [];
  let inStructured = true;
  let sawSection = false;
  let pos = 0;
  while (pos < raw.length) {
    const tok = nextProcessToken(raw, pos);
    if (!tok) {
      if (inStructured) parts.push(raw.slice(pos));
      break;
    }

    if (inStructured) {
      parts.push(raw.slice(pos, tok.index + tok.length));
      if (tok.kind === "flowBreak" && sawSection) {
        inStructured = false;
      } else if (tok.kind === "marker" && tok.raw.kind === "roman") {
        sawSection = true;
      }
    } else if (tok.kind === "flowBreak" && sawSection) {
      inStructured = true;
    } else if (tok.kind === "marker" && tok.raw.kind === "roman") {
      sawSection = true;
      inStructured = true;
      parts.push(raw.slice(tok.index, tok.index + tok.length));
    } else if (tok.kind === "marker" && tok.raw.kind === "numeric") {
      inStructured = true;
      parts.push(raw.slice(tok.index, tok.index + tok.length));
    }

    pos = tok.index + tok.length;
  }
  return parts.join("");
}

/**
 * Keeps verse-mode spans and drops editorial spans between alternating `[//]`
 * toggles (1st gap editorial, 2nd gap verse again, etc.).
 */
function stripEditorialBreaks(raw: string): string {
  const parts: string[] = [];
  let inVerse = true;
  let pos = 0;
  while (pos < raw.length) {
    const br = findVerseBreakIndex(raw, pos);
    if (br === -1) {
      if (inVerse) parts.push(raw.slice(pos));
      break;
    }
    if (inVerse) parts.push(raw.slice(pos, br));
    inVerse = !inVerse;
    pos = br + VERSE_BREAK_TOKEN.length;
  }
  return parts.join("");
}

/** Removes `[///]` outside-flow gaps, then `[//]` editorial gaps. */
export function stripCitationGaps(raw: string): string {
  return stripEditorialBreaks(stripStructuredFlowGaps(raw));
}

/**
 * Returns the offset in `text` where the paragraph enclosing `offset`
 * begins. Paragraphs break at blank lines and ATX headings (blockquote
 * markers stripped when testing), mirroring Obsidian's inline highlight scope.
 */
function paragraphStartAt(text: string, offset: number): number {
  let lineStart = text.lastIndexOf("\n", offset - 1) + 1;
  while (lineStart > 0) {
    const prevLineEnd = lineStart - 1;
    const prevLineStart = text.lastIndexOf("\n", prevLineEnd - 1) + 1;
    const prevLine = text.slice(prevLineStart, prevLineEnd);
    const stripped = stripBlockquoteMarker(prevLine);
    if (/^\s*$/.test(stripped) || HEADING_LINE_REGEX.test(stripped)) break;
    lineStart = prevLineStart;
  }
  return lineStart;
}

/**
 * Scans `text[start..end)` for `==` highlight delimiters (Obsidian syntax),
 * returning whether a highlight is open at `end`. Resets are implicit via the
 * caller limiting `start` to a paragraph boundary. Ignores `\==` escapes and
 * `==` inside inline backticks or fenced ``` blocks.
 */
function highlightOpenAt(text: string, offset: number): boolean {
  const start = paragraphStartAt(text, offset);
  let open = false;
  let inInlineCode = false;
  let inFence = false;
  let i = start;

  while (i < offset) {
    if (text.slice(i, i + 3) === "```") {
      if (!inInlineCode) {
        inFence = !inFence;
        i += 3;
        continue;
      }
    }

    if (!inFence) {
      if (text[i] === "`") {
        inInlineCode = !inInlineCode;
        i++;
        continue;
      }
      if (!inInlineCode && text.slice(i, i + 2) === "==") {
        if (i > start && text[i - 1] === "\\") {
          i += 2;
          continue;
        }
        open = !open;
        i += 2;
        continue;
      }
    }
    i++;
  }
  return open;
}

/**
 * Prepends `==` after the first line's blockquote/whitespace lead-in so a
 * blockquoted verse keeps valid `> ==text` structure.
 */
function prependHighlightOpener(slice: string): string {
  const nl = slice.indexOf("\n");
  const firstLine = nl === -1 ? slice : slice.slice(0, nl);
  const rest = nl === -1 ? "" : slice.slice(nl);
  const lead = /^(\s*(?:>\s?)*)/.exec(firstLine);
  const prefix = lead ? lead[1] : "";
  return `${prefix}==${firstLine.slice(prefix.length)}${rest}`;
}

/**
 * When a raw markdown slice is cut from a larger note, `==` pairs that span
 * the cut may be unbalanced. Prepends/closes highlight markers so the slice
 * renders with the same highlighting as the source document.
 */
function balanceHighlights(
  slice: string,
  fullText: string,
  sliceStart: number,
  sliceEnd: number
): string {
  let result = slice;
  if (highlightOpenAt(fullText, sliceStart)) {
    result = prependHighlightOpener(result);
  }
  if (highlightOpenAt(fullText, sliceEnd)) {
    result = `${result}==`;
  }
  return result;
}

/**
 * Splits one heading-delimited segment further at *interior* footnote
 * references. A footnote `[^id]` creates a boundary only when there is
 * verse text on BOTH sides of it within the segment, so a footnote at the
 * segment's very start or end (or one standing alone) never splits it. The
 * cut falls immediately after the footnote token, keeping the marker
 * attached to the text it annotates.
 */
function splitSegmentByFootnotes(segment: string): string[] {
  const re = new RegExp(FOOTNOTE_REF_REGEX.source, "g");
  const parts: string[] = [];
  let lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(segment)) !== null) {
    const cut = m.index + m[0].length;
    if (/\S/.test(segment.slice(lastIndex, m.index)) && /\S/.test(segment.slice(cut))) {
      parts.push(segment.slice(lastIndex, cut));
      lastIndex = cut;
    }
  }
  parts.push(segment.slice(lastIndex));
  return parts;
}

/**
 * Groups a verse's raw content into heading-delimited segments, each
 * further divided into footnote-delimited sub-parts. Reading order is
 * segment 0's parts, then segment 1's, etc. Blockquote markers are
 * stripped and heading lines are dropped (their text — and any footnote on
 * them — is never part of any verse part).
 */
function versePartSegments(rawContent: string): string[][] {
  const lines = rawContent.split("\n").map(stripBlockquoteMarker);
  const segments: string[][] = [[]];
  for (const line of lines) {
    if (HEADING_LINE_REGEX.test(line)) {
      segments.push([]);
    } else {
      segments[segments.length - 1].push(line);
    }
  }
  return segments.map((group) =>
    splitSegmentByFootnotes(group.join("\n")).map((part) => part.trim())
  );
}

/**
 * Splits a verse's raw content span into ordered parts (index 0 = "a",
 * 1 = "b", …) at heading and interior-footnote boundaries.
 */
function splitVerseParts(rawContent: string): string[] {
  return versePartSegments(rawContent).flat();
}

function findVerseSpanByRef(
  text: string,
  ref: VerseRef
): { start: number; end: number } | null {
  const hits = scanMarkers(text);
  const idx = findHitForRef(hits, ref);
  if (idx === -1) return null;
  const hit = hits[idx];
  if (!isCitableHit(hit)) return null;
  if (text[hit.afterMarker] !== " ") return null;
  const spanStart = hit.afterMarker + 1;
  const spanEnd = idx + 1 < hits.length ? hits[idx + 1].index : text.length;
  return { start: spanStart, end: spanEnd };
}

/**
 * Locates a flat verse's content span in the text.
 * Returns null if the verse is not found, or if the marker is not followed
 * by a single space (malformed marker).
 */
function findVerseSpan(
  text: string,
  verseNumber: number
): { start: number; end: number } | null {
  return findVerseSpanByRef(text, flatVerseRef(verseNumber));
}

/**
 * Source offsets for verse-mode spans between `[//]` toggles in `[from, to)`.
 * Editorial gaps are omitted (for navigation flash in Live Preview).
 */
function verseModeSourceIntervals(
  text: string,
  from: number,
  to: number
): Array<{ from: number; to: number }> {
  const out: Array<{ from: number; to: number }> = [];
  let inVerse = true;
  let pos = from;
  while (pos < to) {
    const br = findVerseBreakIndex(text, pos);
    if (br === -1 || br >= to) {
      if (inVerse && pos < to && /\S/.test(text.slice(pos, to))) {
        out.push({ from: pos, to });
      }
      break;
    }
    if (inVerse && br > pos && /\S/.test(text.slice(pos, br))) {
      out.push({ from: pos, to: br });
    }
    inVerse = !inVerse;
    pos = br + VERSE_BREAK_TOKEN.length;
  }
  return out;
}

/**
 * Footnote reference syntax: `[^id]` not followed by `:` (which would
 * make it a definition).
 */
const FOOTNOTE_REF_REGEX = /\[\^([^\]\s]+)\](?!:)/g;

/**
 * Footnote definition syntax: `[^id]:` at the start of a line.
 */
const FOOTNOTE_DEF_HEAD_REGEX = /^\[\^([^\]\s]+)\]:/;

/**
 * Character offset of the first footnote *definition* line (`[^id]:`) at or
 * after `searchFrom`, or null. Inline refs in verse text are not matched.
 */
function footnoteDefinitionsBlockStart(
  text: string,
  searchFrom: number
): number | null {
  let offset = 0;
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (
      offset >= searchFrom &&
      FOOTNOTE_DEF_HEAD_REGEX.test(stripBlockquoteMarker(line))
    ) {
      return offset;
    }
    offset += line.length + (i < lines.length - 1 ? 1 : 0);
  }
  return null;
}

function mergeAdjacentSourceRanges(
  ranges: Array<{ from: number; to: number }>
): Array<{ from: number; to: number }> {
  if (ranges.length === 0) return ranges;
  const sorted = [...ranges].sort((a, b) => a.from - b.from);
  const merged: Array<{ from: number; to: number }> = [sorted[0]];
  for (let i = 1; i < sorted.length; i++) {
    const prev = merged[merged.length - 1];
    const cur = sorted[i];
    if (cur.from <= prev.to) {
      prev.to = Math.max(prev.to, cur.to);
    } else {
      merged.push({ ...cur });
    }
  }
  return merged;
}

/** Drop trailing whitespace from a half-open source range (flash highlight). */
function trimTrailingWhitespaceRange(
  text: string,
  from: number,
  to: number
): { from: number; to: number } | null {
  let end = to;
  while (end > from && /\s/.test(text[end - 1])) end--;
  if (end <= from || !/\S/.test(text.slice(from, end))) return null;
  return { from, to: end };
}

function verseNumberAtMarker(text: string, offset: number): number | null {
  const slice = text.slice(offset);
  const m = execVerseMarker(getVerseRegex(), slice);
  if (!m || m.index !== 0) return null;
  return parseMarkerToken(m[0]).number;
}

function hitInNumericRange(hit: MarkerHit, start: number, end: number): boolean {
  if (!isCitableHit(hit)) return false;
  if (hit.kind === "child") return false;
  return hit.number >= start && hit.number <= end;
}

/** True when no verse body text remains between `afterLine` and `before`. */
function isEmptyTail(text: string, afterLine: number, before: number): boolean {
  let tail = text.slice(afterLine, before);
  const foot = footnoteDefinitionsBlockStart(text, afterLine);
  if (foot !== null && foot < before) {
    tail = text.slice(afterLine, foot);
  }
  return !/\S/.test(tail);
}

/**
 * First ATX heading in `[searchFrom, searchBefore)` whose following tail is
 * empty (trailing section heading after the verse). Interior heading-split
 * headings have content after them and are not returned.
 */
function trailingHeadingStartInSpan(
  text: string,
  searchFrom: number,
  searchBefore: number
): number | null {
  let offset = 0;
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (
      offset >= searchFrom &&
      offset < searchBefore &&
      HEADING_LINE_REGEX.test(stripBlockquoteMarker(line))
    ) {
      const afterLine =
        offset + line.length + (i < lines.length - 1 ? 1 : 0);
      if (isEmptyTail(text, afterLine, searchBefore)) {
        return offset;
      }
    }
    offset += line.length + (i < lines.length - 1 ? 1 : 0);
  }
  return null;
}

/**
 * End offset for flashing verse content in Live Preview — mirrors reading-view
 * stops at footnotes always and at trailing headings when the next verse is not
 * in the reference.
 */
function markerTokenRangeForVerse(
  text: string,
  verseNumber: number
): { from: number; to: number } | null {
  const hits = scanMarkers(text);
  const idx = hits.findIndex(
    (h) => h.kind === "flat" && h.number === verseNumber
  );
  if (idx === -1) return null;
  return { from: hits[idx].index, to: hits[idx].afterMarker };
}

function markerTokenRangeForRef(
  text: string,
  ref: VerseRef
): { from: number; to: number } | null {
  const hits = scanMarkers(text);
  const idx = findHitForRef(hits, ref);
  if (idx === -1 || !isCitableHit(hits[idx])) return null;
  return { from: hits[idx].index, to: hits[idx].afterMarker };
}

/** One contiguous highlighted run (disjoint segments produce separate runs). */
export interface VerseFlashRun {
  ranges: Array<{ from: number; to: number }>;
  capStart: boolean;
  capEnd: boolean;
}

export function getVerseFlashRuns(
  text: string,
  segments: VerseSegment[]
): VerseFlashRun[] {
  const hits = scanMarkers(text);
  const runs: VerseFlashRun[] = [];

  for (const seg of segments) {
    const startIdx = rangeStartHitIndex(hits, seg.start);
    const endIdx = rangeEndHitIndex(hits, seg.end);
    if (startIdx === -1 || endIdx === -1 || startIdx > endIdx) continue;

    const parts: Array<{ from: number; to: number }> = [];
    for (let i = startIdx; i <= endIdx; i++) {
      if (!isCitableHit(hits[i])) continue;
      const ref = hitToRef(hits[i]);
      if (!ref || ref.number === null) continue;

      const span = findVerseSpanByRef(text, ref);
      if (!span) continue;
      const marker = markerTokenRangeForRef(text, ref);
      const flashFrom = marker?.from ?? span.start;
      const spanEnd = flashSpanEndForVerseRef(text, span, hits, i, seg);
      parts.push(...verseModeSourceIntervals(text, flashFrom, spanEnd));
    }

    const ranges = mergeAdjacentSourceRanges(parts);
    if (ranges.length === 0) continue;
    const lastIdx = ranges.length - 1;
    const trimmed = trimTrailingWhitespaceRange(
      text,
      ranges[lastIdx].from,
      ranges[lastIdx].to
    );
    if (!trimmed) continue;
    ranges[lastIdx] = trimmed;
    runs.push({ ranges, capStart: true, capEnd: true });
  }
  return runs;
}

function flashSpanEndForVerseRef(
  text: string,
  span: { start: number; end: number },
  hits: MarkerHit[],
  hitIndex: number,
  seg: VerseSegment
): number {
  const endIdx = rangeEndHitIndex(hits, seg.end);
  const nextInSelection =
    hitIndex + 1 <= endIdx &&
    isCitableHit(hits[hitIndex + 1]) &&
    hitIndex + 1 <= endIdx;

  let end = span.end;
  if (!nextInSelection) {
    const heading = trailingHeadingStartInSpan(text, span.start, end);
    if (heading !== null) end = heading;
  }

  const footStart = footnoteDefinitionsBlockStart(text, span.start);
  if (footStart !== null && footStart < end) end = footStart;

  return end;
}

/**
 * Character ranges in `text` to flash for a (possibly disjoint) verse
 * reference. Respects `[//]` editorial toggles; used by Live Preview CM6 flash.
 */
export function getVerseFlashSourceRanges(
  text: string,
  segments: VerseSegment[]
): Array<{ from: number; to: number }> {
  const runs = getVerseFlashRuns(text, segments);
  return mergeAdjacentSourceRanges(runs.flatMap((run) => run.ranges));
}

/**
 * Returns the heading-split parts of a verse as an ordered array
 * (index 0 = "a", 1 = "b", …). Parts may be empty strings.
 * Returns null if the verse is not found or is malformed.
 */
export function getVerseParts(
  text: string,
  verseNumber: number
): string[] | null {
  const span = findVerseSpan(text, verseNumber);
  if (!span) return null;
  return splitVerseParts(
    stripCitationGaps(text.slice(span.start, span.end))
  );
}

/**
 * A single authored occurrence of a verse number: one `[N]`/`[Na]` marker and
 * its content (heading lines dropped, heading/footnote sub-parts joined).
 */
export interface VerseFragment {
  /** Authored part letters from the marker ("a", "bc", …) or null for `[N]`. */
  part: string | null;
  /** Clean verse text for this fragment. */
  content: string;
}

/**
 * Returns every authored fragment of `verseNumber` in document order.
 *
 * A canonical verse may be written once as a plain `[N]` block, or split by
 * the editor into scattered, separately-marked pieces ([5a]…[5b]…) that can
 * even sit out of order and be interleaved with other verses. Each marker
 * with this number yields one fragment whose content runs to the next marker
 * (of any number), with heading lines excluded and heading/footnote
 * sub-segments joined into clean prose.
 *
 * For the common single plain `[N]` verse this returns exactly one fragment
 * whose content equals the whole verse.
 */
export function getVerseFragments(
  text: string,
  verseNumber: number
): VerseFragment[] {
  return getVerseFragmentsByRef(text, flatVerseRef(verseNumber));
}

export function getVerseFragmentsByRef(
  text: string,
  ref: VerseRef
): VerseFragment[] {
  const hits = scanMarkers(text);
  const fragments: VerseFragment[] = [];
  for (let i = 0; i < hits.length; i++) {
    if (!refMatchesHit(ref, hits[i])) continue;
    if (!isCitableHit(hits[i])) continue;
    if (text[hits[i].afterMarker] !== " ") continue;
    const contentStart = hits[i].afterMarker + 1;
    const hardEnd = i + 1 < hits.length ? hits[i + 1].index : text.length;
    const raw = balanceHighlights(
      text.slice(contentStart, hardEnd),
      text,
      contentStart,
      hardEnd
    );
    const content = splitVerseParts(stripCitationGaps(raw))
      .filter((p) => p.length > 0)
      .join(" ");
    fragments.push({ part: hits[i].part, content });
  }
  return fragments;
}

/**
 * Returns the text content of a verse (or a specific part of it).
 * - `part` null → full content. A plain `[N]` verse joins its heading/footnote
 *   sub-parts; a verse authored as scattered fragments ([5a]…[5b]…) joins
 *   those fragments in document order.
 * - `part` "a"/"b"/…  → an authored fragment with that exact part if one
 *   exists, otherwise (for a single plain `[N]` verse) the 0-indexed
 *   heading/footnote-split segment.
 * Returns null if the verse or requested part does not exist.
 */
export function getVerseContent(
  text: string,
  verseNumber: number,
  part: string | null = null
): string | null {
  return getVerseContentByRef(text, flatVerseRef(verseNumber, part));
}

export function getVerseContentByRef(
  text: string,
  ref: VerseRef
): string | null {
  if (ref.number === null) {
    const hits = scanMarkers(text);
    const secIdx = hits.findIndex(
      (h) => h.kind === "section" && h.section === ref.section
    );
    if (secIdx === -1) return null;
    const nextIdx = secIdx + 1;
    const end =
      nextIdx < hits.length ? hits[nextIdx].index : text.length;
    const raw = stripCitationGaps(
      text.slice(hits[secIdx].afterMarker + 1, end)
    );
    return raw.trim().length > 0 ? raw.trim() : null;
  }

  const part = ref.part;
  const baseRef: VerseRef = { ...ref, part: null };
  const fragments = getVerseFragmentsByRef(text, baseRef);
  if (fragments.length === 0) return null;

  if (part !== null) {
    const explicit = fragments.find((f) => f.part === part);
    if (explicit) return explicit.content;

    if (fragments.length === 1 && fragments[0].part === null) {
      const span = findVerseSpanByRef(text, baseRef);
      if (!span) return null;
      const parts = splitVerseParts(
        stripCitationGaps(text.slice(span.start, span.end))
      );
      const idx = partToIndex(part);
      if (idx < 0 || idx >= parts.length) return null;
      return parts[idx];
    }
    return null;
  }

  return fragments
    .map((f) => f.content)
    .filter((c) => c.length > 0)
    .join(" ");
}

/**
 * Returns the blockquote prefix (e.g. "> " or "> > " for nested quotes) of
 * the source line carrying `verseNumber`'s marker, or "" if the verse is
 * not inside a blockquote.
 *
 * Verse-content extraction strips `>` markers so the text reads cleanly,
 * which means synthesized popover content loses its quote-block styling.
 * Callers use this to re-wrap that content in the same blockquote level the
 * source uses, restoring the quote bar in the hover preview.
 */
export function verseBlockquotePrefix(
  text: string,
  verseNumber: number
): string {
  return verseBlockquotePrefixByRef(text, flatVerseRef(verseNumber));
}

export function verseBlockquotePrefixByRef(
  text: string,
  ref: VerseRef
): string {
  const hits = scanMarkers(text);
  const idx = findHitForRef(hits, ref);
  if (idx === -1 || !isCitableHit(hits[idx])) return "";
  const markerIndex = hits[idx].index;
  const lineStart = text.lastIndexOf("\n", markerIndex - 1) + 1;
  const prefix = /^(\s*(?:>\s?)+)/.exec(text.slice(lineStart, markerIndex));
  return prefix ? prefix[1] : "";
}

/**
 * Raw markdown slice for a reference range (flat or hierarchical).
 */
export function getVerseRangeRawTextByRef(
  text: string,
  startRef: VerseRef,
  endRef: VerseRef
): string | null {
  const bounds = verseRangeSourceBounds(text, startRef, endRef);
  if (!bounds) return null;

  let raw = text.slice(bounds.startPos, bounds.contentEnd);
  const trimmedLen = raw.trimEnd().length;
  raw = raw.slice(0, trimmedLen);
  raw = balanceHighlights(
    raw,
    text,
    bounds.startPos,
    bounds.startPos + trimmedLen
  );
  raw = stripCitationGaps(raw);
  return stripTrailingHeadingsBeforeNextVerse(raw);
}

/** Source offset in `text` where a range raw slice begins (for hierarchical LP styling). */
export function getVerseRangeSourceStart(
  text: string,
  startRef: VerseRef,
  endRef: VerseRef
): number | null {
  return verseRangeSourceBounds(text, startRef, endRef)?.startPos ?? null;
}

/** Source offset of the marker for `ref` (section or child). */
export function getSourceStartForRef(
  text: string,
  ref: VerseRef
): number | null {
  const hits = scanMarkers(text);
  const idx = rangeStartHitIndex(hits, ref);
  if (idx === -1) return null;
  return lineLeadStart(text, hits[idx].index);
}

function verseRangeSourceBounds(
  text: string,
  startRef: VerseRef,
  endRef: VerseRef
): { startPos: number; contentEnd: number } | null {
  const hits = scanMarkers(text);
  const startIdx = rangeStartHitIndex(hits, startRef);
  const endIdx = rangeEndHitIndex(hits, endRef);
  if (startIdx === -1 || endIdx === -1 || startIdx > endIdx) return null;

  const startPos = lineLeadStart(text, hits[startIdx].index);
  const contentEnd = contentEndBeforeNextHit(text, hits, endIdx);
  return { startPos, contentEnd };
}

/**
 * Returns the raw markdown source covering a flat verse-number range, as the
 * *literal document span* from the first marker whose number falls in
 * [start, end] to the end of the last such marker's content.
 *
 * Because the cited verses may be scattered and interleaved (e.g. document
 * order 6b, 5a, 6a, 7, 5b for a 5:6 reference), the span is bounded by the
 * earliest and latest in-range markers in *document* order — never stopping
 * early at a number it happens to meet first. Everything physically between
 * those bounds is preserved verbatim: headings, blockquotes, inline markers,
 * and even out-of-range verses (a stray [7] caught in the middle) — all of
 * which the MarkdownRenderer + our own post-processor then style like the reading
 * view. For ordered, non-repeating verses this is identical to the previous
 * "start marker → marker after end" behavior.
 *
 * Returns null if no marker in [start, end] is found.
 */
export function getVerseRangeRawText(
  text: string,
  start: number,
  end: number
): string | null {
  const hits = scanMarkers(text);
  let firstIdx = -1;
  let lastIdx = -1;
  for (let i = 0; i < hits.length; i++) {
    if (hitInNumericRange(hits[i], start, end)) {
      if (firstIdx === -1) firstIdx = i;
      lastIdx = i;
    }
  }

  if (firstIdx === -1) return null;

  const startPos = lineLeadStart(text, hits[firstIdx].index);
  const contentEnd =
    lastIdx + 1 < hits.length
      ? lineLeadStart(text, hits[lastIdx + 1].index)
      : text.length;

  let raw = text.slice(startPos, contentEnd);
  const trimmedLen = raw.trimEnd().length;
  raw = raw.slice(0, trimmedLen);
  raw = balanceHighlights(raw, text, startPos, startPos + trimmedLen);
  raw = stripCitationGaps(raw);
  return stripTrailingHeadingsBeforeNextVerse(raw);
}

/**
 * For a verse marker at `markerIndex`, returns the offset where its source
 * line's blockquote/whitespace lead-in begins, so callers can include that
 * `> ` prefix (start endpoint) or exclude it (end endpoint) cleanly.
 *
 * Falls back to `markerIndex` when the marker sits mid-line after other text
 * (inline prose verses sharing a line), so neighbouring inline content is
 * never swept in or cut off.
 */
function lineLeadStart(text: string, markerIndex: number): number {
  const lineStart = text.lastIndexOf("\n", markerIndex - 1) + 1;
  let lead = text.slice(lineStart, markerIndex);
  while (lead.length > 0 && INLINE_FORMAT_DELIM.test(lead.charAt(lead.length - 1))) {
    lead = lead.slice(0, -1);
  }
  return /^\s*(?:>\s?)*$/.test(lead) ? lineStart : markerIndex;
}

/**
 * Removes ATX headings (and surrounding blank lines) that appear only as a
 * trailing suffix after the last verse body and before the next verse marker.
 *
 * The raw range slice includes everything up to the next `[N]` marker, so a
 * section heading placed after the final paragraph of verse `end` — but still
 * before verse `end+1` — would otherwise show in the hover popover even
 * though it is not part of the verse text (heading lines are excluded from
 * `getVerseParts` / reading flow for splits).
 */
function stripTrailingHeadingsBeforeNextVerse(raw: string): string {
  const lines = raw.split("\n");
  let end = lines.length;
  while (end > 0) {
    let i = end - 1;
    // Treat blank and blockquote-only ("> ") lines alike when skipping, so a
    // trailing heading is still found past empty quote lines in poem verses.
    while (i >= 0 && /^\s*$/.test(stripBlockquoteMarker(lines[i]))) i--;
    if (i < 0) {
      end = 0;
      break;
    }
    if (HEADING_LINE_REGEX.test(stripBlockquoteMarker(lines[i]))) {
      end = i;
      continue;
    }
    break;
  }
  return lines.slice(0, end).join("\n").trimEnd();
}

/**
 * Scans `slice` for footnote references whose definitions are missing
 * from the slice itself, then appends those definitions (looked up in
 * `fullText`) so the rendered popover can resolve them.
 *
 * Why this is needed: footnote definitions in Obsidian conventionally
 * live at the bottom of a note, well outside the verse-range slice we
 * pass to MarkdownRenderer. Without their definitions, references like
 * `[^1]` render as a bare unstyled number with no popup and no
 * footnote section below.
 *
 * Definitions that already appear inside the slice (e.g. when the user
 * keeps a footnote inline right after the verse) are left untouched —
 * we only append the ones that would otherwise be unresolved.
 */
export function appendMissingFootnoteDefinitions(
  slice: string,
  fullText: string
): string {
  const referenced = new Set<string>();
  let m: RegExpExecArray | null;

  const refRe = new RegExp(FOOTNOTE_REF_REGEX.source, FOOTNOTE_REF_REGEX.flags);
  while ((m = refRe.exec(slice)) !== null) {
    referenced.add(m[1]);
  }
  if (referenced.size === 0) return slice;

  const sliceLines = slice.split("\n");
  for (const line of sliceLines) {
    const head = FOOTNOTE_DEF_HEAD_REGEX.exec(line);
    if (head) referenced.delete(head[1]);
  }
  if (referenced.size === 0) return slice;

  const fullLines = fullText.split("\n");
  const appended: string[] = [];
  for (let i = 0; i < fullLines.length; i++) {
    const head = FOOTNOTE_DEF_HEAD_REGEX.exec(fullLines[i]);
    if (!head) continue;
    if (!referenced.has(head[1])) continue;

    const block: string[] = [fullLines[i]];
    let j = i + 1;
    while (j < fullLines.length) {
      const next = fullLines[j];
      // Continuation: blank line or indented (4+ spaces / tab) line.
      if (next === "" || /^[ \t]/.test(next)) {
        block.push(next);
        j++;
      } else {
        break;
      }
    }
    while (block.length > 0 && block[block.length - 1] === "") block.pop();
    appended.push(block.join("\n"));
    referenced.delete(head[1]);
    if (referenced.size === 0) break;
  }

  if (appended.length === 0) return slice;
  return `${slice}\n\n${appended.join("\n\n")}`;
}

function footnoteIdHasDefinition(text: string, id: string): boolean {
  for (const line of text.split("\n")) {
    const head = FOOTNOTE_DEF_HEAD_REGEX.exec(line);
    if (head && head[1] === id) return true;
  }
  return false;
}

/**
 * Removes `[^id]` references that have no definition in `slice` or `fullText`,
 * so they do not render as bare numbers when definitions are omitted.
 */
export function stripUnresolvedFootnoteRefs(
  slice: string,
  fullText: string
): string {
  const refRe = new RegExp(FOOTNOTE_REF_REGEX.source, FOOTNOTE_REF_REGEX.flags);
  return slice.replace(refRe, (match, id: string) => {
    if (footnoteIdHasDefinition(slice, id) || footnoteIdHasDefinition(fullText, id)) {
      return match;
    }
    return "";
  });
}

/** Removes every inline `[^id]` reference from `slice`. */
export function stripAllFootnoteRefs(slice: string): string {
  const refRe = new RegExp(FOOTNOTE_REF_REGEX.source, FOOTNOTE_REF_REGEX.flags);
  return slice.replace(refRe, "");
}

/**
 * Appends missing footnote definitions, then drops refs that still cannot resolve.
 */
export function finalizePreviewMarkdown(slice: string, fullText: string): string {
  return stripUnresolvedFootnoteRefs(
    appendMissingFootnoteDefinitions(slice, fullText),
    fullText
  );
}

/**
 * Returns the 0-indexed source line containing the marker for `verseNumber`,
 * or null if the verse is not present.
 *
 * Used to pre-scroll the reading view to a far-off verse so Obsidian's
 * virtualized renderer mounts the surrounding block (and our verse-N
 * anchor) before we try to scroll/flash it.
 */
export function findVerseLine(
  text: string,
  verseNumber: number
): number | null {
  return findVerseLineByRef(text, flatVerseRef(verseNumber));
}

export function findVerseLineByRef(
  text: string,
  ref: VerseRef
): number | null {
  const hits = scanMarkers(text);
  const idx = rangeStartHitIndex(hits, ref);
  if (idx === -1) return null;
  const markerIndex = hits[idx].index;
  let line = 0;
  for (let i = 0; i < markerIndex; i++) {
    if (text.charCodeAt(i) === 10) line++;
  }
  return line;
}

/**
 * Returns the number of heading-delimited parts for a given verse.
 * Returns 0 if the verse is not found.
 */
export function countVerseParts(text: string, verseNumber: number): number {
  const span = findVerseSpan(text, verseNumber);
  if (!span) return 0;
  return splitVerseParts(text.slice(span.start, span.end)).length;
}

/**
 * Computes the part-anchor id (e.g. "verse-4c") for a reading-view block
 * that is a heading-split continuation of a verse defined above it.
 * `blockStartLine` is the 0-indexed source line where the block begins.
 *
 * Only headings start new reading-view blocks, so continuation anchors are
 * always heading-driven; interior footnotes split text mid-block and get no
 * anchor of their own. But the LETTER must still account for them: it
 * reflects every boundary above the block — the headings between the verse
 * marker and the block, plus the interior footnotes inside those earlier
 * segments — so the injected anchor stays in lockstep with getVerseParts.
 *
 * Returns null when the block does not continue a split verse (no heading +
 * verse marker precede it).
 */
export function continuationPartAnchor(
  text: string,
  blockStartLine: number
): string | null {
  const lines = text.split("\n");
  let headingCount = 0;
  let verseRef: VerseRef | null = null;
  for (let i = blockStartLine - 1; i >= 0; i--) {
    const stripped = stripBlockquoteMarker(lines[i]);
    if (findVerseBreakIndex(lines[i]) !== -1) return null;
    if (HEADING_LINE_REGEX.test(stripped)) {
      headingCount++;
      continue;
    }
    const lineStart = charOffsetForLine(text, i);
    const lineEnd = lineStart + lines[i].length;
    const hit = scanMarkers(text).find(
      (h) =>
        isCitableHit(h) &&
        h.index >= lineStart &&
        h.index < lineEnd
    );
    if (hit) {
      verseRef = hitToRef(hit);
      break;
    }
  }
  if (verseRef === null || verseRef.number === null || headingCount === 0) {
    return null;
  }

  let index = headingCount;
  const span = findVerseSpanByRef(text, verseRef);
  if (span) {
    const segments = versePartSegments(text.slice(span.start, span.end));
    for (let s = 0; s < headingCount && s < segments.length; s++) {
      index += segments[s].length - 1;
    }
  }
  const letter = String.fromCharCode(97 + index);
  return verseRefToAnchorId({ ...verseRef, part: letter });
}

/**
 * Reports whether `part` of `verseNumber` has a reading-view scroll anchor.
 *
 * Only parts that BEGIN a heading-delimited segment are anchored: part "a"
 * (carried by the verse marker span) and the first part after each heading
 * (injected by the post-processor). Interior footnote parts sit mid-block
 * and get no anchor, so navigation/flash callers should fall back to the
 * whole-verse anchor for them. `null` (the whole verse) is always anchored.
 */
export function partHasAnchor(
  text: string,
  verseNumber: number,
  part: string | null
): boolean {
  return partHasAnchorByRef(text, flatVerseRef(verseNumber, part));
}

export function partHasAnchorByRef(text: string, ref: VerseRef): boolean {
  if (ref.part === null) return true;

  const base: VerseRef = { ...ref, part: null };
  if (
    scanMarkers(text).some(
      (h) => refMatchesHit({ ...base, part: ref.part }, h)
    )
  ) {
    return true;
  }

  const span = findVerseSpanByRef(text, base);
  if (!span || ref.number === null) return false;
  const segments = versePartSegments(text.slice(span.start, span.end));
  const target = partToIndex(ref.part);
  let segmentStart = 0;
  for (const segment of segments) {
    if (segmentStart === target) return true;
    segmentStart += segment.length;
  }
  return false;
}

export function firstFragmentPart(
  text: string,
  verseNumber: number
): string | null {
  return firstFragmentPartByRef(text, flatVerseRef(verseNumber));
}

export function firstFragmentPartByRef(
  text: string,
  ref: VerseRef
): string | null {
  const base: VerseRef = { ...ref, part: null };
  const first = scanMarkers(text).find((h) => refMatchesHit(base, h));
  return first ? first.part : null;
}

/**
 * Returns all verse numbers found in the given text, in order.
 */
export function getAllVerseNumbers(text: string): number[] {
  const re = getVerseRegex();
  const numbers: number[] = [];
  let match: RegExpExecArray | null;
  while ((match = execVerseMarker(re, text)) !== null) {
    numbers.push(parseMarkerToken(match[0]).number);
  }
  return numbers;
}

/* ---------------------------------------------------------------------------
 * Supported verse-reference fragment syntaxes
 * ---------------------------------------------------------------------------
 * Single verse (always recognized):
 *     [[File#verse-3]]          full verse (all fragments if it is scattered)
 *     [[File#verse-3a]]         part "a" — an authored [3a] marker if present,
 *                               else heading/footnote-split segment "a"
 *     [[File#verse-3b]]         part "b" (and so on; parts may be multi-letter
 *                               for authored markers like [12bc])
 *
 * Range (always recognized):
 *     [[File#verse-3:7]]        verses 3..7 inclusive
 *     (ranges do not accept part suffixes — reference whole verses only)
 *
 * Shorthand (opt-in via settings → "Enable shorthand reference syntax"):
 *     [[File#3]]                single
 *     [[File#3a]] [[File#3b]]   split parts
 *     [[File#3:7]]              range
 *
 * Disjoint multi-segment (always recognized):
 *     [[File#verse-4:6/8:10]]   verses 4..6 AND 8..10 (7 excluded)
 *     [[File#verse-3/5/7]]      verses 3, 5, and 7 only
 *   Segments are joined with "/" ("and also"); each segment is itself a
 *   single verse or a range, with the optional shorthand prefix applying to
 *   the whole reference. This mirrors lectionary citations such as the
 *   Spanish "Juan 3,4-6.8-10" which skip verses inside a passage.
 *
 * COLLISION NOTE on the shorthand form: if the target note has a heading
 * literally named "3", "3a", or "3:7", this plugin will hijack the link.
 * That is why shorthand is off by default. "Copy verse reference" commands
 * always emit the explicit `verse-N` form regardless of this setting.
 *
 * Two regex pairs are exported:
 *   *_STRICT — explicit form only (always used as the base)
 *   *_LOOSE  — explicit OR shorthand (used when the setting is on)
 * ------------------------------------------------------------------------- */

/**
 * Parses a verse range fragment and returns start/end with optional part
 * suffixes on either endpoint.
 *
 * Always accepts the explicit form:
 *   verse-3:7       → { start: 3, startPart: null, end: 7, endPart: null }
 *   verse-4b:25     → { start: 4, startPart: "b",  end: 25, endPart: null }
 *   verse-4:25c     → { start: 4, startPart: null, end: 25, endPart: "c"  }
 *   verse-4b:25c    → { start: 4, startPart: "b",  end: 25, endPart: "c"  }
 *
 * When `allowShorthand` is true the "verse-" prefix is optional.
 * Returns null if the fragment is not a valid range.
 */
export function parseVerseRange(
  fragment: string,
  allowShorthand: boolean = false
): { start: number; startPart: string | null; end: number; endPart: string | null } | null {
  const pattern = allowShorthand
    ? /^(?:verse-)?(\d+)([a-z]+)?:(\d+)([a-z]+)?$/
    : /^verse-(\d+)([a-z]+)?:(\d+)([a-z]+)?$/;
  const m = pattern.exec(fragment);
  if (!m) return null;
  return {
    start: parseInt(m[1], 10),
    startPart: m[2] ?? null,
    end: parseInt(m[3], 10),
    endPart: m[4] ?? null,
  };
}

/**
 * Parses a single-verse fragment and returns { verse, part }.
 * `part` is one or more lowercase letters (a/b/c/…, or authored multi-letter
 * labels like "bc") or null for the full verse.
 *
 * Always accepts the explicit "verse-3" and "verse-3a".
 * When `allowShorthand` is true, also accepts "3" and "3a".
 * Returns null if the fragment is not a valid single-verse reference.
 */
export function parseVerseSingle(
  fragment: string,
  allowShorthand: boolean = false
): { verse: number; part: string | null } | null {
  const pattern = allowShorthand
    ? /^(?:verse-)?(\d+)([a-z]+)?$/
    : /^verse-(\d+)([a-z]+)?$/;
  const m = pattern.exec(fragment);
  if (!m) return null;
  return {
    verse: parseInt(m[1], 10),
    part: m[2] ?? null,
  };
}

/**
 * One contiguous piece of a (possibly disjoint) verse reference. A single
 * verse is represented as a degenerate range where start and end refs match.
 */
export interface VerseSegment {
  start: VerseRef;
  end: VerseRef;
}

/** One reference endpoint in a segment piece: `3`, `3a`, `I`, `I.3`, `I.3a`. */
const ENDPOINT_SOURCE = String.raw`(?:[IVXLCDM]+\.\d+[a-z]*|[IVXLCDM]+|\d+[a-z]*)`;

/** A single segment piece: endpoint or endpoint:endpoint. */
const SEGMENT_SOURCE = `${ENDPOINT_SOURCE}(?::${ENDPOINT_SOURCE})?`;

function parseSegmentPiece(piece: string): VerseSegment | null {
  const colon = piece.indexOf(":");
  if (colon === -1) {
    const ref = parseVerseRefEndpoint(piece);
    if (!ref) return null;
    return { start: ref, end: ref };
  }
  const start = parseVerseRefEndpoint(piece.slice(0, colon));
  const end = parseVerseRefEndpoint(piece.slice(colon + 1));
  if (!start || !end) return null;
  return { start, end };
}

/**
 * Parses a verse reference into one or more ordered segments. Handles flat,
 * hierarchical, range, and disjoint forms:
 *   verse-3           → flat single
 *   verse-I.3         → scoped child
 *   verse-I           → whole section (intro + children in raw slices)
 *   verse-I.3:II.2    → cross-section range
 *   verse-I:II        → whole sections (raw slice)
 *   verse-I.1:I.3/II.1:II.2 → disjoint
 */
export function parseVerseSegments(
  fragment: string,
  allowShorthand: boolean = false
): VerseSegment[] | null {
  let core: string;
  if (fragment.startsWith("verse-")) {
    core = fragment.slice("verse-".length);
  } else if (allowShorthand) {
    core = fragment;
  } else {
    return null;
  }
  if (core.length === 0) return null;

  const segments: VerseSegment[] = [];
  for (const piece of core.split("/")) {
    const seg = parseSegmentPiece(piece);
    if (!seg) return null;
    segments.push(seg);
  }
  return segments;
}

export const VERSE_FRAGMENT_TEST_STRICT = new RegExp(
  `^verse-${SEGMENT_SOURCE}(?:/${SEGMENT_SOURCE})*$`
);

/** Loose: explicit OR shorthand (opt-in). Roman hierarchical stays verse- only. */
export const VERSE_FRAGMENT_TEST_LOOSE = new RegExp(
  `^(?:verse-)?${SEGMENT_SOURCE}(?:/${SEGMENT_SOURCE})*$`
);

export const VERSE_RANGE_FRAGMENT_TEST_STRICT = new RegExp(
  `^verse-${ENDPOINT_SOURCE}:${ENDPOINT_SOURCE}$`
);

export const VERSE_RANGE_FRAGMENT_TEST_LOOSE = new RegExp(
  `^(?:verse-)?${ENDPOINT_SOURCE}:${ENDPOINT_SOURCE}$`
);

export function getVersePartsByRef(
  text: string,
  ref: VerseRef
): string[] | null {
  if (ref.number === null) return null;
  const span = findVerseSpanByRef(text, ref);
  if (!span) return null;
  return splitVerseParts(
    stripCitationGaps(text.slice(span.start, span.end))
  );
}

/** Citable verse refs in document order for a segment (children/flat only). */
export function enumerateCitableRefsInSegment(
  text: string,
  seg: VerseSegment
): VerseRef[] {
  const hits = scanMarkers(text);
  const startIdx = rangeStartHitIndex(hits, seg.start);
  const endIdx = rangeEndHitIndex(hits, seg.end);
  if (startIdx === -1 || endIdx === -1 || startIdx > endIdx) return [];
  const refs: VerseRef[] = [];
  for (let i = startIdx; i <= endIdx; i++) {
    if (!isCitableHit(hits[i])) continue;
    const ref = hitToRef(hits[i]);
    if (ref && ref.number !== null) refs.push(ref);
  }
  return refs;
}

export function segmentIsDegenerateSingle(seg: VerseSegment): boolean {
  return verseRefsEqual(seg.start, seg.end);
}

/** Whether a parsed anchor ref falls inside a segment (document order). */
export function anchorRefIsInSegment(
  text: string,
  ref: VerseRef,
  seg: VerseSegment
): boolean {
  const hits = scanMarkers(text);
  const startIdx = rangeStartHitIndex(hits, seg.start);
  const endIdx = rangeEndHitIndex(hits, seg.end);
  const hitIdx = findHitForRef(hits, ref);
  if (startIdx === -1 || endIdx === -1 || hitIdx === -1) return false;
  if (hitIdx < startIdx || hitIdx > endIdx) return false;

  if (verseRefsEqual(ref, seg.start) && seg.start.part !== null) {
    if (ref.part === null) return false;
    if (ref.part.charCodeAt(0) < seg.start.part.charCodeAt(0)) return false;
  }
  if (verseRefsEqual(ref, seg.end) && seg.end.part !== null) {
    if (ref.part === null) return false;
    if (ref.part.charCodeAt(0) > seg.end.part.charCodeAt(0)) return false;
  }
  return true;
}

/** Nearest citable or section marker to `cursorOffset` in `text`. */
export function nearestVerseRefAtOffset(
  text: string,
  cursorOffset: number
): VerseRef | null {
  const hits = scanMarkers(text);
  let best: VerseRef | null = null;
  let bestDist = Infinity;
  for (const h of hits) {
    const ref = hitToRef(h);
    if (!ref) continue;
    const dist = Math.min(
      Math.abs(cursorOffset - h.index),
      Math.abs(cursorOffset - h.afterMarker)
    );
    if (dist < bestDist) {
      bestDist = dist;
      best = ref;
    }
  }
  return best;
}

/** Citable verse refs whose markers fall inside `[selFrom, selTo)`. */
export function verseRefsInSelection(
  text: string,
  selFrom: number,
  selTo: number
): VerseRef[] {
  const hits = scanMarkers(text);
  const refs: VerseRef[] = [];
  for (const h of hits) {
    if (h.index < selFrom || h.index >= selTo) continue;
    const ref = hitToRef(h);
    if (ref && ref.number !== null) refs.push(ref);
  }
  return refs;
}
