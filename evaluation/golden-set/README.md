# Extraction golden set

This directory is the manual, opt-in accuracy baseline for real AI providers. It is not run in CI because it sends anonymized Source Files to external providers, consumes paid tokens, and depends on live API credentials and models.

The checked-in `manifest.json` uses the repository's tiny blank technical fixtures only to demonstrate and exercise the format. They are not product-quality accuracy samples. No product-owner Documents were available when the harness was added. Replace or extend these illustrative cases with the product owner's anonymized samples before using the percentages to compare providers or prompts.

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

Paths are relative to the manifest. Formats are `pdf`, `png`, or `jpeg`. Every expected JSON file must contain the complete schema from `docs/extraction-payload.md`, using `null` when the Document does not show a field. Keep source and expected files next to each other, use opaque case IDs, and remove personal data before committing.

## Scoring

- Split accuracy is exact per Source File: every inclusive page range must match in order.
- Field accuracy compares literal leaf values at each payload path. It aggregates both an overall score and a score per field, per provider and returned model.
- Provider confidence values are excluded because they are not expected Document facts.
- Extraction uses the expected page boundaries, even when Split is wrong. This keeps Split accuracy and field-reading accuracy independently diagnosable.
- Array lengths and positions are significant (`rateBreakdown.length` and `rateBreakdown.0.rate`, for example). Put Rate Breakdown lines in the same stable order in expected and actual payloads.
