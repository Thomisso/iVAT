# iVAT visual direction

Status: accepted prototype direction for redesign specification #73. The live
reference is `/prototype`; use `screen=overview`, `upload`, `documents`,
`review`, `vat`, `vat-output`, or `settings` to inspect each representative
workspace.

## Design thesis

iVAT is an accounting workbench, not a generic administration dashboard. Its
visual idea is a **ledger ribbon**: the same continuous path connects captured
Source Files, truthful AI processing stages, human review and statutory output.
The ribbon is the one expressive element. Tables, forms and panels around it
stay restrained, dense and rectangular enough to feel like working papers.

The earlier marker/ink metaphor is retained only as a semantic colour rule:
ochre identifies work currently performed or proposed by AI; ledger blue
identifies human navigation and actions. Field highlighting, confidence and
source citations are removed until the application has real evidence for them.

The prototype deliberately avoids the generic SaaS card kit. Panels are grouped
by workflow rather than chopped into equal promotional cards; hierarchy comes
from the ledger ribbon, rules and alignment. Rounded corners are small and
functional. Shadows are nearly absent.

## Foundations

### Colour

| Token | Value | Use |
| --- | --- | --- |
| Ledger navy | `#12304A` | Wordmark, structural headings, mobile capture field |
| Action blue | `#21628F` | Human actions, links, selection and focus |
| Action blue soft | `#E6F0F6` | Selected navigation and row context |
| Ledger paper | `#FBFBF7` | Document surface and quiet work surfaces |
| Canvas | `#F3F5F3` | Application background |
| AI ochre | `#9A6400` | Active/unconfirmed AI state only |

Existing semantic success, warning and danger colours remain. Every state also
has an icon and explicit text; colour never carries meaning alone. Production
components should move the prototype-only values into the design token source
before reuse.

### Type

Use Geist for interface text and Geist Mono for values that accountants compare
vertically: amounts, IČO, VAT ID, document numbers, dates in document previews,
hashes and queue progress. Keep body copy at 13–15 CSS px and dense table copy
at 13 CSS px. Screen headings are compact, left aligned and no larger than 38
CSS px. Do not add uppercase eyebrows except for a genuine document/form label.

### Brand mark and favicon

The mark is a folded tax form made from two interlocking `V` strokes. The ochre
check inside it represents the transition from machine-prepared data to a human
decision. Pair it with the `iVAT` wordmark in Geist at weight 760. On collapsed
navigation the mark stands alone. `src/app/icon.svg` is the favicon direction;
do not introduce another glyph for mobile or app icons.

## Layout contract

The Company context is always visible. Desktop uses a 224 CSS px sidebar; the
review workspace collapses it to a 74 CSS px rail to give the Source File and
form priority. Mobile uses a compact Company header and a five-item bottom
navigation. Emergency access to every destination remains available on mobile.

| Width | Composition |
| --- | --- |
| 360 | One-column capture-first layout; fixed five-item bottom navigation; tables become labelled cards; review preview stacks above the form |
| 720 | Desktop sidebar returns; content remains mostly one column; horizontal saved-view tabs may scroll |
| 1024 | Two-column workspaces may stack when the secondary panel would become cramped; review hides its queue but keeps preview and form side by side |
| 1440 | Full sidebar, ribbon, queue/detail compositions and three-part review workspace |

Content must not create horizontal page overflow at any of these widths.
Scrollable tables and tab lists may own local overflow.

## Navigation and screen hierarchy

The primary Company destinations are fixed and ordered:

1. Přehled / Overview
2. Nahrání / Upload
3. Doklady / Documents
4. DPH / VAT
5. Nastavení / Settings

Review is entered from Documents and keeps Documents selected. VAT Return and
Control Statement are period-scoped siblings entered from VAT and keep VAT
selected. They do not become global sidebar destinations.

## Reusable production primitives

- `CompanyShell`: expanded sidebar, collapsed review rail, mobile header and
  bottom navigation, Company chooser, user identity and skip link.
- `PageHeader`: one heading, concise description and at most one primary action.
- `LedgerRibbon`: ordered truthful stages with complete, active and waiting
  treatments. It never displays calculated progress.
- `Status`: semantic icon, text and background for neutral, active AI, success,
  warning and error.
- `QueueTabs`: saved views with one current destination and optional count.
- `TaskRow`: icon, title, explanation, optional count and destination.
- `ProcessingPipeline`: Received → Split → Extraction → Review; stages derive
  from persisted status only.
- `ReadinessFinding`: separate blocker and warning treatment with a direct next
  action.
- `SnapshotCard`: visually labels saved VAT Report data separately from live
  readiness.
- `DocumentReview`: queue, unannotated Source File preview and correction form;
  queue position and previous/next controls remain visible.
- `StatutoryOutput`: summary, line table and a separate export card for draft or
  final artifacts.

## State vocabulary

- Empty: check/document icon, explicit description and next action. Example:
  “No other active batches.”
- Active: clock/pulse icon and the real stage name. Example: “Extraction in
  progress.”
- Success: check icon and outcome. Example: “2 Documents created.”
- Warning: clock/alert icon, consequence and optional action. Warnings do not
  block finalization.
- Error/blocker: alert icon, what failed and how to recover. The original Source
  File is explicitly described as safe where relevant.

Do not display invented percentages, confidence, source regions or field
highlights. A moving bar or pulse means only that the named real stage is active.

## Interaction and accessibility

- The first keyboard stop is a skip link. Focus uses a 3 CSS px action-blue
  outline with a 3 CSS px offset and must remain visible over every surface.
- Use native links, buttons, inputs and selects. Current navigation has
  `aria-current`; processing changes use `role=status` where appropriate.
- Motion is functional: the active processing bar and pulse are the only
  automatic animation. Under `prefers-reduced-motion: reduce`, both become
  static indicators and transitions collapse to effectively zero duration.
- Previous/next controls have explicit accessible names even when rendered as
  icons. Status meaning always combines icon and text.
- Czech and English share routes, structure and states. Copy remains in
  `messages/cs.json` and `messages/en.json`.

## Prototype boundary

The prototype is intentionally static and uses representative content. It
decides composition, visual hierarchy, responsive behavior, copy tone and
component contracts. Later tickets connect these primitives to application
queries and commands; they must not copy the prototype's sample values into
business logic or imply that its buttons already mutate data.
