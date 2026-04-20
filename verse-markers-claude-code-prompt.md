# Claude Code Task: Build Obsidian Plugin — Verse Marker System

## Context

You are building a complete Obsidian plugin from scratch. The working directory is the plugin folder. Generate all required files: manifest.json, package.json, tsconfig.json, esbuild.config.mjs, styles.css, and all TypeScript source files under src/. The compiled entry point must be main.js at the root. Use the official Obsidian sample plugin build setup as the baseline.

---

## Plugin Identity

- Plugin ID: verse-markers
- Name: Verse Markers
- Description: Inline verse numbering and referencing system for Obsidian notes.
- Min Obsidian version: 1.4.0
- Author: (leave placeholder)

---

## Feature 1: Verse Marker Detection

### Syntax

A verse marker is a token of the form [N] where N is one or more digit characters only (0–9). No spaces inside the brackets. No letters. No symbols.

### Valid placement rule

A verse marker is only recognized when:
- It is immediately preceded (on the raw text level) only by: > (blockquote character), or any whitespace characters (space, tab, \n, \r), or it is at the start of the string.
- It is immediately followed only by: whitespace characters (space, tab, \n, \r), or it is at the end of the string.

In regex terms, the boundary condition is:

    (?:^|(?<=[>\s]))\[\d+\](?=[\s]|$)

Any [N] that does not meet both boundary conditions is NOT a verse marker and must be left completely untouched.

---

## Feature 2: Live Preview (Editor) Rendering

In the CodeMirror 6 editor (Obsidian's live preview mode), Obsidian currently renders [x] as an unresolved wiki-link (brackets in muted gray, inner text in accent/blue color).

The plugin must apply a ViewPlugin with a DecorationSet that:
- Detects valid verse markers in the document text using the boundary rule above.
- Wraps each match with mark decorations that apply a CSS class: cm-verse-marker to the whole token, cm-verse-bracket to each [ and ], and cm-verse-number to the digit sequence.
- Suppresses Obsidian's default unresolved-link decoration on those tokens so they do not render with the default gray/blue unresolved-link style.
- Updates incrementally using update.changes and update.visibleRanges — do not rescan the full document on every keystroke.

---

## Feature 3: Reading View Rendering

The plugin must register a Markdown post-processor via this.registerMarkdownPostProcessor. This post-processor must:

1. Receive the rendered HTML fragment (el).
2. Walk only Text nodes (nodeType === 3) within the fragment.
3. For each text node, apply the boundary-aware regex to find valid verse markers.
4. Skip entirely any text node that is a descendant of: a, code, pre, math, mjx-container, .math, table, img, .internal-embed, .external-embed. Check ancestors before processing.
5. For each valid match found in a qualifying text node, split the text node and replace the match with a span.verse-marker-wrap containing:
   - span.verse-bracket with text [
   - span.verse-number with the digit string
   - span.verse-bracket with text ]
6. Do not alter any text outside matched tokens.
7. Do not trigger re-renders or query the full document. Operate only on the fragment passed in.
8. This must be idempotent: running it twice on the same fragment must produce no changes on the second run.

---

## Feature 4: Verse Content Definition

A verse's content is defined as:
- All text starting immediately after the single space that follows the closing ] of the verse marker.
- Ending immediately before the first occurrence of either:
  - Whitespace-or->-prefixed [N] (the next verse marker), or
  - End of the block/line.

This definition is used for hover previews and copy/link targets. Implement a utility function getVerseContent(text: string, verseNumber: number): string | null that parses a raw markdown string and returns the content of the specified verse.

---

## Feature 5: Verse References and Backlinking

### URI scheme

Verse markers must be addressable like headings. Implement a system where each verse marker [N] in a file is reachable via a URI fragment:

    obsidian://open?vault=VAULT&file=FILE&verse=N

Also support Obsidian internal link format: [[FILE#verse-N]] — register a custom heading-equivalent so that #verse-N resolves to the position of [N] in the note.

### In-note anchor

In reading view, each rendered verse marker span must also have an id attribute: verse-N (e.g. id="verse-42"), so browser fragment navigation works.

### Copy reference command

Register a command: "Copy verse reference" that:
- Detects the verse marker nearest to the cursor (in editor mode) or nearest to the selected position.
- Copies to clipboard: [[CURRENT_FILE#verse-N]]

### Backlinks

When another note contains [[FILE#verse-N]], Obsidian's backlink panel must surface it. Achieve this by ensuring the anchor registration follows the same pattern Obsidian uses for heading anchors so the backlink indexer picks it up.

---

## Feature 6: Verse Range References

A verse range is expressed as [[FILE#verse-N:M]] meaning verses N through M inclusive.

### Range hover preview

Register a hover link source (registerHoverLinkSource) and an obsidian:// protocol handler so that when a user hovers over a [[FILE#verse-N:M]] link:
- A popover appears showing the raw text content of all verses from N to M.
- The popover is styled using .verse-hover-preview CSS class.
- The content is extracted using the getVerseContent utility for each verse in the range and joined with newlines.

### Range link resolution

When a user clicks [[FILE#verse-N:M]]:
- Navigate to the file and scroll to verse N.

### Copy range reference command

Register a command: "Copy verse range reference" that:
- Requires a selection spanning at least two verse markers.
- Detects the first and last verse markers within the selection.
- Copies: [[CURRENT_FILE#verse-N:M]]

---

## Feature 7: CSS Styling

In styles.css, define styles using Obsidian CSS variables so they adapt to any theme:

    /* Reading view */
    .verse-marker-wrap { display: inline; }
    .verse-bracket {
      color: var(--text-muted);
      font-weight: normal;
    }
    .verse-number {
      color: var(--text-normal);
      font-weight: 600;
    }

    /* Editor (live preview) */
    .cm-verse-bracket { color: var(--text-muted) !important; }
    .cm-verse-number  { color: var(--text-normal); font-weight: 600; }

    /* Hover preview */
    .verse-hover-preview {
      padding: var(--size-4-2) var(--size-4-3);
      font-size: var(--font-text-size);
      color: var(--text-normal);
      max-width: 480px;
      white-space: pre-wrap;
    }

---

## Feature 8: Settings

Implement a settings tab (PluginSettingTab) with the following options:

- numberColor: text input, default "var(--text-normal)", label "Verse number color"
- bracketColor: text input, default "var(--text-muted)", label "Bracket color"
- enableHoverPreviews: toggle, default true, label "Enable range hover previews"
- hoverPreviewMaxVerses: number input, default 20, label "Max verses in hover preview"

Apply color settings as inline CSS custom properties on document.body so they override the default CSS classes dynamically.

---

## File Structure to Generate

    /
    ├── manifest.json
    ├── package.json
    ├── tsconfig.json
    ├── esbuild.config.mjs
    ├── styles.css
    └── src/
        ├── main.ts           (Plugin class, registers everything)
        ├── detection.ts      (Verse marker regex, getVerseContent, range parser)
        ├── editor.ts         (CM6 ViewPlugin for live preview decorations)
        ├── postprocessor.ts  (Reading view MarkdownPostProcessor)
        ├── references.ts     (Anchor injection, hover source, link resolver)
        ├── commands.ts       (Copy verse reference and Copy range reference)
        └── settings.ts       (Settings interface, defaults, SettingTab class)

---

## Constraints

- TypeScript strict mode. No use of "any" unless absolutely unavoidable.
- No runtime dependencies beyond "obsidian" and @codemirror/* packages already bundled by Obsidian.
- All event listeners and CM6 extensions must be registered through this.registerEvent, this.registerEditorExtension, or this.registerMarkdownPostProcessor so they are cleaned up automatically on plugin unload.
- No document.querySelectorAll or full-document scans at any point in the codebase.
- The regex used across all three contexts (detection utility, CM6 ViewPlugin, and post-processor) must be the single canonical regex defined once in detection.ts and imported everywhere else. It must never be redefined or duplicated in another file.
