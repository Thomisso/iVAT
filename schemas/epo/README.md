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

The stored VAT Report's Company identity fills VetaP. Filing defaults supply
the tax office, optional compatible territorial office and independent signatory;
the export form permits one-export overrides. The registered or confirmed EPO
address already contains separate `c_pop` and optional `c_orient` values.

## Filing catalogues (QA v4 #140)

Official [EPO catalogue interface](https://adisspr.mfcr.cz/dpr/adis/idpr_pub/epo2_info/rozhrani_ciselniku.faces), retrieved 2026-10-30:

| Snapshot | Retrieval | Rows | SHA-256 |
| --- | --- | --- | --- |
| `catalogues/pracufo-2026-10-30.xml`, version 51.5.00210 | [pracufo, valid 2026-10-30](https://adisspr.mfcr.cz/dpr/epo_ciselnik?C=pracufo&M=10000&PL=2026-10-30) | 124 | `9736b3168fca40ff8d7f31c628093407250db16b28f54db26a90426550c129af` |
| `catalogues/okec-2026-10-30.xml`, version 51.5.00019 | [complete okec](https://adisspr.mfcr.cz/dpr/epo_ciselnik?C=okec) | 1952 dated rows, 1178 distinct codes | `a8a9723805b50a6b0ed3beace3231eca4fedba688e568ebd3e5849813a24138b` |

Request the complete activity catalogue with **only** `C=okec`. Extra parameters
can silently limit the response to 300 rows; `PL` is rejected for this catalogue.
The snapshot contains both historical and current CZ-NACE codes, including the
2026 transition. The derived `src/application/epo-catalogues.json` keeps every
published code and the latest published label for each code. Its office entries
come directly from `c_pracufo`, parent `c_ufo` and `nazu_pracufo`.

The separate official [technical-office guidance](https://podpora.mojedane.gov.cz/cs/seznam-okruhu/rozhrani-pro-treti-strany/informace-k-ciselniku-ufo-platnem-od-1-1-4382)
adds the specialized office pair 13/4000, which is absent from the regional
`pracufo` snapshot. It also confirms regional territorial office is optional.
The serializer preserves that optionality, rejects an incompatible supplied
office, and uses the mandated 4000 when the selected tax office is 13.

DPHDP3 maps economic activity to `VetaD.c_okec`; both formats map territorial
office to `VetaP.c_pracufo`. Economic activity is required by the iVAT product for
VAT Return export, even though the XSD allows omission. It is optional and not
serialized for Control Statement. Validation checks catalogue membership;
this change introduces no inference about whether report date, preparation date
or filing date determines historical code eligibility.

Private database reference tables enforce saved catalogue values and office
parentage. Existing settings acquire null fields, never invented defaults.
Serializer version 2 records the new mapping; historical version 1 XML remains
unchanged and downloadable. No catalogue requests occur during normal exports.

DPHDP3 line totals are rounded once to whole CZK, half away from zero, and summary
values are summed from the rounded lines. Control Statement values retain their
exact two decimals and its VetaC reconciles the unrounded bases of lines 1/2/40/41.
Golden files are hand-authored worked examples covering standard/reduced rates,
both Directions, individual/aggregate sections and empty natural-person reports.

XSD validation checks structure and field constraints. It does not replace the
Tax Portal's additional business checks. No live submission is performed by iVAT.
