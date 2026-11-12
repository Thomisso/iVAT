# EPO XML download (#22)

The report page offers a download form for a **saved** monthly VAT Report. It
uses the snapshot's Company header and computed data; later approvals require
regenerating the draft before they appear in the export. The serialization
and XSD validation boundary is `createEpoXml`; the user-scoped application entry
point is `exportVatReport`.

## HTTP contract

`POST /companies/{companyId}/vat-reports/{period}/xml`, where `period` is `YYYY-MM`.
Authentication uses the same Supabase session cookie as the report page. Both
Company Users and Administrators may export; RLS scopes the saved report.

Body: form data (`multipart/form-data` or `application/x-www-form-urlencoded`).

| Field | Meaning |
| --- | --- |
| `format` | `dphdp3` or `dphkh1` |
| `taxOffice` | Official technical `c_ufo` code selected from the form |
| `preparedOn` | Valid ISO preparation date |
| `signatoryFirstName`, `signatoryLastName`, `signatoryCapacity` | Required for `P` |
| `email` | Optional contact email |

Success: HTTP 200, `Content-Type: application/xml; charset=utf-8`,
`Content-Disposition: attachment; filename="DPHDP3-2026-10.xml"` (or DPHKH1).
Every file is validated against the corresponding vendored official XSD before
this response is constructed. Responses use `Cache-Control: private, no-store`.

Refusals return JSON `{ error, message }`, with a localized message:

| Status | Code |
| --- | --- |
| 400 | `invalid_export_details` when the body cannot be read as form data |
| 404 | `report_not_found` for a missing or inaccessible saved draft |
| 422 | `invalid_export_format`, `invalid_export_details` or `xml_invalid` |

Unauthenticated requests follow the app's login redirect. The browser form follows
that redirect as navigation, renders refusal messages inline and creates a file
only from a successful XML response. Exports do not mutate the report and do not
submit anything to EPO.

The legal/natural person type is taken from the Company data saved in the VAT
Report snapshot, not from the request body. Legal Companies supply signatory
details per export; natural-person names come only from the immutable Company
identity in the VAT Report snapshot. Registered address components are serialized
directly without parsing a display string.

Schema provenance, mappings, rounding and update instructions are in
[`schemas/epo/README.md`](../schemas/epo/README.md). Tests compare exports with
hand-authored XML and validate success and refusal cases without external services.

## Representation Profile (#318)

Administrators can save one protected Company Representation Profile. The current
slice supports general natural-person representatives (`4a/F`), for both natural
and legal Company taxpayers. Other representation kinds are refused with
`invalid_representative`; professional and legal-person kinds remain separate
implementation tickets.

XML, PDF and header previews share the resolved export context. `representativeMode`
may be omitted or `default` to use the Company default, `off` to explicitly remove
all representative fields, or `override` for request-only details. Overrides use
`representativeCode`, `representativePersonType`, `representativeFirstName`,
`representativeLastName`, `representativeBirthDate` (ISO calendar date) and
`representativeEvidenceNumber`. The server retains only fields for the selected
variant. Names are bounded to 20/36 characters and the evidence number to 36;
strict XML requires both names and a birth date or evidence number, as annotated
in both vendored official schemas. Incomplete review PDFs remain available.

Taxpayer identity still comes from the saved VAT Report. Existing `signatory*`
fields identify the Authorized Signatory, never the Representative or the
account author. New XML artifacts retain their exact resolved representative
profile, schema and serializer versions with their immutable bytes. Editing the
Company profile does not rewrite historical artifacts. Complete PDF downloads
archive their exact bytes and resolved filing context
in a separate immutable Company-scoped archive. They appear in export history
and never count as XML download acknowledgements or Finalization evidence.
Header/thumbnail previews remain ephemeral, and incomplete full PDF review
exports remain available and retain their incomplete context. Audit payloads
contain no raw representative names, dates or
profile. These details neither verify power of attorney nor submit a report.
