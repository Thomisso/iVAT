# Extraction payload

The payload of an Extraction Version: structured data read by an AI provider or entered by a User. The TypeScript definition is `ExtractionPayload` in [`src/application/extraction-payload.ts`](../src/application/extraction-payload.ts). Change both together.

The payload is a proposal (ADR-0003). Nothing in it counts towards a VAT Report until a human approves the Document. The Deferred Claim belongs to the Document, not to the payload.

## Conventions

- A field the Document does not show is `null`. It is never guessed.
- **Amounts** are decimal strings with a dot and two decimals, such as `"1210.00"`, so no value passes through a float. Credit Notes carry negative amounts.
- New AI Extractions and User corrections omit Rate Breakdown rows only when both net and VAT amounts are zero. Nonzero bases with zero VAT and negative Credit Note amounts remain. The same rule applies to derived CZK rows and presentation; stored historical Extraction Versions stay unchanged. A new AI payload remaps confidence paths to its retained row indexes, while historical review keeps the original indexes for findings and confidence.
- **Dates** are ISO dates, such as `"2026-10-27"`.
- **Codes**: currency is ISO 4217 (`"CZK"`) and country is ISO 3166-1 alpha-2 (`"CZ"`).
- The provider schema (`EXTRACTION_SCHEMA` in [`src/ai/structured-output.ts`](../src/ai/structured-output.ts)) enforces the amount, date, currency, country and reverse-charge-code formats with `pattern`, so strict structured output cannot answer in a format the validation refuses. A payload that still fails validation names the failed check in the job error, such as `invalid_country`. When Split or Extraction fails, the worker stores the provider's raw body for the current request. A SuperAdmin sees it with the operational problem, and it is deleted once the target is processed or deleted.
- `schemaVersion: 1` retains the original complete-row representation used by AI providers and historical Versions. Its Rate Breakdown members are numbers and decimal strings.
- `schemaVersion: 2` adds nullable `rate`, `netAmount` and `vatAmount` members for unfinished human-entered Rate Breakdown rows. This is a versioned change because a reader assuming complete version-1 rows could otherwise mistake missing values for zero or fail during arithmetic. Human normalization uses version 2 when a row needs that representation; existing complete version-1 data is unchanged. Provider schemas continue to request version 1.
- Every manual save requires a valid `taxPointDate`. Other missing fields, including unfinished Credit Note amounts and version-2 rows, can be saved for review. Approval requires complete data and all domain checks; financial/report preparation refuses partial rows. Review and archive readers preserve nulls, and the control workbook renders missing amounts as blank cells. Neither a missing amount nor a missing VAT rate means zero.

## Fields

| Field | Type | Meaning |
| --- | --- | --- |
| `schemaVersion` | `1` · `2` | Version of this schema; version 2 permits incomplete human-entered rows |
| `documentType` | `invoice` · `credit_note` · `debit_note` · `receipt` · `simplified_tax_document` · `other` | Kind of financial document |
| `documentNumber` | string | The number the issuer gave the Document |
| `issueDate` | date | Issue date |
| `taxPointDate` | date | Tax Point Date (DUZP) |
| `dueDate` | date | Payment due date |
| `direction` | `incoming` · `outgoing` | Direction as the provider read it; confirmed against the Company's VAT ID or IČO later (#39) |
| `supplier`, `customer` | Party | The two parties; every field of a Party may be `null` |
| `currency` | string | Currency of the amounts |
| `rateBreakdown` | `{ rate, netAmount, vatAmount }[]` | Rate Breakdown: net and VAT amounts per VAT rate. `rate` is a percentage number (`21`, `12`, `0`). Version 2 permits each row member to be null until completed. |
| `totals` | `{ netAmount, vatAmount, grossAmount }` | Document totals as printed |
| `payment` | `{ variableSymbol, bankAccount, iban }` | Payment details |
| `proposedVatRegime` | `domestic` · `domestic_reverse_charge` · `eu_acquisition_of_goods` · `eu_received_service` · `other` | Proposed VAT Regime. `other` leads to Manual Classification Required |
| `reverseChargeCode` | string | Official Control Statement subject code for `domestic_reverse_charge`; otherwise `null` |
| `originalDocumentNumber` | string | For a Credit Note, the number of the Document it corrects |
| `partialClaim` | `{ confirmed, rateBreakdown, basis?, zeroConfirmed? }`, optional | Explicit human selection of separate supplies. Absence retains full-Document reporting; an unconfirmed selection never silently restores a full claim. Full source Rate Breakdown and totals remain unchanged. |
| `proportionalDeduction` | `{ percentage, origin, confirmed, operatingExpenseConfirmed, actualUseConfirmed, basis? }`, optional | Explicit manual § 75 actual-use decision, separate from Partial Claim. One whole percentage 1–99 applies to the entire supported operating Document; source amounts remain unchanged. |
| `czkConversion` | object, optional | Derived CZK rate breakdown/totals plus original currency, ČNB rate, quoted unit, actual fixing date and source. Printed amounts stay unchanged. |
| `counterpartyLink` | object or null, optional | Server-validated Counterparty `id` and a `recorded` Party-shaped snapshot of its directory details when this Version was saved. Absence permits automatic normalized identity matching; explicit null preserves a human unlink. Supplier/customer fields remain the Document’s own data. |
| `sourceEvidence` | object, optional | Server-bound source references for this immutable Version: Source File/Document identity, original hash and oriented original or normalized basis, original page range or worksheet/absolute row and column range, `extractionVersionId`, original AI request, and per-field locations with `origin` and `originalValue`. |
| `sourceLocations` | `SourceLocation[]`, optional | Unbound provider references. PDF/images use `{ fieldPath, kind: "page", page, x, y, width, height }`: PDF pages are 1-based within the supplied slice, images use page 1, and rectangles use a top-left origin on the oriented input with coordinates from 0 to 1. Workbooks use `{ fieldPath, kind: "workbook", sheetName, firstRow, lastRow, firstColumn, lastColumn }`: exact sheet names, absolute 1-based rows and columns. Only server-bound evidence may be used in review. |
| `confidence` | `{ [fieldPath]: number }`, optional | The provider's confidence from 0 to 1, keyed by field path (`documentNumber`, `supplier.vatId`, `rateBreakdown.0.vatAmount`). Only for fields the provider reports on |

Strict AI provider requests choose the page or workbook location schema for the actual input format and include `sourceLocations` (an empty array when unavailable); older responses may omit it. Invalid entries are discarded without rejecting otherwise valid financial values. The parser checks supported field paths, input-page bounds, finite coordinates and positive rectangles entirely within the page. Workbook text labels actual column letters and retains the real first worksheet row as context alongside the Document rows. Workbook references require the exact server-supplied worksheet/range/column bounds; omitted rows, another sheet, out-of-bounds columns and image rectangles are discarded. A provider cannot author the server's trusted `sourceEvidence` identity. The worker binds surviving references to its actual Source File and Document range before rate-row normalization; AI-relative PDF pages become original pages. Images retain page 1. HEIC/HEIF uses the persisted normalized JPEG hash and bytes already sent to AI and served by the authenticated preview query; the original HEIC/HEIF hash and bytes remain separate and unchanged. Workbook references retain actual sheet names and absolute rows/columns, never image coordinates. Version insertion binds `extractionVersionId` to the newly inserted row. Raw `sourceLocations` never persist.

For every User-authored Version, an evidence-only insertion trigger discards caller-authored evidence and inherits only the authoritative previous Version's references. A changed value is marked `manual`; its original AI value and reference remain unchanged, including repeated corrections. New AI starts from its own evidence. Source-free manual Versions cannot acquire references from a supplied payload. Optional submitted `sourceRateRows` identifies base rows during deletion/compaction; the database checks uniqueness and bounds, remaps retained references, and removes this transient map. Ambiguous or invalid row maps omit rate references rather than attach them to a different row. Normalization preserves the same row map when earlier zero/empty rows disappear.

Review requests for an explicit Version load that Version's content basis. The viewer and a surviving current draft share the same frozen base through server refresh/conflict; only a successful save accepts the new base. Historical selection remounts both together. Missing locations remain informational, disable Inspect for that field, and never enqueue an AI backfill or add a financial finding. Workbook review reads expose addressable safe-text cells and real header context for the selected Version's stored source range; explicit nonexistent Version requests are refused.

A **Party** is `{ name, ico, vatId, street, city, postalCode, country }`.

Line items are not part of the MVP schema (#11).

A directory link never copies values into `supplier` or `customer`. Explicitly copying directory details is a manual correction and creates a new Version. The current review compares the Document's Party against today's linked entry; a requested historical Version uses its recorded snapshot and findings. Directory edits do not rewrite Versions or stored VAT Reports. Legacy Versions without a link stay link-free. The server replaces caller-supplied `recorded` values and checks that the entry belongs to the Document's Company. Links retained only in older Versions still protect the directory entry from deletion. A unique normalized IČO or VAT ID can link automatically only when the other supplied identifier does not conflict. Names never authorize a link. Archived matches require explicit restoration; active and archived identities share uniqueness constraints.

A new directory entry is created only inside successful approval, after warning acknowledgement. Creation, its immutable link, the new Version when needed, approval and audit commit or roll back together. Approval without identifiers requires an existing selection or explicit `counterpartyCreationConsent: {direction, party}` in the approval command. Consent binds the exact normalized submitted Party and Direction in the original request identity; it is not a reusable boolean and never enters the saved Extraction payload. Edits revoke it. Successful request replay returns the original result without another entry or Version. The legacy public approval command enforces the same identity and transaction rules; changed material directory warnings require the combined review flow.

## Partial Claim

`partialClaim` is human-authored metadata, never an AI proposal. Its optional
`basis` records the confirmed full type, direction, regime, currency, Tax Point
Date, Rate Breakdown and totals. PostgreSQL binds an initial selection to these
inputs and invalidates confirmation after a relevant change. New AI cannot create
selection metadata: insertion strips provider-authored choices and preserves a
previous human choice as unconfirmed. Manual omission preserves the previous
choice; an explicit `partialClaim: null` command returns to full amounts and is
removed before immutable storage. The authenticated correction and approval audit
points to the resulting Version. This optional command value is not a saved claim.

Its `rateBreakdown` uses the same nullable rate/net/VAT representation as a human draft. `confirmed`
records whether the preserved selection has been confirmed for the current source
values; missing or false confirmation prevents contribution to reports. Adding this
optional metadata leaves historical versions without it readable as full claims.

The supported scope is an incoming domestic Document, excluding Credit Notes,
with one complete selected row for each original supported VAT rate (21% or 12%).
Selected amounts stay in the Document currency, must be nonnegative and no greater
than that rate's full amounts, and keep net/VAT arithmetic within the existing
two-haler tolerance. Full source arithmetic remains independently required; a
gross-total warning does not become a blocking error. Either discrepancy prevents
the per-rate Unclaimed Portion from being calculated. Foreign selections use the
same stored fixing, quoted unit and integer conversion as the full Document; a
currency-rounding difference is never added to the source-currency remainder.

An all-zero selection additionally requires `zeroConfirmed: true`, set by a separate
human confirmation. It remains recorded in the Version and report snapshot with no
deduction contributor and no zero Control Statement row. Editing the selected
amounts clears that checkbox. A relevant source change or new AI still requires
renewed selection confirmation even for a previously confirmed zero. Unknown
selection metadata (including statutory deduction methods or multiple periods) is
refused. Statutory §75/§76, self-assessed and Credit Note Partial Claims remain
outside this contract. An explicit return to full amounts writes
`document.partial_claim_cleared` with the human actor and previous/new Versions;
idempotent replay writes no duplicate decision.

The full Document determines identification and Control Statement thresholds. The
same selected amounts feed the VAT Return and Control Statement and therefore the
existing shared XML, PDF and preview outputs. For full `12000.00 + 2520.00` and
selected `6000.00 + 1260.00`, the report uses the selected values on Return line 40
and Control Statement B.2 with `pomer=N`. This is not statutory proportional
or reduced deduction. One Document still has one Reporting Period.

## Example

```json
{
  "schemaVersion": 1,
  "documentType": "invoice",
  "documentNumber": "FV-2026-0001",
  "issueDate": "2026-10-01",
  "taxPointDate": "2026-10-01",
  "dueDate": "2026-10-15",
  "direction": "incoming",
  "supplier": { "name": "Dodavatel s.r.o.", "ico": "27082440", "vatId": "CZ27082440", "street": "Na Příkopě 1", "city": "Praha", "postalCode": "110 00", "country": "CZ" },
  "customer": { "name": null, "ico": null, "vatId": null, "street": null, "city": null, "postalCode": null, "country": null },
  "currency": "CZK",
  "rateBreakdown": [{ "rate": 21, "netAmount": "1000.00", "vatAmount": "210.00" }],
  "totals": { "netAmount": "1000.00", "vatAmount": "210.00", "grossAmount": "1210.00" },
  "payment": { "variableSymbol": "20260001", "bankAccount": "123456789/0100", "iban": null },
  "proposedVatRegime": "domestic",
  "reverseChargeCode": null,
  "originalDocumentNumber": null,
  "confidence": { "documentNumber": 0.98, "rateBreakdown.0.vatAmount": 0.95 }
}
```

## Earliest Claim Period

Optional `claimEligibility` is non-AI accounting metadata: `{period, origin: "user" | "same_period", confirmed, basis}`. A User explicitly confirms a generated period; the accepted rule may establish the same period only when DUZP, issue date and the actual Source File Import Date all belong to it. The database binds `basis` to the then-current document type, Direction, VAT Regime, DUZP, issue date, Source File identity and Prague Import Date. No Source File means no invented Import Date. Changed decisive facts or AI replacement invalidate a prior human confirmation; immutable earlier Versions retain their original value and origin. The metadata is included in the additive review projection and locked-base inheritance alongside directory, Partial Claim and source evidence extensions. Missing eligibility is unresolved, not proof of a violation, and blocks approval/new preparation for ordinary incoming domestic claims. Deadline calculations belong to the separate deadline workflow.

## PDF Extraction page basis (#253)

PDF Extraction sends full, oriented CropBox pages as numbered PNG images in a
single request, while retaining PDF format/page count for location validation and
original Source File identity for evidence. Split still sends the native PDF.
The server uses 144 DPI with no content trimming, preserving blank margins and
aspect ratio. Relative image pages `1..N` map to the Document's original range.
Poppler output dimensions must agree with the visible page intersection,
rotation and UserUnit; disagreement fails rather than publishing a guessed
transform. Rendering does not establish semantic accuracy of AI locations.

The worker requires `pdftoppm` (production image: `poppler-utils` and `fonts-liberation` for unembedded standard PDF fonts). Application
limits are 100 pages, 8 million pixels per page, 100 million pixels per Document,
3 MiB PNG per page and 18 MiB PNG total, before base64 encoding. A page side is
limited to 8000 pixels, or 2000 when sending more than 20 pages. Pages render
sequentially; each subprocess has at most 30 seconds within a 60-second render
budget and bounded output buffers. Private temporary PDF files are removed on
success or failure. These bounds limit raster allocation and retained images;
process/container memory limits still govern the renderer's other allocations.
No automatic downsampling, native-PDF fallback or paid historical backfill occurs.
Rendering errors use the existing technical-failure path without a successful
Extraction Version or consumed successful AI Processing Allowance.

Transport formats follow the official [OpenAI image input contract](https://developers.openai.com/api/docs/guides/images-vision)
and [Anthropic vision contract](https://platform.claude.com/docs/en/build-with-claude/vision).
The original Source File and immutable Extraction Versions remain unchanged;
explicit reprocessing creates a new version through the existing worker flow.


## Proportional Deduction (§ 75)

`proportionalDeduction` is optional human accounting metadata, separate from
`partialClaim`: `{percentage, origin: "user", confirmed,
operatingExpenseConfirmed, actualUseConfirmed, basis}`. One whole percentage
1–99 applies to every supported rate. Both scope confirmations are explicit:
ordinary operating expenditure outside fixed-asset acquisition and already
known actual use rather than an estimate. The User supplies the final coefficient
rounded upward to a whole percentage. Zero and full claims require an explicit
choice of the existing modes; they are refused in this mode.

The database binds the financial `basis` using the same source facts as a Partial
Claim. The immutable Extraction Version supplies author and time, and a
`document.proportional_deduction_changed` audit event references its id and
version. AI metadata is stripped before financial findings and at insertion;
an existing manual decision is retained as unconfirmed after AI replacement.
Invalid or unconfirmed decisions block approval and new report operations.
Earlier Versions and report/artifact bytes are never rewritten.

The current slice supports incoming domestic invoices, receipts and simplified
tax documents at 21% and 12%. Foreign-currency decisions reduce each original
net/VAT amount first, then use the same saved ČNB fixing as the full Document.
The saved currency, fixing metadata, full totals and each rate row must still
correspond to the current source amounts; missing or invalid conversion blocks
approval and report inclusion. The B.2/B.3 threshold uses the full converted
gross amount, and the Unclaimed Portion remains in the original currency,
without treating conversion rounding as expenditure.

Credit/debit notes, fixed assets, estimates,
§ 76, advances, reverse charge, EU supplies and combination with Partial Claim
are unsupported. The broader re-confirmation lifecycle remains in
#295; financial-basis changes already retain the previous percentage and invalidate
confirmation rather than restoring full amounts.
