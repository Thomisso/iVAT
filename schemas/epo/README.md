# Official EPO schemas

Unmodified downloads from the Financial Administration's Tax Portal on 2026-10-27:

| Form | Version | Schema URL | SHA-256 |
| --- | --- | --- | --- |
| DPHDP3 | 03.01.04 (2026-08-11) | https://adisspr.mfcr.cz/adis/jepo/schema/dphdp3_epo2.xsd | `08e7b168b0675c896298217b7049889d14789353220a973665a0bf33064aa0cf` |
| DPHKH1 | 03.01.15 (2026-08-11) | https://adisspr.mfcr.cz/adis/jepo/schema/dphkh1_epo2.xsd | `fdee7efed604acff9c4862d6b5391ae019c4f0940a32086e0032b032245429f9` |

The schemas contain their own field documentation. Neither imports other schemas.
`createEpoXml` validates every candidate with libxml2-wasm before returning a
successful export. Schema parsing failures are infrastructure errors; invalid
candidate XML returns `xml_invalid`. Parsing disables external entities. No
network requests are made during export.

When updating a schema, download the original again, record its version and hash,
update `verzePis` in the serializer and rerun the golden-file and rejection tests.
The download URLs are mutable, so runtime code always uses these vendored copies.

## Mapping references

- [DPHDP3 structure and field documentation](https://adisspr.mfcr.cz/dpr/adis/idpr_pub/epo2_info/popis_struktury_detail.faces?zkratka=DPHDP3).
- [DPHKH1 structure and field documentation](https://adisspr.mfcr.cz/dpr/adis/idpr_pub/epo2_info/popis_struktury_detail.faces?zkratka=DPHKH1).
- [Official tax-office code explanation](https://podpora.mojedane.gov.cz/cs/seznam-okruhu/rozhrani-pro-treti-strany/informace-k-ciselniku-ufo-platnem-od-1-1-4382): technical `c_ufo` codes 451–464 and 13; the specialized office uses `c_pracufo=4000`. The display names are in the locale messages.

The current export supports ordinary monthly domestic filings, matching #21.
The stored Company's VAT ID, name and address fill VetaP; natural-person names
and authorized signatory details come from the per-export form. Address numbers
at the end of the Company's street are split into `c_pop` and optional `c_orient`.
Tax-office and person settings will be persisted by #27; this ticket supplies
those otherwise missing required details per download.

DPHDP3 line totals are rounded once to whole CZK, half away from zero, and summary
values are summed from the rounded lines. Control Statement values retain their
exact two decimals and its VetaC reconciles the unrounded bases of lines 1/2/40/41.
Golden files are hand-authored worked examples covering standard/reduced rates,
both Directions, individual/aggregate sections and empty natural-person reports.

XSD validation checks structure and field constraints. It does not replace the
Tax Portal's additional business checks. No live submission is performed by iVAT.
