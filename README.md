# Verse Markers

An Obsidian plugin for inline verse numbering and cross-referencing. Write `[1]`, `[2]`, `[3]` in your notes and the plugin turns them into anchorable verse targets that you can link to from anywhere in your vault — single verses, ranges, or heading-split parts.

Originally built for study notes over scripture, but it works for any document where you want stable, per-paragraph anchors that survive edits: legal texts, play scripts, technical specs, etc.

## Features

- **Inline verse markers** — Any token like `[3]` (or an authored part like `[3a]`) at the start of a line, after a blockquote `>`, after whitespace, or inside inline formatting (`==highlight==`, `**bold**`, etc.) is treated as a verse. Reading view renders it as just the label, colored with the theme's link accent. Live Preview keeps Obsidian's native `[N]` look and adds a light accent on verse digits inside `==highlight==`.
- **Verse breaks (`[//]`)** — Inline or on its own line, `[//]` toggles between verse text and editorial asides. Odd gaps (after the 1st, 3rd, … break) are excluded from popovers, embeds, flash, and whole-verse extraction; even gaps (after the 2nd, 4th, …) are verse again. The token is hidden in reading view; Live Preview shows it styled like another verse marker.
- **Highlight-aware extraction** — `==highlight==` syntax is preserved in popovers and embeds, and verse markers inside highlights are recognized for linking and extraction.
- **Wiki-link references** — `[[Gospel of John#verse-3]]` jumps to verse 3 in the target file. Ranges (`verse-3:7`) and parts (`verse-3a`, `verse-3b`, …) are supported, whether a part comes from a heading/footnote split or is written into the marker itself.
- **Disjoint (skip-verse) references** — `[[File#verse-4:6/8:10]]` cites verses 4–6 **and** 8–10 while excluding 7, for lectionary-style passages that skip verses. The popover shows only the cited verses and the temporary highlight covers each piece, leaving the gaps untouched.
- **Authored verse parts** — markers may carry a part suffix, e.g. `[5a]`, `[5b]`, `[12bc]`. A single canonical verse can be split into scattered, separately-marked pieces (even interleaved with other verses) and still be referenced as a whole or by individual part.
- **Hover previews for ranges** — hover a `verse-N:M` link to see the quoted verse text inline without opening the file.
- **Verse embeds** — prefix any reference with `!` (`![[File#verse-3:7]]`) to transclude the cited verse(s) inline as a native-looking embed card, in **both reading view and Live Preview**. Single verses, ranges, authored/derived parts, and disjoint refs all work.
- **Two "Copy reference" commands** — grab a wiki-link for the verse near your cursor, or for a selection spanning multiple verses.
- **URI protocol handler** — `obsidian://verse-markers?file=<path>&verse=<N>&part=<a>` deep-links into a verse from outside Obsidian.
- **Multi-line and heading-split verses** — a verse can span multiple lines, include blockquotes, and be broken up by headings without losing its identity.
- **Opt-in shorthand syntax** — `[[File#3]]` / `[[File#3:7]]` if you enable it. Off by default because it can hijack links to headings literally named `"3"`.

## Installation

### From Obsidian (recommended)

1. Open **Settings → Community plugins** and make sure restricted mode is off.
2. Select **Browse**, search for **Verse Markers**, and select **Install**.
3. Select **Enable**.

### Manual

1. Download `main.js`, `manifest.json`, and `styles.css` from the latest [GitHub release](https://github.com/gabrielrenderos/obsidian-verse-markers/releases) (or build them — see *Building from source* below).
2. Copy those three files into your vault at:
   ```
   <vault>/.obsidian/plugins/verse-markers/
   ```
   Create the folder if it doesn't exist.
3. In Obsidian: **Settings → Community plugins**, turn on **Verse Markers**.

## Authoring verses

Write verse markers as bare `[N]` tokens in Markdown — or `[Na]` to carry an authored part letter (see [Authored verse parts](#authored-verse-parts)). The parser accepts a marker when:

- it is at the start of a line, OR
- it follows whitespace, OR
- it follows a blockquote `>`

...and is followed by whitespace or end-of-line. There must be a single space between `]` and the verse content. The token is one or more digits, optionally followed by lowercase letters; the required leading digit keeps ordinary brackets such as `[note]` or footnotes `[^1]` from ever being mistaken for a marker.

```markdown
[1] In the beginning was the Word, and the Word was with God, and the Word was God. [2] He was in the beginning with God. [3] All things were made through him, and without him was not any thing made that was made.

[4] In him was life, and the life was the light of men. [5] The light shines in the darkness, and the darkness has not overcome it.

> [6] There was a man sent from God, whose name was John. [7] He came as a witness, to bear witness about the light.
```

Several verses can share one line — each `[N]` still starts a new verse; content runs until the next marker (or a verse break). Reading view renders each marker as the number only (brackets dropped), colored with the link accent so it visually matches the references that point to it.

### Multi-line verses

A verse's content runs from the space after `]` to the next verse marker (or end of file). It can cross any number of lines and blockquotes:

```markdown
[5] The light shines in the darkness,
and the darkness has not overcome it.

[6] There was a man sent from God, whose name was John.
```

`[[File#verse-5]]` resolves to both lines of verse 5.

### Verse breaks (`[//]`)

Use `[//]` when you need editorial text in the middle of a verse without folding it into the verse flow — notes, alternate readings, or commentary between chunks of the same verse. Each `[//]` **toggles** between verse mode and editorial mode:

```markdown
[27] Because death is certain for the one born, and birth is certain for the dead; therefore you should not lament the inevitable. [//] this is a comment [//] this is the continuation of the verse, and here it ends [//]

==[28] The state of all beings before birth is unmanifest; their state between birth and death is manifest. [//] another break and here it continues [//] What reason is there then to lament? [29] Some consider this wonderful; others speak of it as such.==
```

- **1st gap** (after 1st `[//]`): editorial — excluded from `[[File#verse-27]]`, popovers, embeds, and flash.
- **2nd gap** (after 2nd `[//]`): verse again — included.
- **3rd gap** (after 3rd `[//]`): editorial again — excluded.

The token works **inline** (`…verse text[//] note`) or on its **own line** (no required blank lines or surrounding whitespace). In reading view the `[//]` token is removed entirely; editorial text stays visible. In Live Preview, `[//]` is shown with the same muted-bracket / accent-label styling as `[N]`.

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

### Footnote-split verses

An *interior* footnote reference also creates a part boundary — the cut falls right after the footnote token, so part `a` keeps the marker attached to the text it annotates:

```markdown
[2] Then a leper[^1] came and knelt before him.
```

- `[[File#verse-2a]]` → "Then a leper[^1]"
- `[[File#verse-2b]]` → "came and knelt before him."

A footnote only splits when there is verse text on **both** sides of it. Footnotes at the very start or end of a verse, or sitting on a heading line, are *not* boundaries — the verse stays whole through them. Heading and footnote boundaries are lettered together in document order (a, b, c, …), so a verse with one footnote then one heading yields parts a/b (around the footnote) and c (after the heading).

### Authored verse parts

Heading- and footnote-split parts are *derived* — they're a consequence of where headings and footnotes fall. Some texts instead write the part letter **into the marker itself**. This is common in Bibles whose versification differs from the source: a single canonical verse is printed as scattered pieces — `[5a]` here, `[5b]` somewhere else — possibly out of order and interleaved with another verse.

```markdown
[5a] The Pharaoh said to Joseph: [6b] "They may settle in the region of Goshen…"

### A different account

[5b] Jacob and his sons arrived in Egypt, where Joseph was. [6a] The land of Egypt is at your disposal.
```

A marker token is a number plus optional lowercase letters (`[5a]`, `[12bc]`). The letter shares the same `verse-Na` addressing as a derived part, so references look identical:

- `[[File#verse-5a]]` → "The Pharaoh said to Joseph:"
- `[[File#verse-6a]]` → "The land of Egypt is at your disposal."

Referencing behavior with scattered, interleaved fragments:

- **Whole verse** (`[[File#verse-5]]`) gathers every fragment of verse 5 (`5a`, `5b`) into one popover, **each on its own line with its own footnotes**. Headings and any other verses sitting physically between the fragments are left out.
- **Range** (`[[File#verse-5:6]]`) shows the *literal document span* from the first to the last marker whose number falls in the range — headings, blockquotes, and even an out-of-range verse caught in the middle are preserved verbatim. The span never stops early on a number it meets first, so all parts of the cited verses are included even when they appear out of order (e.g. `6b` before `6a`).
- **Navigation** to a whole verse with no plain `[5]` marker falls back to the first fragment's anchor (`verse-5a`).

When a verse uses authored part letters, those letters *are* its parts — the verse is not *also* split by any heading or footnote inside a fragment (authored markers win, so there's no double-lettering).

## Referencing verses

### Default (always on)

| Syntax                     | Meaning                                   |
|----------------------------|-------------------------------------------|
| `[[File#verse-3]]`         | Whole verse 3 (all fragments if scattered)|
| `[[File#verse-3a]]`        | Part "a" — an authored `[3a]` marker if present, else the first heading/footnote-split segment |
| `[[File#verse-3b]]`        | Part "b" (c, d, … for further parts; multi-letter like `bc` for authored markers) |
| `[[File#verse-3:7]]`       | Range: verses 3 through 7 inclusive       |
| `[[File#verse-3b:7]]`      | Range starting at part b of verse 3       |
| `[[File#verse-3:7c]]`      | Range ending after part c of verse 7      |
| `[[File#verse-3b:7c]]`     | Both endpoints trimmed to parts           |

Range part semantics:
- If the **start** has a part suffix (`3b:7`), the first verse shown begins at that part (earlier parts of that verse are hidden).
- If the **end** has a part suffix (`3:7c`), the last verse shown ends at that part (later parts of that verse are hidden).
- Clicking a range link scrolls to the start endpoint's part anchor, falling back to the verse anchor if the part anchor isn't present.

### Disjoint references (skip verses)

Lectionary readings often skip verses inside a passage — the Spanish notation `Juan 3,4-6.8-10` means "John chapter 3, verses 4–6 **and** 8–10", omitting verse 7. Join segments with `/` ("and also") to express this:

| Syntax                     | Meaning                                            |
|----------------------------|----------------------------------------------------|
| `[[File#verse-4:6/8:10]]`  | Verses 4–6 **and** 8–10 (7 excluded)               |
| `[[File#verse-3/5/7]]`     | Verses 3, 5, and 7 only                            |
| `[[File#verse-4:6/8/10:11]]`| Verses 4–6, then 8, then 10–11                    |

- Each segment is itself a single verse or a range (parts allowed), and the `verse-` prefix applies to the whole reference.
- The popover shows **only** the cited verses, in order, with the skipped verses omitted; footnotes for the shown verses are still included.
- The temporary highlight covers every cited verse and stops at each gap, so excluded verses are never highlighted. Each contiguous block gets its own rounded highlight.
- Clicking navigates to the first segment's start verse.

### Embedding verses

Prefix any reference with `!` to transclude it inline instead of linking to it:

| Syntax                      | Renders                                            |
|-----------------------------|----------------------------------------------------|
| `![[File#verse-3]]`         | Verse 3, inline                                    |
| `![[File#verse-3:7]]`       | Verses 3–7, inline                                 |
| `![[File#verse-4:6/8:10]]`  | Disjoint range, inline (7 excluded)                |
| `![[File#verse-3a]]`        | A single authored/derived part, inline             |

The embed renders as a native-style card — a file-name title (the same bold `embed-title` styling Obsidian uses for whole-file embeds) plus the verse content — and the corner icon opens the source note at the cited verse. It works in **both reading view and Live Preview**.

Obsidian's built-in transclusion can only resolve fragments that name a real heading or block, so it can't render `verse-` fragments on its own; the plugin hooks Obsidian's embed pipeline to fill these embeds itself. A `|display text` alias on an embed is ignored — the title is always the file name.

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

- **Copy verse reference** — finds the verse marker nearest your cursor and copies `[[CurrentFile#verse-N]]` to the clipboard (an authored part is preserved, e.g. `verse-5a`).
- **Copy verse range reference** — with a selection that spans two or more verse markers, copies `[[CurrentFile#verse-N:M]]`.

Both commands always emit the explicit `verse-N` form.

## URI protocol handler

External tools can deep-link into a verse with:

```
obsidian://verse-markers?file=<vault-relative-path>&verse=<N>
obsidian://verse-markers?file=<vault-relative-path>&verse=<N>&part=<letter>
```

`verse` may also include the part directly (`verse=5a`); the separate `part` is a convenience for the plain-number form.

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

The plugin intentionally does **not** ship custom colors, weights, or sizes beyond what your theme already provides. The main hooks:

```css
.verse-marker { color: var(--link-color); }              /* reading view + LP accents */
.verse-marker-bracket { color: var(--text-faint); }      /* Live Preview: [//] brackets */
.verse-hover-preview mark,
.verse-embed mark { background-color: var(--text-highlight-bg); }  /* == in popovers/embeds */
```

**Live Preview:** Obsidian's native handling of `[N]` (light-gray brackets, accent-colored digits) is left alone outside highlights. Inside `==highlight==`, verse digits get an accent-color decoration so they stay readable on the highlight background. `[//]` breaks are always decorated the same way (muted `[` `]`, accent `//`) because Obsidian does not style them natively.

**Reading view:** verse labels render as accent-colored numbers (brackets dropped). `[//]` tokens are removed; editorial text around them stays.

If you want to restyle, drop overrides into a CSS snippet:

```css
.verse-marker {
  color: var(--text-accent);
  font-weight: 600;
}
```

## Behavior notes & edge cases

- **Marker recognition is boundary-aware.** `[3]` works; `text[3]text` (no whitespace) does not. A marker inside a code block, inline code, or math is skipped entirely. Markers immediately after inline-format delimiters (`==[3]`, `**[3]**`, etc.) are recognized.
- **Verse breaks are toggle-based.** `[//]` alternates verse/editorial zones; only editorial gaps are stripped from extraction. The token itself never appears in reading view.
- **Highlights in excerpts.** Popovers and embeds convert `==text==` to `<mark>` so highlighted verse text matches reading view. Unbalanced `==` at slice boundaries are closed so excerpts don't leak formatting.
- **Skipped containers in reading view:** `<a>`, `<code>`, `<pre>`, `<math>`, `<mjx-container>`, `<table>`, `<img>`, and anything with `.math`, `.internal-embed`, or `.external-embed`.
- **Verse uniqueness.** The plugin does not enforce unique verse *numbers* within a file. Repeating the same number with distinct part letters (`[5a]`, `[5b]`) is the intended way to author a scattered verse. Repeating a plain `[3]` with no part is not — for navigation the first one wins, though a whole-verse reference still gathers them all.
- **Authored parts beat derived parts.** When a verse carries authored part letters, those are its parts; it is not *also* split by a heading or footnote inside a fragment.
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
  detection.ts      Canonical verse regex, content extraction, fragment parsers, [//] breaks.
  highlights.ts     ==highlight== range detection and HTML conversion for excerpts.
  livePreview.ts    CM6 decorations for [N] inside highlights and [//] break styling.
  postprocessor.ts  Reading-view DOM rewrite + heading-split part anchor injection.
  references.ts     Link resolution, scroll-to-verse, range hover preview.
  embeds.ts         Native ![[File#verse-…]] embed rendering (reading + Live Preview).
  commands.ts       "Copy verse reference" command registrations.
  settings.ts       Settings interface, defaults, settings tab UI.
  main.ts           Plugin entry point (wires everything together).
styles.css          Minimal theme-variable-driven styles.
manifest.json       Obsidian plugin manifest.
```

`detection.ts` is the single source of truth for the verse marker regex and fragment parsers — nothing else should define those patterns.

## License

Copyright (C) 2025 Gabriel Renderos.

This program is free software: you can redistribute it and/or modify it under
the terms of the **GNU General Public License v3.0 or later** (GPL-3.0-or-later)
as published by the Free Software Foundation. It is distributed in the hope that
it will be useful, but **WITHOUT ANY WARRANTY**; without even the implied
warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.

In practice: you're free to use, study, modify, and share it. Any distributed
derivative must also stay open source under the GPL — so it can never be turned
into a closed, paid clone. See [LICENSE](LICENSE) for the full text.
