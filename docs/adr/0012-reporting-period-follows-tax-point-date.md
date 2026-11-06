# A Document's Reporting Period follows its Tax Point Date

Every Document, incoming or outgoing, starts with the Reporting Period of its Tax Point Date as a proposed default. iVAT does not invent a Receipt Date from the Import Date. An incoming Document's input VAT may require a later unlocked Reporting Period through a Deferred Claim; ADR-0020 now defines eligibility, supported scope and the replacement for the previous general three-year limit.

This retains a predictable initial proposal while separating it from legal eligibility for the chosen claim period. When an invoice arrives after its Tax Point Date's period was finalized, it proceeds to review with a Period Lock warning (ADR-0007), and the User resolves it through an eligible unlocked period under ADR-0020 rather than silently assigning it to a locked period.

## Considered Options

- Defaulting incoming Documents to the later of the Tax Point Date and the Receipt Date (the previous behaviour) was rejected because the Receipt Date defaulted to the upload date, which silently moved Documents uploaded late into the wrong period.

## Revision accepted on 6 November 2026; implementation pending

The old general three-year Deferred Claim limit and the prior trade-off allowing a default without checking the earliest eligible period are superseded by ADR-0020. The accepted target distinguishes transitional provisions, entitlement, earliest eligibility and actual exercise by filing. The existing implementation has not changed; [the shared Document review specification](../document-review.md) records the target and its implementation gates.
