# Extraction golden set

This directory is the manual, opt-in accuracy baseline for real AI providers. It is not run in CI because it sends anonymized Source Files to external providers, consumes paid tokens, and depends on live API credentials and models.

The checked-in `manifest.json` uses the repository's tiny blank technical fixtures only to demonstrate and exercise the format. They are not product-quality accuracy samples. Keep real originals, anonymization maps, anonymized copies, human references and raw reports outside Git, using an external private manifest. Only synthetic fixtures belong in this directory. Human-confirmed real data is a separate prerequisite for a real baseline; this tool supplies no real accuracy claim or authorization for a paid run.

## Run

Set the providers, credentials, and default model names in the environment, then run:

```bash
EVALUATION_REPORT_PATH=/private/evaluation/run-001.json \
EVALUATION_PROVIDERS=anthropic,openai \
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

Preflight and enforced call/token/retry budgets remain the separate #303 slice. Do not treat the command as approval to run a paid baseline: models, repetition and budget still require a concrete approved plan. The tool changes no production models or Company data and consumes no Company allowance.

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
- The JSON report contains each raw Extraction, applied normalization traces and canonical expected/actual differences. Treat it as private financial data. The readable summary contains only aggregate metrics and field paths, without individual values or source paths. The external raw report additionally retains provenance, failed/missing coverage and the frozen reference snapshot. Preflight and budget enforcement remain separate work.
