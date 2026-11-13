# Extraction golden set

This directory is the manual, opt-in accuracy baseline for real AI providers. It is not run in CI because it sends anonymized Source Files to external providers, consumes paid tokens, and depends on live API credentials and models.

The checked-in `manifest.json` uses the repository's tiny blank technical fixtures only to demonstrate and exercise the format. They are not product-quality accuracy samples. Keep real originals, anonymization maps, anonymized copies, human references and raw reports outside Git, using an external private manifest. Only synthetic fixtures belong in this directory. Human-confirmed real data is a separate prerequisite for a real baseline; this tool supplies no real accuracy claim or authorization for a paid run.

## Run

Set the providers, credentials, and default model names in the environment, then run:

```bash
EVALUATION_REPORT_PATH=/private/evaluation/run-001.json \
EVALUATION_PROVIDERS=anthropic,openai \
EVALUATION_MAX_CALLS=8 \
EVALUATION_MAX_GENERATED_TOKENS=32768 \
EVALUATION_GENERATED_TOKENS_PER_ATTEMPT=4096 \
EVALUATION_MAX_RETRIES=0 \
ANTHROPIC_CONTRACT_API_KEY=... \
ANTHROPIC_CONTRACT_MODEL=... \
OPENAI_CONTRACT_API_KEY=... \
OPENAI_CONTRACT_MODEL=... \
npm run --silent evaluate:extraction
```

When only one provider's credentials are present, `EVALUATION_PROVIDERS` may be omitted and the command infers that provider. To compare different pipeline models, set any of:

- `ANTHROPIC_EVALUATION_SPLIT_MODEL`
- `ANTHROPIC_EVALUATION_EXTRACT_MODEL`
- `OPENAI_EVALUATION_SPLIT_MODEL`
- `OPENAI_EVALUATION_EXTRACT_MODEL`

Each falls back to its provider's `*_CONTRACT_MODEL`. `EVALUATION_REPORT_PATH` is mandatory and must name a new file outside every Git repository/worktree, including ignored directories and paths reached through symlinks. The evaluator reserves it before calling AI, creates it with mode `0600`, refuses existing files, and never uploads or commits it. Keep its enclosing storage private as well.

Pass a different manifest as the first argument, or add `--json` for a machine-readable **safe aggregate summary**. Use `npm run --silent` when saving or sharing stdout so npm does not echo the command arguments, including a private manifest path. Both evaluator stdout formats omit case IDs, paths, references, raw values, error bodies and free-form provider/model labels. Only the external report contains case-level diagnostics and exact returned models:

```bash
EVALUATION_REPORT_PATH=/private/evaluation/run-002.json \
npm run --silent evaluate:extraction -- /private/evaluation/manifest.json --json
```

Process exit status describes technical completion, without an accuracy release gate:

- `0`: every planned Split and Extraction completed, even if its accuracy is poor.
- `2`: partial run; at least one measurement completed and another failed or could not be prepared.
- `1`: no measurement completed, or configuration/input/private-output validation failed.

A failed Split does not prevent isolated Extraction. Other Documents, Source Files and providers continue after a call or preparation failure. A partial or wholly failed run still saves its private report. Invalid references refuse the run before any provider calls; fatal setup errors print a generic diagnostic without confidential error text.

## Frozen comparison and provenance

Before either provider runs, the evaluator snapshots the complete validated manifest/reference facts, reads every Source File once, and prepares every reference Document once. PDF subsets use the real `pdfPages` path and production `prepareExtractionInput` rasterization contract. Both providers receive independent copies of those same frozen original/subset bytes and ordered page images. File edits during a provider call cannot alter the second provider's benchmark.

The private report stores the frozen reference snapshot, SHA-256 of the original manifest bytes and each expected JSON file, a dataset hash including source hashes and Company identity, and per-call source/input/reference/prompt/schema/configuration identities. Input hashes include prepared page-image hashes, geometry and order. The revision records the Git commit, dirty flag and an exact source/dependency-manifest hash, so local edits cannot masquerade as the committed source. The live CLI records the selected adapter source hash and requested model for each phase without storing credentials. Programmatic fake adapters may supply a non-secret identity; otherwise their method-source identity and unknown requested models are recorded explicitly.

Every planned Split/Extraction has a completed, failed or missing entry. Each completed call retains its actual returned model (or `null` if the response did not report one), available usage and measured latency. The adapters preserve their existing configured-model fallback for application compatibility while marking it as unreported evidence. Mixed model summaries list every returned model, rather than labeling a run from its first success. A returned model in an attached failed provider response is retained with that private diagnostic body. Unknown usage/cost is `null`; no estimate or missing measurement is reported as a provider invoice or zero cost.

Coverage reports expected/completed/failed/missing calls separately. All failed/missing cases remain in Split, field, known-absence, classification and Document denominators. Metric `missing` counts distinguish unavailable measurements from observed incorrect values or hallucinations. These fractions are successful correct measurements divided by the full reference denominator; they do not assert that failed calls produced incorrect financial values.

## Zero-call preflight and explicit limits

Add `--preflight` to prepare and hash the real source bytes and reference ranges
without any provider request, including token-count requests. Select providers
and models explicitly; provider API keys are unnecessary for preflight. The same
required limits apply to the plan and execution:

| Variable | Meaning |
| --- | --- |
| `EVALUATION_MAX_CALLS` | Positive global maximum of dispatched attempts, including retries and every provider/repetition. |
| `EVALUATION_MAX_GENERATED_TOKENS` | Positive global generated/output-token reservation allowance. This excludes input tokens. |
| `EVALUATION_GENERATED_TOKENS_PER_ATTEMPT` | Generated/output ceiling reserved before each request; integer at least 16. |
| `EVALUATION_MAX_RETRIES` | Explicit nonnegative number of extra attempts per measurement; only known transient provider failures may retry. |
| `EVALUATION_REPETITIONS` | Positive repetitions of the same frozen benchmark; defaults to 1. |

For example, with the model and limit variables above and a new private report
destination, `npm run --silent evaluate:extraction -- --preflight --json` returns
the safe plan. It contains Source File/page/Document counts, repetitions, planned
measurements, maximum attempts and admitted attempts under both global limits.
The private report additionally records selected models, source/prepared-input
hashes, references, exact revision and the limits. An unavailable or invalid
source refuses successful preflight. The dataset and prepared bytes are frozen
once per invocation across providers and repetitions; a later invocation checks
them again, so compare its hashes with the approved plan before a real run.

Every dispatched request reserves the full per-attempt output ceiling before
dispatch, including retries. Reservations are never refunded, even if reported
output is shorter or a request fails. The OpenAI adapter sends
`max_output_tokens`, covering generated visible and reasoning tokens; Anthropic
sends `max_tokens`. No built-in SDK retry multiplies these attempts. If a call or
generated reservation cannot be admitted, no next request is sent. Missing,
negative, fractional, overflowing or over-ceiling token usage stops further
dispatch while retaining the partial report. Metered failures can retry within
both limits; an unmetered failure cannot safely retry. Retry attempts retain
their own models, usage, latency and errors without multiplying measurement
denominators.

Observed input/generated tokens are known subtotals, accompanied by metered and
unmetered attempt counts. Observed total tokens are unavailable after any
unmetered attempt. A generated-token allowance is **not** a hard input+output
token ceiling or a guaranteed monetary cap. Requests for unsupported hard limits
(`EVALUATION_MAX_TOKENS`, `EVALUATION_MAX_TOTAL_TOKENS`,
`EVALUATION_MAX_COST_USD`, or unknown CLI flags) refuse before provider dispatch.

Optional `EVALUATION_PRICE_TABLE_PATH` points to a private JSON array of tariffs
the operator has verified. Each entry has `provider`, `model`,
`inputUsdPerMillion`, `outputUsdPerMillion` (nonnegative decimal strings, up to
six decimal places), `source` (HTTPS pricing reference), `verifiedAt` (valid
nonfuture ISO date), and `verified:true`. Duplicate provider/model entries or
invalid/unverified data refuse the run. Tariffs are supplied evidence; the tool
does not independently verify their truth or fetch live prices. For example:

```json
[{"provider":"synthetic","model":"test-model","inputUsdPerMillion":"2.00","outputUsdPerMillion":"10.00","source":"https://example.test/verified-tariff","verifiedAt":"2026-11-01","verified":true}]
```

Runtime estimates use observed valid usage and an exactly matching **returned**
model, with exact decimal arithmetic and the supplied tariff attached privately.
Unreported/different models and absent tariffs stay unavailable. Provider-reported
cost, its known subtotal, tariff estimate and its known subtotal have separate
fields and coverage counts; missing prices never become zero or invoices.
Preflight can estimate only the generated component, conservatively using the
highest supplied output tariff across admitted attempts when every selected
model is priced. Input and total price remain unavailable. Public summaries omit
tariff sources and free-form model names; the private report retains attribution
and tariff identity.

Parameter contracts: [OpenAI Responses](https://developers.openai.com/api/reference/resources/responses/methods/create),
[OpenAI token counts](https://developers.openai.com/api/docs/guides/token-counting),
[Anthropic Messages](https://platform.claude.com/docs/en/api/messages/create).
Verified from primary documentation on 2026-11-13; local fake/HTTP simulation
checks establish serialization and accounting, not live model availability,
metering accuracy, prices or extraction quality.

Do not treat this command as approval to run a paid baseline: concrete models,
repetition and budget still require an approved plan. No percentage release gate
or production model change follows from a first baseline. The tool changes no
Company data and consumes no Company allowance.

## Format

`manifest.json` has `schemaVersion: 1` and a `cases` array. Every case represents one Source File:

```json
{
  "id": "supplier-invoices-october",
  "source": "supplier-invoices-october.pdf",
  "format": "pdf",
  "pageCount": 3,
  "company": { "ico": "12345678", "vatId": "CZ12345678" },
  "expectedSplit": [
    { "firstPage": 1, "lastPage": 2 },
    { "firstPage": 3, "lastPage": 3 }
  ],
  "documents": [
    {
      "pages": { "firstPage": 1, "lastPage": 2 },
      "expected": "supplier-invoice-a.expected.json"
    },
    {
      "pages": { "firstPage": 3, "lastPage": 3 },
      "expected": "supplier-invoice-b.expected.json"
    }
  ]
}
```

Paths are relative to the manifest, which may be outside the repository. Formats are `pdf`, `png`, or `jpeg`. Every case requires an anonymized Company IČO and VAT ID consistent with its Document parties. Every expected JSON file must contain the complete current AI Extraction payload from `docs/extraction-payload.md`, including `reverseChargeCode` and every nested party, total and payment field. Use `null` only for known absence. A Document can explicitly declare `"unresolvedFields": ["supplier.vatId"]` for unreadable or undecided facts; any nonempty list refuses the whole evaluation before AI calls. It must first be resolved by a human. Duplicate reference rates, missing keys, invalid fact types and unsupported payload values also refuse evaluation.

## Scoring

- Split accuracy is exact per Source File: every inclusive page range must match in order.
- Extraction always uses the human reference page ranges, even when Split is wrong. Both report formats explicitly identify this isolated measurement; it is not end-to-end production accuracy.
- Present field accuracy and each present field's score exclude null reference values. Known absence, incorrect absence and hallucinated values have separate totals and per-field counts. Schema metadata, confidence, geometry, derived CZK amounts and human claim metadata do not count as extracted financial facts.
- Critical financial fields are Document type/number, supplier/customer IČO and VAT ID on the correct side, issue date, Tax Point Date, currency, rates, all original net/VAT/gross amounts and the original Document number (including printed Credit Note references). A Document passes only if every critical fact, including known absence, matches. Many correct ancillary or empty fields cannot hide one wrong critical value.
- Direction uses `detectDocumentDirection`, the same deterministic Company-identity/receipt rules as production, rather than the provider's raw guess. Direction and proposed VAT Regime have separate present classification scores; null references belong to absence totals. The overall correction-free Document result additionally requires both classifications and all ancillary names, addresses, due dates and payment facts to match. A critical financial pass alone does not mean an entire Document is perfect.
- Money compares exact signed original-currency values at two decimals: no arithmetic tolerance, CZK conversion, Partial Claim or automatic sign repair. Canonicalization accepts ungrouped digits (optional whitespace grouping), a dot or comma decimal separator with at most two decimals, and preserves the sign; no rounding or fuzzy corrections. Dates accept ISO dates or equivalent valid `D.M.YYYY` strings; IČO/VAT ID and IBAN ignore whitespace, and VAT ID/IBAN ignore letter case. Document numbers, names and addresses remain literal.
- Rate Breakdown order is ignored by sorting by numeric rate. Array length, every rate and every amount remain significant; missing, extra and duplicate output rows are errors. References must contain unique rates.
- The JSON report contains each raw Extraction, applied normalization traces and canonical expected/actual differences. Treat it as private financial data. The readable summary contains only aggregate metrics and field paths, without individual values or source paths. The external raw report additionally retains provenance, failed/missing coverage, budget/attempt evidence and the frozen reference snapshot.
