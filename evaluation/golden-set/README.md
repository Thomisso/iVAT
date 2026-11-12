# Extraction golden set

This directory is the manual, opt-in accuracy baseline for real AI providers. It is not run in CI because it sends anonymized Source Files to external providers, consumes paid tokens, and depends on live API credentials and models.

The checked-in `manifest.json` uses the repository's tiny blank technical fixtures only to demonstrate and exercise the format. They are not product-quality accuracy samples. Keep real originals, anonymization maps, anonymized copies, human references and raw reports outside Git, using an external private manifest. Only synthetic fixtures belong in this directory. Human-confirmed real data is a separate prerequisite for a real baseline; this tool supplies no real accuracy claim or authorization for a paid run.

## Run

Set the providers, credentials, and default model names in the environment, then run:

```bash
EVALUATION_PROVIDERS=anthropic,openai \
ANTHROPIC_CONTRACT_API_KEY=... \
ANTHROPIC_CONTRACT_MODEL=... \
OPENAI_CONTRACT_API_KEY=... \
OPENAI_CONTRACT_MODEL=... \
npm run evaluate:extraction
```

When only one provider's credentials are present, `EVALUATION_PROVIDERS` may be omitted and the command infers that provider. To compare different pipeline models, set any of:

- `ANTHROPIC_EVALUATION_SPLIT_MODEL`
- `ANTHROPIC_EVALUATION_EXTRACT_MODEL`
- `OPENAI_EVALUATION_SPLIT_MODEL`
- `OPENAI_EVALUATION_EXTRACT_MODEL`

Each falls back to its provider's `*_CONTRACT_MODEL`. Pass a different manifest as the first argument, or add `--json` for a machine-readable report:

```bash
npm run evaluate:extraction -- evaluation/golden-set/manifest.json --json
```

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
- The JSON report contains each raw Extraction, applied normalization traces and canonical expected/actual differences. Treat it as private financial data. The readable summary contains only aggregate metrics and field paths, without individual values or source paths. Returned-model provenance, partial-call failure reporting and budget/preflight controls are subsequent slices of #280, not capabilities claimed by this scoring slice.
