# VAT Rules Engine

The pure Rules Engine in `src/application/vat-rules.ts` accepts Company details,
a monthly (`YYYY-MM`) or quarterly (`YYYY-Qn`) Reporting Period and Document
snapshots. Only Approved Documents assigned to that period contribute. Every
Document belongs to the Reporting Period of its Tax Point Date (ADR-0012); an
incoming Document's Deferred Claim moves it to a later valid period. The Import
Date never affects the period. `private.document_reporting_period` applies the
same rule in the database. Shared parsing and the Reporting Year lookup
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
A.5/B.3. Exactly CZK 10,000 is aggregated. Outgoing supplies with a supplied foreign
counterparty VAT ID are aggregated in A.5 regardless of amount. Missing
counterparty VAT IDs above the limit are excluded until corrected. Each A.4/B.2
Document has its own entry; A.5/B.3 aggregate by rate. Each value retains its
contributing Document ids, including summary totals through their Return lines.

Missing reporting fields, unsupported rates/regimes, unsupported Direction and
VAT Regime combinations, and unconverted foreign currencies are listed as
exclusions, as are non-Approved Documents with a Tax Point Date in the selected
month. `other` and outgoing EU acquisitions/services require manual
classification. Documents with no assignable month remain in the Company's
Document list.

## Live inclusion and proposed mapping

Approval records the human decision; it does not guarantee inclusion. The shared
`prepareDocumentReporting` projection evaluates the current version with the same
exclusion, period assignment and classification used by `computeVatReport`.
Detail, Document lists, period readiness and the checking workbook distinguish
approval, actual live inclusion, exclusion reason, blocking findings and advisory
findings. Historical findings remain immutable; current required identity checks
are projected separately. Ordinary domestic Documents may omit the counterparty VAT ID when the absolute
whole-Document gross amount is at most CZK 10,000, using the stored ČNB conversion
for foreign currency. Exactly CZK 10,000 qualifies; above it, both Directions
require the counterparty VAT ID. A missing supplier VAT ID within the exception
is advisory: an absent field in iVAT does not establish the original document's
legal completeness. Supplied-invalid identifiers, Company identity and the
reverse-charge/supported EU requirements retain their validation.

Available classification remains visible as a proposed mapping when a Document
is not counted. Return lines can be known even while amounts are unfinished;
a domestic Control Statement section needs the whole Document amount in CZK.
Missing or unsupported inputs receive an explanation, never a fabricated amount,
VAT ID, rate or manual line override. The same classification functions prepare
both proposals and actual report entries.

The workbook's Included sheet contains all currently included Documents. Attention
also contains included Documents with findings, with an explicit live-inclusion
column, so a bank advisory does not imply exclusion. Proposed mappings and their
unknown reasons accompany excluded work. The workbook reads live data; saved
report snapshots, freshness, statutory XML and archived artifact bytes retain
their independent identity.

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


## Proportional Deduction (§ 75, CZK)

A manually confirmed actual-use coefficient independently multiplies the original
net amount and original VAT at each rate, using exact decimal arithmetic and
half-away-from-zero rounding to two decimals. It never calculates VAT anew from
the reduced net amount. For `19.99 + 4.20` at 33%, the claim is `6.60 + 1.39`;
the Unclaimed Portion is `13.39 + 2.81`. Original net/VAT-total errors remain
blocking and gross-total discrepancies remain advisory; an inconsistent original
gross total has no displayed numeric remainder.

The claimed 21%/12% amounts feed Return lines 40/41, including the full-deduction
column, shared PDF output and XML `pln23`/`pln5` with
`odp_tuz23_nar`/`odp_tuz5_nar`. Return rounding remains at summed whole-CZK lines.
Control Statement values retain two decimals. The entire original gross amount
selects B.2/B.3 and supplier identity requirements: precisely CZK 10,000 belongs to
B.3; CZK 10,000.01 belongs to B.2 even if the claimed portion is below the limit.
New B.2 report entries persist `proportionalDeduction: true`, serialized as
`pomer=A` by both XML and PDF. Legacy, full and Partial Claim entries retain N;
B.3 has no ratio field. Report contributions still retain Document ids.

The review, live list summary and checking workbook use the same calculated
claim. Workbook rows preserve original amounts and, when a proportional Document
is present, add the mode, coefficient, claimed amounts and Unclaimed Portion.
A workbook remains a live checking export rather than an immutable VAT Report.

In addition to Earliest Claim Period and the existing pre-/post-2025 filing
rules, the selected period must share the Earliest Claim Period's calendar year.
November/December 2026 can follow October 2026; January 2027 cannot. Quarterly
periods use the same year rule. Preparing December/Q4 in the following year is
allowed while the general filing cutoff still permits it. Approval, assignment,
preparation, finalization and new XML recheck the rules in the database; archived
report/artifact reads retain their historical data. Export and Finalization are
neither filing nor annual correction.
