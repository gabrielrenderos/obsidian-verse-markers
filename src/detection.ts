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
 * If an ATX heading (#..######) appears inside that span, the content is
 * considered split into sub-parts:
 *   part "a" → text before the first heading
 *   part "b" → text between the first and second heading
 *   ...
 * The heading lines themselves are never included in any part.
 * A reference without a part (verse-N) returns the parts joined by a single
 * space so the heading-adjacent newlines don't leak through.
 * ------------------------------------------------------------------------- */

/** ATX-style heading line: optional indent, 1–6 `#`, at least one non-space char after. */
const HEADING_LINE_REGEX = /^\s*#{1,6}\s+\S.*$/;

/** Strips one level of leading "> " blockquote marker from a line. */
function stripBlockquoteMarker(line: string): string {
  return line.replace(/^\s*>\s?/, "");
}

/**
 * Splits a verse's raw content span into heading-delimited parts.
 * Returns a trimmed string per part (index 0 = "a", 1 = "b", …).
 * Blockquote markers are stripped so verses inside `>` blocks render cleanly.
 */
function splitVersePartsByHeadings(rawContent: string): string[] {
  const lines = rawContent.split("\n").map(stripBlockquoteMarker);
  const parts: string[][] = [[]];
  for (const line of lines) {
    if (HEADING_LINE_REGEX.test(line)) {
      parts.push([]);
    } else {
      parts[parts.length - 1].push(line);
    }
  }
  return parts.map((group) => group.join("\n").trim());
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
  return splitVersePartsByHeadings(text.slice(span.start, span.end));
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
 * Returns the number of heading-delimited parts for a given verse.
 * Returns 0 if the verse is not found.
 */
export function countVerseParts(text: string, verseNumber: number): number {
  const span = findVerseSpan(text, verseNumber);
  if (!span) return 0;
  return splitVersePartsByHeadings(text.slice(span.start, span.end)).length;
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
