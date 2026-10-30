# EPO export timing advisories

Rules checked on 2026-10-30. The application evaluates Prague calendar dates,
not elapsed 24-hour durations or the browser's local time zone. A Reporting
Period is unfinished through its last calendar day. A filing is potentially
late when today **or** a valid preparation date is after the applicable ordinary
deadline; this does not assert that an earlier filing never happened.

Future preparation date, unfinished period and potential lateness are independent
advisories. They never gate XML generation, artifact creation, download,
acknowledgement or Finalization. Invalid calendar dates and missing required
filing details remain `invalid_export_details`, independently of advisories.
The application export seam accepts a clock; the shared browser form follows
the Prague day on a 30-second interval and window focus, and recomputes when
the User changes the preparation date.

## Effective filing scope

Both serializers currently emit **ordinary B** (`dapdph_forma` / `khdph_forma`).
Draft/final describes an XML artifact's lifecycle, not its statutory filing
kind. No new filing-kind selector or XML regime is introduced by these advisories.

| Output / person | Ordinary period | Ordinary deadline assessed |
| --- | --- | --- |
| VAT Return / legal or natural VAT payer | Selected monthly or quarterly period | 25 days after period end, moved to the next working day if necessary |
| Control Statement / legal person | Monthly, regardless of VAT Return frequency | Same 25-day rule for a monthly output |
| Control Statement / natural person | Monthly or quarterly, matching VAT frequency | Same 25-day rule for the selected period |
| Control Statement / legal person, quarterly output | Not a statutory ordinary quarterly filing period | **No quarterly deadline claimed.** A separate advisory explains the monthly requirement; existing XML download remains available. |

Other filing kinds have different effective rules and are **not supported by the
current serializer or timing evaluator**:

| Filing kind | Official distinction | Current behavior |
| --- | --- | --- |
| Corrective VAT Return / Control Statement | Replaces the ordinary filing within the ordinary deadline | No corrective XML emitted |
| Additional VAT Return | Generally by the end of the month following discovery of the reason; requires that discovery date | No additional XML or invented discovery date |
| Subsequent Control Statement | Within 5 working days of discovering incorrect/incomplete filed data | No subsequent XML or invented discovery date |

The evaluator implements the standard ordinary VAT-payer regime, as checked on
the date above. It does not determine special partial periods, insolvency/death
deadlines, individual extensions, exceptional relief or responses to notices.
Future exports use these published rules; a legislative change requires a rule
update. It is not a historical record of exceptional deadline relief.

## Working days and independent examples

Tax Code §33(4) moves a filing deadline ending on Saturday, Sunday or a public
holiday to the nearest following working day. The holiday calendar includes
the state and other holidays in §§1–3 of Act 245/2000: January 1, May 1/8,
July 5/6, September 28, October 28, November 17, December 24/25/26, Easter Monday
and Good Friday (the latter since 2016). Commemorative days under §4 are not
automatically non-working days. Gregorian Easter is computed in UTC calendar
days, then the Czech non-working days are applied; local DST never adds or
subtracts a calendar day.

Tests call the real AppClient export seam with fixed instants. Expected dates
are literal worked examples rather than values recomputed by the evaluator:

| Reporting Period / output | Expected deadline | Independent basis |
| --- | --- | --- |
| March 2026 ordinary VAT Return | 2026-04-27 | Official 2026 tax calendar; April 25 is Saturday |
| September / Q3 2026 ordinary VAT Return, eligible Control Statement | 2026-10-26 | Official 2026 tax calendar; October 25 is Sunday |
| November 2026 ordinary VAT Return | 2026-12-28 | Official 2026 tax calendar; December 25/26 are holidays, December 27 is Sunday |
| February 2016 ordinary VAT Return | 2016-03-29 | Worked Easter example: March 25 Good Friday, March 26/27 weekend, March 28 Easter Monday |

Boundary cases use `2026-03-31T21:59Z` / `22:00Z` and
`2026-04-27T21:59Z` / `22:00Z`: Prague has moved to summer time, so the latter
instant is the next calendar day. The deadline itself is still timely.

## Official sources

- [Public Administration Portal — VAT Return](https://portal.gov.cz/sluzby-vs/value-added-tax-return-S4205): ordinary monthly/quarterly VAT-payer deadlines and special-period exclusions.
- [Financial Administration — when to file a Control Statement](https://financnisprava.gov.cz/cs/dane/dane/dan-z-pridane-hodnoty/kontrolni-hlaseni-dph/kdy): legal-person monthly frequency, natural-person VAT frequency, ordinary/corrective/subsequent distinctions.
- [Financial Administration — DPHDP3 field documentation](https://adisspr.mfcr.cz/dpr/adis/idpr_pub/epo2_info/popis_struktury_detail.faces?zkratka=DPHDP3): ordinary/corrective/additional distinctions, including the additional return's discovery-based deadline.
- [Financial Administration — Tax Code §33(4) example](https://app.fs.gov.cz/dotazy-verejnosti/dotaz/termin-pro-podani-prihlasky-k-registraci-platce-dph-1493): filing deadline adjustment to the next working day.
- [Official e-Sbírka — Act 245/2000 effective 2026-05-13](https://e-sbirka.gov.cz/eli/cz/sb/2000/245/2026-05-13), [MPSV official consolidated text](https://ppropo.mpsv.cz/zakon_245_2000): non-working holidays versus commemorative days.
- [Financial Administration — 2026 tax calendar](https://financnisprava.gov.cz/cs/danovy-kalendar), [Ministry of Finance — Financial Bulletin 6/2026](https://mf.gov.cz/assets/attachments/2026-03-24_2026-03-24-Financni-zpravodaj-cislo-6-2026.pdf): independent 2026 deadlines used in tests.
