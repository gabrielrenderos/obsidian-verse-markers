/**
 * detection.ts
 * Single source of truth for the verse marker regex and content utilities.
 */

/**
 * Canonical verse marker regex.
 * Matches [N] where N is one or more digits, with boundary conditions:
 * - preceded by start-of-string, >, or whitespace
 * - followed by whitespace or end-of-string
 *
 * Uses a lookbehind so captures only [N] itself (not the preceding char).
 */
export const VERSE_MARKER_REGEX = /(?:^|(?<=[>\s]))\[\d+\](?=\s|$)/gm;

/**
 * Returns a fresh (lastIndex-reset) copy of the canonical regex.
 * Always use this instead of VERSE_MARKER_REGEX directly when iterating,
 * to avoid shared lastIndex state between callers.
 */
export function getVerseRegex(): RegExp {
  return new RegExp(VERSE_MARKER_REGEX.source, VERSE_MARKER_REGEX.flags);
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
 * ------------------------------------------------------------------------- */

/** ATX-style heading line: optional indent, 1–6 `#`, at least one non-space char after. */
const HEADING_LINE_REGEX = /^\s*#{1,6}\s+\S.*$/;

/** Strips one level of leading "> " blockquote marker from a line. */
function stripBlockquoteMarker(line: string): string {
  return line.replace(/^\s*>\s?/, "");
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

  while ((match = re.exec(text)) !== null) {
    const num = parseInt(match[0].slice(1, -1), 10);
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
  return splitVerseParts(text.slice(span.start, span.end));
}

/**
 * Returns the text content of a verse (or a specific part of it).
 * - `part` null/undefined → full content, heading lines excluded, parts joined.
 * - `part` "a"/"b"/"c"/…  → that 0-indexed segment between headings.
 * Returns null if the verse or requested part does not exist.
 */
export function getVerseContent(
  text: string,
  verseNumber: number,
  part: string | null = null
): string | null {
  const parts = getVerseParts(text, verseNumber);
  if (!parts) return null;

  if (part) {
    const idx = part.charCodeAt(0) - "a".charCodeAt(0);
    if (idx < 0 || idx >= parts.length) return null;
    return parts[idx];
  }

  return parts.filter((p) => p.length > 0).join(" ");
}

/**
 * Returns the raw markdown source spanning from verse `start`'s marker
 * through the end of verse `end`'s content (exclusive of the next marker).
 *
 * Used by the hover preview when no part trimming is needed: rendering this
 * span through Obsidian's MarkdownRenderer reproduces the source layout
 * exactly — paragraphs, headings, blockquotes, and inline `[N]` markers
 * (which our own post-processor will then style).
 *
 * Returns null if `start` is not found in the text.
 */
export function getVerseRangeRawText(
  text: string,
  start: number,
  end: number
): string | null {
  const re = getVerseRegex();
  let startPos = -1;
  let contentEnd = text.length;
  let endSeen = false;
  let match: RegExpExecArray | null;

  while ((match = re.exec(text)) !== null) {
    const num = parseInt(match[0].slice(1, -1), 10);

    if (startPos === -1) {
      if (num === start) {
        // If this verse marker is inside a blockquote written as `>[N] ...`,
        // include the leading `>` so the popover preserves the quote marker.
        startPos =
          match.index > 0 && text[match.index - 1] === ">"
            ? match.index - 1
            : match.index;
        if (start === end) endSeen = true;
      }
    } else {
      if (endSeen) {
        // This is the marker immediately after verse `end` — cut here.
        contentEnd = match.index;
        break;
      }
      if (num === end) endSeen = true;
    }
  }

  if (startPos === -1) return null;
  const raw = text.slice(startPos, contentEnd).trimEnd();
  return stripTrailingHeadingsBeforeNextVerse(raw);
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
    while (i >= 0 && /^\s*$/.test(lines[i])) i--;
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
  while ((match = re.exec(text)) !== null) {
    const num = parseInt(match[0].slice(1, -1), 10);
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
    if (HEADING_LINE_REGEX.test(stripBlockquoteMarker(lines[i]))) {
      headingCount++;
      continue;
    }
    const marker = getVerseRegex().exec(lines[i]);
    if (marker) {
      verseNumber = parseInt(marker[0].slice(1, -1), 10);
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
  const span = findVerseSpan(text, verseNumber);
  if (!span) return false;
  const segments = versePartSegments(text.slice(span.start, span.end));
  const target = part.charCodeAt(0) - "a".charCodeAt(0);
  let segmentStart = 0;
  for (const segment of segments) {
    if (segmentStart === target) return true;
    segmentStart += segment.length;
  }
  return false;
}

/**
 * Returns all verse numbers found in the given text, in order.
 */
export function getAllVerseNumbers(text: string): number[] {
  const re = getVerseRegex();
  const numbers: number[] = [];
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    const num = parseInt(match[0].replace(/\[|\]/g, ""), 10);
    numbers.push(num);
  }
  return numbers;
}

/* ---------------------------------------------------------------------------
 * Supported verse-reference fragment syntaxes
 * ---------------------------------------------------------------------------
 * Single verse (always recognized):
 *     [[File#verse-3]]          full verse
 *     [[File#verse-3a]]         heading-split part "a" (first segment)
 *     [[File#verse-3b]]         heading-split part "b" (second segment), etc.
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
    ? /^(?:verse-)?(\d+)([a-z])?:(\d+)([a-z])?$/
    : /^verse-(\d+)([a-z])?:(\d+)([a-z])?$/;
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
 * `part` is a single lowercase letter (a/b/c/…) or null for the full verse.
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
    ? /^(?:verse-)?(\d+)([a-z])?$/
    : /^verse-(\d+)([a-z])?$/;
  const m = pattern.exec(fragment);
  if (!m) return null;
  return {
    verse: parseInt(m[1], 10),
    part: m[2] ?? null,
  };
}

/**
 * Strict: explicit "verse-N", "verse-Na", "verse-N:M", and any range variant
 * with part suffixes on either endpoint ("verse-Na:M", "verse-N:Mb",
 * "verse-Na:Mb").
 */
export const VERSE_FRAGMENT_TEST_STRICT = /^verse-\d+[a-z]?(?::\d+[a-z]?)?$/;

/** Loose: explicit OR shorthand (opt-in). */
export const VERSE_FRAGMENT_TEST_LOOSE = /^(?:verse-)?\d+[a-z]?(?::\d+[a-z]?)?$/;

/** Strict range test: explicit forms only, with optional part suffixes. */
export const VERSE_RANGE_FRAGMENT_TEST_STRICT = /^verse-\d+[a-z]?:\d+[a-z]?$/;

/** Loose range test: explicit OR shorthand range. */
export const VERSE_RANGE_FRAGMENT_TEST_LOOSE = /^(?:verse-)?\d+[a-z]?:\d+[a-z]?$/;
