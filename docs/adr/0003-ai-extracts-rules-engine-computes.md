# AI only extracts; a deterministic Rules Engine computes VAT

AI providers Split Source Files, extract Document fields and propose a VAT Regime. AI never assigns VAT Return lines or Control Statement sections. A deterministic, unit-tested **Rules Engine** derives those from the confirmed VAT Regime, Direction and Rate Breakdown. Every AI result goes through human review (`NeedsReview`), and only Approved Documents count towards a VAT Report. AI output is a suggestion, never a verified financial fact.

## Consequences

- Supporting a new VAT Regime is a code change in the Rules Engine, not a prompt change.
- Documents whose VAT Regime is outside the supported set are marked Manual Classification Required and excluded from VAT Reports.
