# ARES Company prefill

Company creation and settings use the Czech Ministry of Finance's public ARES
REST API through the `AresRegistry` interface. The application depends only on
`findByIco`; application tests inject a fake and never call the public service.

The live adapter calls:

`GET https://ares.gov.cz/ekonomicke-subjekty-v-be/rest/ekonomicke-subjekty/{ico}`

It maps the official `obchodniJmeno`, `dic`, and `sidlo` fields to the editable
Company form. A missing VAT ID is left empty for the Administrator to enter or
correct. The official OpenAPI documentation is available in the
[ARES Swagger UI](https://ares.gov.cz/swagger-ui/).

Run the thin live contract test manually (it is intentionally outside CI):

```bash
npm run test:contract:ares
```
