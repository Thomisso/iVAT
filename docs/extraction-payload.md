# Extraction payload

The payload of an Extraction Version: structured data read by an AI provider or entered by a User. The TypeScript definition is `ExtractionPayload` in [`src/application/extraction-payload.ts`](../src/application/extraction-payload.ts). Change both together.

The payload is a proposal (ADR-0003). Nothing in it counts towards a VAT Report until a human approves the Document. The Deferred Claim belongs to the Document, not to the payload.

## Conventions

- A field the Document does not show is `null`. It is never guessed.
- **Amounts** are decimal strings with a dot and two decimals, such as `"1210.00"`, so no value passes through a float. Credit Notes carry negative amounts.
- New AI Extractions and User corrections omit Rate Breakdown rows only when both net and VAT amounts are zero. Nonzero bases with zero VAT and negative Credit Note amounts remain. The same rule applies to derived CZK rows and presentation; stored historical Extraction Versions stay unchanged. A new AI payload remaps confidence paths to its retained row indexes, while historical review keeps the original indexes for findings and confidence.
- **Dates** are ISO dates, such as `"2026-10-27"`.
- **Codes**: currency is ISO 4217 (`"CZK"`) and country is ISO 3166-1 alpha-2 (`"CZ"`).
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
| `czkConversion` | object, optional | Derived CZK rate breakdown/totals plus original currency, ČNB rate, quoted unit, actual fixing date and source. Printed amounts stay unchanged. |
| `confidence` | `{ [fieldPath]: number }`, optional | The provider's confidence from 0 to 1, keyed by field path (`documentNumber`, `supplier.vatId`, `rateBreakdown.0.vatAmount`). Only for fields the provider reports on |

A **Party** is `{ name, ico, vatId, street, city, postalCode, country }`.

Line items are not part of the MVP schema (#11).

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
