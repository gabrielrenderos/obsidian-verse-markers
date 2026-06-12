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

/** True when `text` contains at least one boundary-valid verse marker. */
export function hasVerseMarker(text: string): boolean {
  return execVerseMarker(getVerseRegex(), text) !== null;
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

interface MarkerHit {
  number: number;
  part: string | null;
  /** Offset of the opening "[". */
  index: number;
  /** Offset just past the closing "]". */
  afterMarker: number;
}

/**
 * Scans every verse marker in `text` in document order, returning its number,
 * authored part (or null), and source offsets. The single low-level primitive
 * the higher-level span/fragment/range helpers build on.
 */
function scanMarkers(text: string): MarkerHit[] {
  const re = getVerseRegex();
  const hits: MarkerHit[] = [];
  let m: RegExpExecArray | null;
  while ((m = execVerseMarker(re, text)) !== null) {
    const { number, part } = parseMarkerToken(m[0]);
    hits.push({
      number,
      part,
      index: m.index,
      afterMarker: m.index + m[0].length,
    });
  }
  return hits;
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
 * ------------------------------------------------------------------------- */

/** ATX-style heading line: optional indent, 1–6 `#`, at least one non-space char after. */
const HEADING_LINE_REGEX = /^\s*#{1,6}\s+\S.*$/;

/** Literal verse-break token (inline or on its own line). */
export const VERSE_BREAK_TOKEN = "[//]";

/**
 * Index of the first `[//]` in `text` at or after `from`, or -1. Ignores a
 * backslash escape immediately before the token. Works inline (e.g.
 * `[5] verse[//] note[//] more verse`) as well as on a dedicated line.
 */
export function findVerseBreakIndex(text: string, from = 0): number {
  let pos = from;
  while (pos < text.length) {
    const idx = text.indexOf(VERSE_BREAK_TOKEN, pos);
    if (idx === -1) return -1;
    if (idx > 0 && text[idx - 1] === "\\") {
      pos = idx + VERSE_BREAK_TOKEN.length;
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

/** Reading-view / flash state after `[N]` and `[//]` tokens in source order. */
export interface VerseProcessState {
  inVerseSpan: boolean;
  inVerseMode: boolean;
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
 * True when text at `markerEnd` begins with whitespace and an inline footnote
 * ref (`[^id]`). `[1] [^1]` is otherwise parsed as a reference link in LP.
 */
export function isFollowedByFootnoteRef(
  text: string,
  markerEnd: number
): boolean {
  return /^\s+\[\^[^\]\s]+\]/.test(text.slice(markerEnd));
}

/**
 * Verse/editorial toggle state in `text` immediately before `endOffset`, by
 * scanning `[N]` markers and `[//]` breaks from the start of the file.
 */
export function verseProcessStateAt(
  text: string,
  endOffset: number
): VerseProcessState {
  const state: VerseProcessState = { inVerseSpan: false, inVerseMode: true };
  let pos = 0;
  const limit = Math.min(endOffset, text.length);
  while (pos < limit) {
    const slice = text.slice(pos, limit);
    const brRel = findVerseBreakIndex(slice);
    const brIdx = brRel === -1 ? -1 : pos + brRel;
    const m = execVerseMarker(getVerseRegex(), slice);
    const markerIdx = m ? pos + m.index : -1;

    if (brIdx === -1 && markerIdx === -1) break;

    if (markerIdx === -1 || (brIdx !== -1 && brIdx < markerIdx)) {
      if (state.inVerseSpan) state.inVerseMode = !state.inVerseMode;
      pos = brIdx + VERSE_BREAK_TOKEN.length;
    } else {
      state.inVerseSpan = true;
      state.inVerseMode = true;
      pos = markerIdx + m![0].length;
    }
  }
  return state;
}

/** Strips one level of leading "> " blockquote marker from a line. */
function stripBlockquoteMarker(line: string): string {
  return line.replace(/^\s*>\s?/, "");
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

/**
 * Locates a verse's content span in the text.
 * Returns null if the verse is not found, or if the marker is not followed
 * by a single space (malformed marker).
 */
function findVerseSpan(
  text: string,
  verseNumber: number
): { start: number; end: number } | null {
  const re = getVerseRegex();
  let spanStart = -1;
  let spanEnd = text.length;
  let match: RegExpExecArray | null;

  while ((match = execVerseMarker(re, text)) !== null) {
    const num = parseMarkerToken(match[0]).number;
    const afterMarker = match.index + match[0].length;
    if (spanStart === -1 && num === verseNumber) {
      if (text[afterMarker] !== " ") return null;
      spanStart = afterMarker + 1;
    } else if (spanStart !== -1) {
      spanEnd = match.index;
      break;
    }
  }

  if (spanStart === -1) return null;
  return { start: spanStart, end: spanEnd };
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
 * Character ranges in `text` to flash for a (possibly disjoint) verse
 * reference. Respects `[//]` editorial toggles; used by Live Preview CM6 flash.
 */
export function getVerseFlashSourceRanges(
  text: string,
  segments: VerseSegment[]
): Array<{ from: number; to: number }> {
  const out: Array<{ from: number; to: number }> = [];
  for (const seg of segments) {
    for (let n = seg.start; n <= seg.end; n++) {
      const span = findVerseSpan(text, n);
      if (!span) continue;
      out.push(...verseModeSourceIntervals(text, span.start, span.end));
    }
  }
  return out;
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
    stripEditorialBreaks(text.slice(span.start, span.end))
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
  const hits = scanMarkers(text);
  const fragments: VerseFragment[] = [];
  for (let i = 0; i < hits.length; i++) {
    if (hits[i].number !== verseNumber) continue;
    if (text[hits[i].afterMarker] !== " ") continue; // malformed marker
    const contentStart = hits[i].afterMarker + 1;
    const hardEnd = i + 1 < hits.length ? hits[i + 1].index : text.length;
    const raw = balanceHighlights(
      text.slice(contentStart, hardEnd),
      text,
      contentStart,
      hardEnd
    );
    const content = splitVerseParts(stripEditorialBreaks(raw))
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
  const fragments = getVerseFragments(text, verseNumber);
  if (fragments.length === 0) return null;

  if (part !== null) {
    const explicit = fragments.find((f) => f.part === part);
    if (explicit) return explicit.content;

    // Derived fallback: only a single plain `[N]` verse exposes
    // heading/footnote-split parts that aren't authored markers themselves.
    if (fragments.length === 1 && fragments[0].part === null) {
      const span = findVerseSpan(text, verseNumber);
      if (!span) return null;
      const parts = splitVerseParts(
        stripEditorialBreaks(text.slice(span.start, span.end))
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
  const re = getVerseRegex();
  let match: RegExpExecArray | null;
  while ((match = execVerseMarker(re, text)) !== null) {
    if (parseMarkerToken(match[0]).number !== verseNumber) continue;
    const lineStart = text.lastIndexOf("\n", match.index - 1) + 1;
    const prefix = /^(\s*(?:>\s?)+)/.exec(text.slice(lineStart, match.index));
    return prefix ? prefix[1] : "";
  }
  return "";
}

/**
 * Returns the raw markdown source covering a verse-number range, as the
 * *literal document span* from the first marker whose number falls in
 * [start, end] to the end of the last such marker's content.
 *
 * Because the cited verses may be scattered and interleaved (e.g. document
 * order 6b, 5a, 6a, 7, 5b for a 5:6 reference), the span is bounded by the
 * earliest and latest in-range markers in *document* order — never stopping
 * early at a number it happens to meet first. Everything physically between
 * those bounds is preserved verbatim: headings, blockquotes, inline markers,
 * and even out-of-range verses (a stray [7] caught in the middle) — all of
 * which the MarkdownRenderer + our post-processor then style like the reading
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
    if (hits[i].number >= start && hits[i].number <= end) {
      if (firstIdx === -1) firstIdx = i;
      lastIdx = i;
    }
  }

  if (firstIdx === -1) return null;

  // Include the first marker's blockquote/whitespace lead-in so a `> ` (or
  // `>[N]`) prefix is preserved and the leading verse keeps its quote.
  const startPos = lineLeadStart(text, hits[firstIdx].index);
  // End at the marker immediately following the last in-range one, cut at its
  // line lead-in so a dangling `> ` prefix from a blockquoted next verse
  // isn't dragged in (it would otherwise block trailing-heading strip).
  const contentEnd =
    lastIdx + 1 < hits.length
      ? lineLeadStart(text, hits[lastIdx + 1].index)
      : text.length;

  const sliceEnd = contentEnd;
  let raw = text.slice(startPos, sliceEnd);
  const trimmedLen = raw.trimEnd().length;
  raw = raw.slice(0, trimmedLen);
  raw = balanceHighlights(raw, text, startPos, startPos + trimmedLen);
  raw = stripEditorialBreaks(raw);
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
 * Footnote reference syntax: `[^id]` not followed by `:` (which would
 * make it a definition). The id can contain any non-bracket, non-space
 * characters — covers numeric, alphabetic, and Obsidian's
 * dash/underscore-separated identifiers.
 */
const FOOTNOTE_REF_REGEX = /\[\^([^\]\s]+)\](?!:)/g;

/**
 * Footnote definition syntax: `[^id]:` at the start of a line. The
 * definition body may continue onto subsequent lines as long as those
 * lines are blank or indented (per CommonMark/Obsidian footnote rules).
 */
const FOOTNOTE_DEF_HEAD_REGEX = /^\[\^([^\]\s]+)\]:/;

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
  const re = getVerseRegex();
  let match: RegExpExecArray | null;
  while ((match = execVerseMarker(re, text)) !== null) {
    const num = parseMarkerToken(match[0]).number;
    if (num === verseNumber) {
      let line = 0;
      for (let i = 0; i < match.index; i++) {
        if (text.charCodeAt(i) === 10) line++;
      }
      return line;
    }
  }
  return null;
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
  let verseNumber: number | null = null;
  for (let i = blockStartLine - 1; i >= 0; i--) {
    const stripped = stripBlockquoteMarker(lines[i]);
    if (findVerseBreakIndex(lines[i]) !== -1) return null;
    if (HEADING_LINE_REGEX.test(stripped)) {
      headingCount++;
      continue;
    }
    const marker = execVerseMarker(getVerseRegex(), lines[i]);
    if (marker) {
      verseNumber = parseMarkerToken(marker[0]).number;
      break;
    }
  }
  if (verseNumber === null || headingCount === 0) return null;

  // Shift the letter past any interior-footnote parts that live in the
  // segments preceding this block (segments 0..headingCount-1).
  let index = headingCount;
  const span = findVerseSpan(text, verseNumber);
  if (span) {
    const segments = versePartSegments(text.slice(span.start, span.end));
    for (let s = 0; s < headingCount && s < segments.length; s++) {
      index += segments[s].length - 1;
    }
  }
  return `verse-${verseNumber}${String.fromCharCode(97 + index)}`;
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
  if (part === null) return true;

  // An authored marker like [5a] is itself an anchor (the post-processor
  // gives its span id="verse-5a"), so explicit parts are always anchored.
  if (scanMarkers(text).some((h) => h.number === verseNumber && h.part === part)) {
    return true;
  }

  const span = findVerseSpan(text, verseNumber);
  if (!span) return false;
  const segments = versePartSegments(text.slice(span.start, span.end));
  const target = partToIndex(part);
  let segmentStart = 0;
  for (const segment of segments) {
    if (segmentStart === target) return true;
    segmentStart += segment.length;
  }
  return false;
}

/**
 * Returns the authored part of the FIRST marker carrying `verseNumber`
 * (e.g. "a" when the verse is written as scattered [5a]…[5b]…), or null when
 * the first occurrence is a plain `[N]` marker or the verse is absent.
 *
 * Navigation uses this to find a real scroll anchor: a whole-verse reference
 * (verse-5) to a verse with no plain `[5]` marker must fall back to the first
 * fragment's id (verse-5a) since `verse-5` itself never appears in the DOM.
 */
export function firstFragmentPart(
  text: string,
  verseNumber: number
): string | null {
  const first = scanMarkers(text).find((h) => h.number === verseNumber);
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
 * verse is represented as a degenerate range where start === end and the
 * endpoint parts are equal.
 */
export interface VerseSegment {
  start: number;
  startPart: string | null;
  end: number;
  endPart: string | null;
}

/** A single segment's grammar: "N", "Na", "N:M", "Na:Mb", etc. */
const SEGMENT_SOURCE = String.raw`\d+[a-z]*(?::\d+[a-z]*)?`;

/**
 * Parses a verse reference into one or more ordered segments. Handles every
 * supported form uniformly:
 *   verse-3        → [{3,null,3,null}]
 *   verse-3a       → [{3,"a",3,"a"}]
 *   verse-3:7      → [{3,null,7,null}]
 *   verse-4:6/8:10 → [{4,null,6,null}, {8,null,10,null}]
 *   verse-3/5/7    → [{3,null,3,null}, {5,null,5,null}, {7,null,7,null}]
 *
 * Segments are separated by "/". The "verse-" prefix (required unless
 * `allowShorthand`) applies to the whole reference, not each segment. Returns
 * null if the fragment is not a valid verse reference.
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

  const segRe = new RegExp(`^(\\d+)([a-z]*)(?::(\\d+)([a-z]*))?$`);
  const segments: VerseSegment[] = [];
  for (const piece of core.split("/")) {
    const m = segRe.exec(piece);
    if (!m) return null;
    const start = parseInt(m[1], 10);
    const startPart = m[2] === "" ? null : m[2];
    if (m[3] !== undefined) {
      segments.push({
        start,
        startPart,
        end: parseInt(m[3], 10),
        endPart: m[4] === "" ? null : m[4],
      });
    } else {
      segments.push({ start, startPart, end: start, endPart: startPart });
    }
  }
  return segments;
}

/**
 * Strict: explicit "verse-N", "verse-Na", "verse-N:M", any range variant with
 * part suffixes, and disjoint multi-segment forms joined by "/"
 * ("verse-4:6/8:10").
 */
export const VERSE_FRAGMENT_TEST_STRICT = new RegExp(
  `^verse-${SEGMENT_SOURCE}(?:/${SEGMENT_SOURCE})*$`
);

/** Loose: explicit OR shorthand (opt-in). */
export const VERSE_FRAGMENT_TEST_LOOSE = new RegExp(
  `^(?:verse-)?${SEGMENT_SOURCE}(?:/${SEGMENT_SOURCE})*$`
);

/** Strict range test: explicit forms only, with optional part suffixes. */
export const VERSE_RANGE_FRAGMENT_TEST_STRICT = /^verse-\d+[a-z]*:\d+[a-z]*$/;

/** Loose range test: explicit OR shorthand range. */
export const VERSE_RANGE_FRAGMENT_TEST_LOOSE = /^(?:verse-)?\d+[a-z]*:\d+[a-z]*$/;
