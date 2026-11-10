# iVAT design system

> Redesign note: for specification #73, the validated direction in
> `docs/design/visual-direction.md` supersedes this artifact's brand, layout,
> motion and AI-evidence guidance. Existing tokens and components remain useful
> migration input, but confidence, source highlighting and the placeholder
> wordmark must not be carried into the redesign without real supporting data.

The visual language for the iVAT app: tokens, usage rules and reference components. It is a reference for building the Next.js UI; nothing in `src/` imports it directly. The live, browsable version is the artifact at https://claude.ai/artifact/RRacoci1FeuFoymcxj3pR6.

## Files

| Path | What |
| --- | --- |
| `tokens.json` | Source of truth for every token: colours per theme (light, dark), type styles, spacing, radii, sizes, shadows. Each token has a usage note. |
| `tokens.css` | `tokens.json` compiled to CSS custom properties (`--canvas`, `--space-4` …), with dark mode via `prefers-color-scheme` and `[data-theme]`, plus one class per type style. Generated; do not edit by hand. |
| `migration.md` | How the current `src/app/globals.css` variables and classes map onto this system. |
| `components/bundle.css` | Reference styles for every component (`iv-` class prefix). Uses only the tokens. |
| `components/bundle.js` | Reference React 18 implementations (`window.iVAT`), plain `React.createElement`, no build. Port them to typed components in `src/components/`; don't import this file. |
| `components/index.d.ts` | Props of every component. |
| `components/<Name>/README.md` | When and how to use each component. |
| `components/<Name>/preview.html` | Example usage with realistic data. Rendered by the artifact page (which preloads the tokens, styles and React); it does not run standalone. |

## Rules for implementing

- Take every colour, size and radius from a token; never hard-code a value that has one.
- Use the glossary's terms in UI copy (see `GLOSSARY.md` at the repo root).
- Marker ochre (`ai`, `ai-soft`, `ai-mark`, `ai-edge`) is reserved for AI-proposed, unconfirmed content. Primary actions are always `accent`.
- Text pairs meet 4.5:1 and control edges 3:1 in both themes; keep it that way when adding tokens.

## Incremental CSS token lint

`npm run lint` runs the CSS token CLI regressions, checks application styles, then runs ESLint. Both draft and full CI use this same lint command. PostCSS parses every tracked or untracked, non-ignored `src/**/*.css` file, including CSS Modules. Reference CSS outside `src/`, inline styles and CSS-in-JS are outside this check.

Only new or changed declarations are checked. The comparison counts declarations by their enclosing selectors/at-rules, property, value and `!important`; unchanged historical declarations remain allowed even when nearby CSS changes. A new selector, changed media query, changed value or extra duplicate is checked. The base comes from the PR event's base SHA or a push event's `before` SHA; local and other workflow runs use the merge-base of `origin/main` and `HEAD`. CI fetches complete history. An unavailable or malformed base fails with a diagnostic rather than assuming there were no changes. To choose a different comparison explicitly, run `node scripts/lint-css-tokens.mjs --base <commit-or-ref>` from the repository root.

The initial scope is deliberately small:

| Declaration family | Checked literals and replacements |
| --- | --- |
| `margin`, `padding`, their physical/logical longhands, `gap`, `row-gap`, `column-gap` | Pixel lengths matching `spacing.tokens` in `tokens.json` (4, 8, 12, 16, 20, 24, 32, 48px), including negative lengths and equivalent `rem` values at a 16px root. Negative replacements use `calc(-1 * var(--space-N))`. Lengths inside `calc()`, `clamp()` and variable fallbacks are included. |
| `color`, properties ending in `-color`, `background`, `background-image`, border shorthands (including physical/logical sides), `outline`, `box-shadow`, `text-shadow`, `fill`, `stroke` | Hex colors (3/4/6/8 digits), `white`/`black` and `rgb()`/`rgba()` colors which match an existing `color.tokens` value from either theme. The diagnostic suggests a matching token. Other color syntaxes, such as HSL or `color()`, are outside this first scope. |

Custom property definitions are allowed. Zero, percentages, unitless values, `auto`, `currentColor`, `transparent`, URLs, quoted strings, dimensions without a matching token and uncovered properties (for example width, font size or outline offset) pass. There is no blanket numeric ban. A declaration needing a literal for a documented reason may have an immediately preceding `/* token-lint-exception: concrete reason */` comment; it applies to that declaration only, and an empty reason fails. Keep exceptions specific and review their reason with the change.

For example, use `margin: 0 0 var(--space-4)` and `background: var(--surface)` in place of `margin: 0 0 16px` and `background: #fff`. A suggested color token is a lookup aid: shared literal values can have several semantic tokens, and the author/reviewer must choose the correct role. Passing `var(...)` alone does not prove color semantics, contrast or focus behavior. Action-blue focus with a 3 CSS px outline and 3 CSS px offset still needs the review and behavioral evidence described in `docs/design/visual-direction.md` and the repository's CLI evidence policy; this check makes no visual or browser-behavior claim.

## Brand book

iVAT is a document ERP for Czech VAT payers and the accounting offices that serve them. People drop invoices and receipts in; AI splits them into Documents, reads their data and proposes a VAT Regime; a human approves; iVAT produces the VAT Return and Control Statement for the Reporting Period.

The whole system rests on one idea: **the AI writes in marker, people write in ink.** Anything the AI proposed and no one has confirmed is shown in marker ochre (`ai`, `ai-soft`, `ai-mark`). Approval turns it into plain `ink`. A user should be able to glance at any screen and see what still depends on a machine's reading.

### Content fundamentals

- Use the glossary's terms exactly, capitalised as nouns: Source File, Document, Split, Extraction, Extraction Version, Approved Document, Duplicate Warning, Reporting Period, VAT Regime, Rate Breakdown, Tax Point Date, Period Lock. Never "upload", "attachment", "tax code" or "filing".
- Czech is the default UI language, English the second. Write both; never mix them in one string. Keep Czech legal terms where users expect them on documents (DUZP, DIČ) only inside document previews; the UI says Tax Point Date and VAT ID.
- Plain, short, active sentences addressed to "you". No exclamation marks, no emoji, no "Oops".
- Errors say what is wrong and how to fix it, in one sentence, as the app already does: "IČO must have 8 digits." "The file content does not match its extension. Check that the file is really a PDF, PNG or JPEG."
- The AI speaks in facts with a source, not in feelings: "Line 1 reads 'Stavební práce' on page 1." Never "I think", "I'm not sure", "magic" or "smart". Uncertainty is shown by `Confidence`, not by words.
- iVAT never files with the tax authority. Say "Finalize", never "Submit" or "File".
- Buttons are verb-first, sentence case, and name the result: "Approve document", "Upload invoices", "Finalize Q3 2026".

### Visual foundations

**Colour.** Neutrals are warm paper greys (`canvas`, `surface`, `surface-sunken`) with `ink` and `ink-muted` text. Ledger blue `accent` is the only action colour: primary buttons, links, selection, focus. Marker ochre `ai` belongs to the AI and to nothing else. Status colours (`success`, `warning`, `danger`) each come with a `-soft` background and always travel with an icon and a word. Never use `ai` for warnings or `warning` for AI, even though both are warm: the lightness differs and the meaning must too.

**The paper.** Source File pages render on `paper` lying on `desk`, in both themes. The dark theme dims the paper; it never inverts a scan. Overlays on the paper use `ai-mark`, `ai-edge` and `ink-on-mark`, which are the same in both themes for that reason.

**Type.** Geist for the interface, Geist Mono for every figure that must line up or be copied exactly: amounts, IČO, VAT ID, document numbers, hashes. Dense by default: `body` 14/20, `table` 13/18, `label` 12/16. One `display` figure per screen at most, usually the VAT payable. Headings in `title` and `heading`; `eyebrow` (uppercase, tracked) only above AI panels and nav groups.

**Numbers and dates.** Amounts use `Money`: Czech format `24 200,00 Kč`, true minus `−` for Credit Notes in `danger`, right-aligned in tables with the currency in the column header. Dates are `14. 10. 2026`. VAT rates are written `21 %` and `12 %` with a space.

**Spacing and density.** 4px base (`space-1` … `space-12`). Tables use `row-compact` (36px); `row-comfortable` is a user preference, not a default. Controls are `control-md` (32px), `control-sm` (28px) inside rows and toolbars, `control-lg` (40px) for the Ask bar and sign-in.

**Layout.** Sidebar (`sidebar`, 232px) + work area. The review screen is three parts: list on the left, DocumentViewer in the middle, review panel (`review-panel`, 400px) on the right with AiValue fields, AiSuggestion and the AskBar. Under 1024px the list collapses; under 720px the panel stacks under the page.

**Borders, radii, shadows.** Hairlines (`line`) separate; shadows only lift what floats (`shadow-pop` for menus and the focused Ask bar, `shadow-sm` for the page on the desk). Inputs and other controls are edged by `line-strong` (3:1). Radii: `radius-md` (6px) controls, `radius-lg` (10px) panels, `radius-sm` (4px) badges and paper regions, `radius-full` only for the Ask bar and pips.

**Focus.** Every interactive element shows `focus-ring`: a 2px gap in `canvas`, then a solid 2px `accent` ring, at least 6:1 in both themes.

**Motion.** Functional only: 120ms for hover and press, 200ms for panels and for a value changing from marker to ink, 1600ms per pass of the scan line during Extraction. Everything stops under `prefers-reduced-motion`. No decorative animation, no shimmering "AI" gradients.

### The AI in the interface

- **Marker means unconfirmed.** `AiValue` in state `proposed` has `ai-soft` behind it and an `ai-edge` underline. Approving it removes both. Editing it makes a User-authored Extraction Version and shows "Edited".
- **Every value has a place on the page.** Hovering a field highlights its region in the `DocumentViewer`; clicking a region focuses its field. If the AI cannot point to where it read something, it does not propose it.
- **Confidence is shown, not spoken.** `Confidence` pips next to proposed values; Low (< 80 %) turns `warning` and blocks one-click approval of the whole Document.
- **Judgements get reasons.** VAT Regime, Direction, Split boundaries and duplicates are proposed through `AiSuggestion` with two to four reasons that cite the page.
- **Questions get citations.** `AskBar` answers cite pages or Document numbers as chips. It never changes data.
- **AI actions are marked.** A button that sends work to the AI uses the `ai` variant and the `marker` icon ("Extract again"). The final, human decisions (Approve, Finalize) are always `primary` blue.

### Iconography

iVAT has no icon font or logo files yet. The `Icon` component carries 18 icons drawn for this system: 16px grid, 1.5px stroke, round caps, `currentColor`. `marker` (a highlighter) is the AI's glyph and is used only for AI-authored things. Extend from Lucide at the same size and stroke. No emoji anywhere in the product.

There is no logo. The wordmark is "iVAT" set in Geist 700 beside a small `ai-mark` block outlined in `ai-edge` (see the Sidebar), a placeholder until a real mark exists.

### Using this system

Load the tokens CSS, then `components/bundle.css` (it imports Geist and Geist Mono from Google Fonts), React 18, and `components/bundle.js`, which defines `window.iVAT`. Class names are prefixed `iv-`. In the Next.js app, port the tokens into `src/app/globals.css` and the components into `src/components/` as described in `migration.md`.
