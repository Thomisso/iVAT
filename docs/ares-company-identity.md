# ARES Company identity prefill

Provider contract checked on 2026-10-30 against the official [ARES OpenAPI](https://ares.gov.cz/ekonomicke-subjekty-v-be/rest/v3/api-docs), exposed by the Ministry of Finance's [ARES service documentation](https://data.mf.gov.cz/api/ares.html).

`GET /ekonomicke-subjekty/{ico}` returns `EkonomickySubjekt`, whose `EkonomickySubjektZaklad.pravniForma` is a code from the `PravniForma` catalogue, source `res`. It describes the Company, rather than its signatory. The summary does not expose structured first and last names.

The official catalogue was read with `POST /ciselniky-nazevniky/vyhledat`, body `{"kodCiselniku":"PravniForma","zdrojCiselniku":"res"}`. Codes 101–108 identify natural-person businesses, 424 a foreign natural person and 425 a branch of a foreign natural person. Recognized companies, cooperatives, foundations, associations and other clearly identified legal persons map to `legal`. Unrecognized or ambiguous forms (including 000 and 950) do not replace the form's person-type selection. The explicit lists in `src/ares/registry.ts` deliberately do not infer a type from the Company's trading name.

For a natural person, an optional `GET /ekonomicke-subjekty-rzp/{ico}` provides `EkonomickySubjektRzp.zaznamy`. `ZaznamRzpZaklad.primarniZaznam` marks the primary registration; `ZaznamRzp.osobaPodnikatel` describes the entrepreneur, using `AngazovanaOsoba.jmeno` and `prijmeni`. Only one primary record with matching IČO and envelope identity is accepted. Officers in `angazovaneOsoby` describe other people and are never used. Missing fields, ambiguous records or an unavailable RŽP view leave fields for manual completion. No trading-name splitting is attempted.

Company identity and the independently entered authorized signatory remain separate. Registry prefill never writes signatory defaults. Incomplete addresses also remain editable, and saving continues to enforce ordinary Company validation.

Regular tests use deterministic registry responses and the existing local Postman ARES simulation. Reserved test IČOs 90000001, 90000002 and 90000003 model complete natural identity, a missing surname and unavailable ARES respectively; other simulation requests retain the legal-person fixture. These fixtures establish caller behavior, not actual registry availability or completeness for every entrepreneur. The existing `npm run test:contract:ares` remains an explicit opt-in live check.
