# Verse Markers

An Obsidian plugin for inline verse numbering and cross-referencing. Write `[1]`, `[2]`, `[3]` in your notes and the plugin turns them into anchorable verse targets that you can link to from anywhere in your vault — single verses, ranges, or heading-split parts.

Originally built for study notes over scripture, but it works for any document where you want stable, per-paragraph anchors that survive edits: legal texts, play scripts, technical specs, etc.

## Features

- **Inline verse markers** — Any token like `[3]` at the start of a line, after a blockquote `>`, or after whitespace is treated as verse 3. Reading view renders it as just the number, colored with the theme's link accent. Live preview is left untouched so it keeps Obsidian's native look.
- **Wiki-link references** — `[[Gospel of John#verse-3]]` jumps to verse 3 in the target file. Ranges (`verse-3:7`) and heading-split parts (`verse-3a`, `verse-3b`, …) are supported.
- **Hover previews for ranges** — hover a `verse-N:M` link to see the quoted verse text inline without opening the file.
- **Two "Copy reference" commands** — grab a wiki-link for the verse near your cursor, or for a selection spanning multiple verses.
- **URI protocol handler** — `obsidian://verse-markers?file=<path>&verse=<N>&part=<a>` deep-links into a verse from outside Obsidian.
- **Multi-line and heading-split verses** — a verse can span multiple lines, include blockquotes, and be broken up by headings without losing its identity.
- **Opt-in shorthand syntax** — `[[File#3]]` / `[[File#3:7]]` if you enable it. Off by default because it can hijack links to headings literally named `"3"`.

## Installation

No community-store listing yet. Install manually:

1. Download or build `main.js`, `manifest.json`, and `styles.css` (see *Building from source* below).
2. Copy those three files into your vault at:
   ```
   <vault>/.obsidian/plugins/verse-markers/
   ```
   Create the folder if it doesn't exist.
3. In Obsidian: **Settings → Community plugins**, turn on **Verse Markers**.

## Authoring verses

Write verse markers as bare `[N]` tokens in Markdown. The parser accepts a marker when:

- it is at the start of a line, OR
- it follows whitespace, OR
- it follows a blockquote `>`

...and is followed by whitespace or end-of-line. There must be a single space between `]` and the verse content.

```markdown
[1] In the beginning was the Word, and the Word was with God, and the Word was God.
[2] He was in the beginning with God.
[3] All things were made through him, and without him was not any thing made
that was made.

> [4] In him was life, and the life was the light of men.
```

Reading view renders each marker as the number only (brackets dropped), colored with the link accent so it visually matches the references that point to it.

### Multi-line verses

A verse's content runs from the space after `]` to the next verse marker (or end of file). It can cross any number of lines and blockquotes:

```markdown
[5] The light shines in the darkness,
and the darkness has not overcome it.

[6] There was a man sent from God, whose name was John.
```

`[[File#verse-5]]` resolves to both lines of verse 5.

### Heading-split verses

If an ATX heading (`#`..`######`) appears inside a verse's span, the verse is split into lettered parts. Part "a" is the text before the first heading, "b" is between the first and second, and so on:

```markdown
[4] Before the split.

## A heading lands in the middle of verse 4

Still verse 4, continuation.

## Another heading

Final chunk of verse 4.

[5] Next verse.
```

You can link to the whole verse or a specific part:

- `[[File#verse-4]]`  → all three chunks joined
- `[[File#verse-4a]]` → "Before the split."
- `[[File#verse-4b]]` → "Still verse 4, continuation."
- `[[File#verse-4c]]` → "Final chunk of verse 4."

## Referencing verses

### Default (always on)

| Syntax                     | Meaning                                   |
|----------------------------|-------------------------------------------|
| `[[File#verse-3]]`         | Whole verse 3                             |
| `[[File#verse-3a]]`        | First heading-split part of verse 3       |
| `[[File#verse-3b]]`        | Second part (c, d, … for further splits)  |
| `[[File#verse-3:7]]`       | Range: verses 3 through 7 inclusive       |
| `[[File#verse-3b:7]]`      | Range starting at part b of verse 3       |
| `[[File#verse-3:7c]]`      | Range ending after part c of verse 7      |
| `[[File#verse-3b:7c]]`     | Both endpoints trimmed to parts           |

Range part semantics:
- If the **start** has a part suffix (`3b:7`), the first verse shown begins at that part (earlier parts of that verse are hidden).
- If the **end** has a part suffix (`3:7c`), the last verse shown ends at that part (later parts of that verse are hidden).
- Clicking a range link scrolls to the start endpoint's part anchor, falling back to the verse anchor if the part anchor isn't present.

### Shorthand (opt-in)

Enable **"Enable shorthand reference syntax"** in settings to also accept:

| Syntax                     | Equivalent to                             |
|----------------------------|-------------------------------------------|
| `[[File#3]]`               | `[[File#verse-3]]`                        |
| `[[File#3a]]`              | `[[File#verse-3a]]`                       |
| `[[File#3:7]]`             | `[[File#verse-3:7]]`                      |
| `[[File#3b:7]]`            | `[[File#verse-3b:7]]`                     |
| `[[File#3:7c]]`            | `[[File#verse-3:7c]]`                     |

> ⚠️ **Collision warning.** If the target note has a heading literally named `"3"`, `"3a"`, or `"3:7"`, the plugin will intercept the link instead of letting Obsidian navigate to that heading. That is why shorthand is off by default. The "Copy verse reference" commands always emit the explicit `verse-N` form regardless of this setting, so generated links stay collision-safe.

## Commands

Available from the command palette (⌘/Ctrl + P):

- **Copy verse reference** — finds the verse marker nearest your cursor and copies `[[CurrentFile#verse-N]]` to the clipboard.
- **Copy verse range reference** — with a selection that spans two or more verse markers, copies `[[CurrentFile#verse-N:M]]`.

Both commands always emit the explicit `verse-N` form.

## URI protocol handler

External tools can deep-link into a verse with:

```
obsidian://verse-markers?file=<vault-relative-path>&verse=<N>
obsidian://verse-markers?file=<vault-relative-path>&verse=<N>&part=<letter>
```

Example:

```
obsidian://verse-markers?file=Notes/Gospel%20of%20John.md&verse=3&part=a
```

(We use the custom action name `verse-markers` rather than `open` because Obsidian reserves `open`.)

## Settings

| Setting                                   | Default | What it does                                                        |
|-------------------------------------------|---------|---------------------------------------------------------------------|
| Enable range hover previews               | On      | Show verse text in a popover when hovering `verse-N:M` links.       |
| Max verses in hover preview               | 20      | Cap on how many verses the popover will quote.                      |
| Enable shorthand reference syntax         | Off     | Also accept `[[File#3]]` / `[[File#3:7]]`. See collision warning.   |

## Styling

The plugin intentionally does **not** ship custom colors, weights, or sizes. It uses exactly two style hooks, both driven by your theme's existing variables:

```css
.verse-marker { color: var(--link-color); }           /* reading view: the number */
.verse-hover-preview { ... var(--text-normal) ... }   /* range hover popover */
```

Live preview is entirely untouched — Obsidian's native handling of `[N]` (light-gray brackets, accent-colored digits, because it looks like a partial Markdown link) is already what we want, and adding a decoration layer would only risk drifting from your theme.

If you want to restyle, drop overrides into a CSS snippet:

```css
.verse-marker {
  color: var(--text-accent);
  font-weight: 600;
}
```

## Behavior notes & edge cases

- **Marker recognition is boundary-aware.** `[3]` works; `text[3]text` (no whitespace) does not. A marker inside a code block, inline code, or math is skipped entirely.
- **Skipped containers in reading view:** `<a>`, `<code>`, `<pre>`, `<math>`, `<mjx-container>`, `<table>`, `<img>`, and anything with `.math`, `.internal-embed`, or `.external-embed`.
- **Verse uniqueness.** The plugin does not enforce unique verse numbers within a file. If you write `[3]` twice, the first one wins for navigation.
- **Post-processor is idempotent.** Running it twice on the same DOM is a no-op (the rewritten spans contain no raw `[N]` tokens to match).
- **Part "a" vs. heading-split continuation.** When a block already contains a verse marker, that marker's span carries the `verse-N` id. Continuation blocks (part b, c, …) get an injected invisible anchor span at their start.

## Building from source

Requires Node 16+ and npm.

```bash
git clone <this-repo>
cd verse-refference-plugin
npm install --legacy-peer-deps
npm run build
```

`npm run build` runs `tsc --noEmit` for type-checking then bundles with esbuild. Output files: `main.js`, `manifest.json`, `styles.css` — copy those three into your vault's plugins folder as described in *Installation*.

For active development:

```bash
npm run dev
```

…and symlink the project directory into your vault's plugins folder so rebuilds land in place.

## Project layout

```
src/
  detection.ts      Canonical verse regex, content extraction, fragment parsers.
  postprocessor.ts  Reading-view DOM rewrite + heading-split part anchor injection.
  references.ts     Link resolution, scroll-to-verse, range hover preview.
  commands.ts       "Copy verse reference" command registrations.
  settings.ts       Settings interface, defaults, settings tab UI.
  main.ts           Plugin entry point (wires everything together).
styles.css          Minimal theme-variable-driven styles.
manifest.json       Obsidian plugin manifest.
```

`detection.ts` is the single source of truth for the verse marker regex and fragment parsers — nothing else should define those patterns.

## License

MIT
