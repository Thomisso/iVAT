# A Document's Reporting Period follows its Tax Point Date

Every Document, incoming or outgoing, defaults to the Reporting Period of its Tax Point Date. iVAT no longer tracks a Receipt Date: the Import Date is shown for information only and never decides a period. An incoming Document's input VAT can be claimed later through a Deferred Claim chosen from the Company's unlocked Reporting Periods after the Tax Point Date's period, within three years.

This trades the strict reading of §73 of the Czech VAT Act (input VAT may be claimed no earlier than the period in which the payer holds the document) for a predictable default that matches how accountants book invoices. When an invoice arrives after its Tax Point Date's period was finalized, it lands in a locked period with a Period Lock warning (ADR-0007), and the User resolves it with a Deferred Claim.

## Considered Options

- Defaulting incoming Documents to the later of the Tax Point Date and the Receipt Date (the previous behaviour) was rejected because the Receipt Date defaulted to the upload date, which silently moved Documents uploaded late into the wrong period.
