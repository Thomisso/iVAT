# VAT Rules Engine

The pure Rules Engine in `src/application/vat-rules.ts` accepts Company details,
a monthly (`YYYY-MM`) or quarterly (`YYYY-Qn`) Reporting Period and Document
snapshots. Only Approved Documents assigned to that period contribute. Incoming
Documents use the later of their Tax Point Date and Receipt Date unless the User
explicitly claims a later valid period. Shared parsing and the Reporting Year lookup
(ADR-0013; a date outside every generated year has no Reporting Period) live in
`src/application/reporting-periods.ts`.

The Rules Engine supports CZK amounts at 21% and 12% (including amounts derived
from a stored ČNB conversion) with full input VAT deduction:

| VAT Regime | Direction | VAT Return | Control Statement |
| --- | --- | --- | --- |
| Domestic | Outgoing | 1 / 2 | A.4 / A.5 |
| Domestic | Incoming | 40 / 41 | B.2 / B.3 |
| Domestic reverse charge | Outgoing | 25 | A.1 |
| Domestic reverse charge | Incoming | 10 / 11 and deduction 43 / 44 | B.1 |
| EU acquisition of goods | Incoming | 3 / 4 and deduction 43 / 44 | A.2 |
| EU received service | Incoming | 5 / 6 and deduction 43 / 44 | A.2 |

Self-assessed VAT is calculated deterministically from the CZK tax base and
Czech rate; it is not copied from a foreign or reverse-charge invoice. Domestic
reverse-charge Documents also carry the official subject code required by A.1
and B.1. The stored draft keeps exact decimal amounts; statutory XML rounds VAT
Return lines to whole CZK while Control Statement amounts remain unrounded.

Control Statement classification uses the absolute **whole Document gross amount**,
not individual rates: above CZK 10,000 → A.4 (outgoing) or B.2 (incoming), otherwise
A.5/B.3. Exactly CZK 10,000 is aggregated. Outgoing supplies without a domestic
counterparty VAT ID are aggregated in A.5 regardless of amount. Each A.4/B.2
Document has its own entry; A.5/B.3 aggregate by rate. Each value retains its
contributing Document ids, including summary totals through their Return lines.

Missing reporting fields, unsupported rates/regimes, unsupported Direction and
VAT Regime combinations, and unconverted foreign currencies are listed as
exclusions, as are non-Approved Documents with a Tax Point Date in the selected
month. `other` and outgoing EU acquisitions/services require manual
classification. Documents with no assignable month remain in the Company's
Document list.

## Persistence

`generateVatReport` reads current versions as the caller, computes the draft and
calls `save_vat_report`. The database locks the Company's Documents and compares
the source snapshot before atomically saving the result and audit event. A stale
snapshot is refused. Members of the Company can read and regenerate its draft;
RLS and the database access predicate enforce this. Regeneration replaces the
same Company/period draft. Generation is refused with `company_setup_incomplete`
until identity and filing-frequency onboarding are complete. Stored data includes
the canonical structured Company identity (including natural-person names and
registered-address components) and all period Document snapshots (status, payload
and immutable Extraction Version id), so reads do not silently recompute after
another approval or a later Company edit.

## Primary sources

- [GFŘ guidance on vouchers](https://www.financnisprava.cz/assets/cs/prilohy/d-novinky/Informace-GFR-k-uplatnovani-DPH-u-poukazu-po-revizich-1-7-20.pdf), examples on page 6: domestic standard and reduced supplies map to 1/40 and 2/41.
- [Financial Administration: Control Statement FAQ](https://financnisprava.gov.cz/cs/dane/dane/dan-z-pridane-hodnoty/kontrolni-hlaseni-dph/caste-dotazy-a-odpovedi), questions 2, 3 and 6: whole-document amount, aggregation and the exact CZK 10,000 boundary.
- [Financial Administration: sections A.4 and A.5](https://app.fs.gov.cz/dotazy-verejnosti/dotaz/oddil-a4-a-a5-kontrolniho-hlaseni-1512): treatment of recipients without a domestic VAT ID.
- [Financial Administration: Control Statement form](https://financnisprava.gov.cz/assets/cs/prilohy/d-seznam-dani/Formular-kontrolniho-hlaseni.pdf): A.1, A.2, B.1 and reconciliation to VAT Return lines.
- [Financial Administration: Control Statement guidance](https://financnisprava.gov.cz/cs/dane/dane/dan-z-pridane-hodnoty/kontrolni-hlaseni-DPH/soubory-ke-stazeni): current filing guidance and reverse-charge subject-code requirements.
