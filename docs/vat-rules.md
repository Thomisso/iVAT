# Domestic draft VAT Reports (#21)

The pure Rules Engine in `src/application/vat-rules.ts` accepts Company details,
a monthly Reporting Period (`YYYY-MM`) and Document snapshots. Only Approved
Documents in that month of their Tax Point Date contribute. Incoming Receipt Date
assignment and quarterly periods follow in #43.

This slice supports domestic CZK supplies at 21% and 12%, with full input VAT
deduction. It maps outgoing supplies to VAT Return lines 1/2 and incoming supplies
to lines 40/41. The stored draft keeps exact decimal amounts; statutory XML
formatting and rounding belong to #22. The totals are output VAT, input deduction,
and the positive balance as VAT payable or excess deduction.

Control Statement classification uses the absolute **whole Document gross amount**,
not individual rates: above CZK 10,000 → A.4 (outgoing) or B.2 (incoming), otherwise
A.5/B.3. Exactly CZK 10,000 is aggregated. Outgoing supplies without a domestic
counterparty VAT ID are aggregated in A.5 regardless of amount. Each A.4/B.2
Document has its own entry; A.5/B.3 aggregate by rate. Each value retains its
contributing Document ids, including summary totals through their Return lines.

Missing reporting fields, unsupported rates/regimes and foreign currencies are
listed as exclusions, as are non-Approved Documents with a Tax Point Date in the
selected month. Documents with no assignable month remain in the Company's
Document list. Comprehensive deterministic validations, currency conversion and
additional VAT Regimes follow in #36, #40 and #41.

## Persistence

`generateVatReport` reads current versions as the caller, computes the draft and
calls `save_vat_report`. The database locks the Company's Documents and compares
the source snapshot before atomically saving the result and audit event. A stale
snapshot is refused. Members of the Company can read and regenerate its draft;
RLS and the database access predicate enforce this. Regeneration replaces the
same Company/month draft. Stored data includes the Company header and all period
Document snapshots (status, payload and immutable Extraction Version id), so reads
do not silently recompute after another approval.

## Primary sources

- [GFŘ guidance on vouchers](https://www.financnisprava.cz/assets/cs/prilohy/d-novinky/Informace-GFR-k-uplatnovani-DPH-u-poukazu-po-revizich-1-7-20.pdf), examples on page 6: domestic standard and reduced supplies map to 1/40 and 2/41.
- [Financial Administration: Control Statement FAQ](https://financnisprava.gov.cz/cs/dane/dane/dan-z-pridane-hodnoty/kontrolni-hlaseni-dph/caste-dotazy-a-odpovedi), questions 2, 3 and 6: whole-document amount, aggregation and the exact CZK 10,000 boundary.
- [Financial Administration: sections A.4 and A.5](https://app.fs.gov.cz/dotazy-verejnosti/dotaz/oddil-a4-a-a5-kontrolniho-hlaseni-1512): treatment of recipients without a domestic VAT ID.
