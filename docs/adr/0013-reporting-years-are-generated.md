# Reporting Periods come from generated Reporting Years

A Company's Reporting Periods are not derived from a filing-frequency history running up to today. An Administrator generates Reporting Years, one or many, backwards or ahead, each with its own frequency, because a Czech VAT payer may switch between monthly and quarterly filing only from 1 January (§99a). Generating a year creates its months or quarters; existing years are never overwritten. A year's frequency can be changed or the year deleted only while none of its periods has a VAT Report or a Period Lock. Documents whose Tax Point Date falls outside every generated year have no Reporting Period and carry a blocking prompt to generate that year; iVAT never generates years on its own.

## Consequences

- The filing-frequency history (`company_filing_frequency`) is replaced; existing Companies are migrated to generated years from their first effective date through the current year or the latest recorded change, whichever is later.
- Company onboarding generates the current year with the chosen frequency.
