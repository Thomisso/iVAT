# Claim deadline: old § 73(3) calendar boundary

Verified 6 November 2026 for [#224](https://github.com/Thomisso/iVAT/issues/224), acceptance A22 of [#222](https://github.com/Thomisso/iVAT/issues/222). Scope: the general input VAT claim limit for supported ordinary domestic incoming Documents. This is research for implementation, not an expert confirmation or a decision about any individual claim.

## Finding and strength of evidence

**Use the third anniversary of the statutory start, advancing a Saturday, Sunday or Czech statutory holiday to the next working day, for the old general limit.** The bounded verification gate has primary examples for this exact limit. This recommendation combines the applied dates below with the general calendar rule; it is an inference about their mechanism, not an express judicial holding on § 33(4).

[NSS 4 Afs 60/2024-45, 16 December 2025, paragraphs 3–4 and 22](https://vyhledavac.nssoud.cz/DokumentOriginal/Html/747936) identifies the pre-2025 § 73(3) and expressly records these final dates. Paragraph 4 recaps the lower court's accepted calculation. The appeal was dismissed, but the disputed filing was on 14 May 2020, well after every date; the weekend/holiday margin was not dispositive. The judgment does not separately analyse § 33(4).

| Monthly entitlement period | Statutory start | Third anniversary (independent calendar check) | Final date recorded in paragraph 4 |
| --- | --- | --- | --- |
| October 2016 | 2016-11-01 | 2019-11-01, Friday | **2019-11-01** |
| November 2016 | 2016-12-01 | 2019-12-01, Sunday | **2019-12-02** |
| December 2016 | 2017-01-01 | 2020-01-01, Wednesday, New Year holiday | **2020-01-02** |
| January 2017 | 2017-02-01 | 2020-02-01, Saturday | **2020-02-03** |
| February 2017 | 2017-03-01 | 2020-03-01, Sunday | **2020-03-02** |

[NSS 10 Afs 189/2021-40, paragraph 12](https://vyhledavac.nssoud.cz/DokumentOriginal/Html/709715) independently verifies Q2 2011's interval **2011-07-01 through 2014-07-01**, including the latter date (Tuesday). Its paragraphs 9–12 distinguish this claim limit from the assessment limit under § 148; assessment proceedings do not restart the claim limit.

**Contrary incidental date:** that same paragraph 12 lists Q4 2011 through **2015-01-01**, a Thursday and holiday, without advancing it. The filing was on 29 January, so that margin was immaterial there too. The newer shifted dates support the recommended algorithm, but these decisions do not establish a uniform express holding on holiday computation. Do not describe the older decision as holiday-shift authority, the newer one as overruling it on that question, or this research as advice confirmed by a tax adviser.

## Algorithm for the agreed old-rule scope

The old statutory start is expressly reproduced in [4 Afs 60/2024-45, paragraph 22](https://vyhledavac.nssoud.cz/DokumentOriginal/Html/747936). The general anniversary and next-working-day rules appear in [Tax Code § 33(1), (4); preservation of the filing deadline in § 35](https://e-sbirka.gov.cz/sb/2009/280?odkazId=39407959). The applicability inference is bounded by the evidence above.

1. Establish the date entitlement arose and the Company's Reporting Period containing it. Do not substitute Import Date or later possession of a Document.
2. For entitlement before 2025, take the **first day of the month after that period ends**: Q2 2011 → 2011-07-01. Do not add another day to this expressly prescribed start.
3. Add **three calendar years** to that start: 2011-07-01 → 2014-07-01. Do not add three years to the Tax Point Date.
4. While the result is Saturday, Sunday or a Czech statutory holiday on that date, advance by one calendar day. Use the holiday law applicable to the resulting date, not a timeless current calendar. [Act 245/2000, §§ 1–4](https://e-sbirka.gov.cz/sb/2000/245?odkazId=63772707&predmetneDatum=2024-06-30) distinguishes holidays from commemorative days, which alone do not justify advancement.
5. Return that date **inclusive**. As a calendar-boundary check only, `evaluationDate <= lastFilingDate` is within the limit; the following day is late. This does not establish other claim conditions or prove a filing occurred.

Use civil dates in the Czech business calendar, without UTC timestamp conversion. Old starts are always day 1, so February 29 anniversary clamping is unnecessary. For this algorithm the only possible anniversary holiday is January 1; a consecutive-day loop still handles its adjacent weekend.

The five court rows above and the Q2 2011 interval are independently dated regression inputs. Check the day before, the stated last date and the following day. In particular, 2014-07-01 is included and 2014-07-02 excluded; 2019-12-02 is included and 2019-12-03 excluded. Additional **derived**, not judicial, chain cases: December 2023 entitlement → start 2024-01-01 → holiday Friday 2027-01-01 → **2027-01-04**; December 2024 → start 2025-01-01 → holiday Saturday 2028-01-01 → **2028-01-03**.

## Transition and filing versus preparation

[GFŘ, Information on deduction changes from 1 January 2025, section 3, page 3](https://financnisprava.gov.cz/assets/cs/prilohy/d-seznam-dani/94497_Novela_2025_Informace_zmeny_naroku_odpocet_dane.pdf) limits the new general rule to entitlement arising **from 2025-01-01**: the end of the second calendar year immediately following its year of origin. Earlier entitlement retains the old branch, even if possession, Import Date or preparation is in 2025 or later. Unknown entitlement facts require review, not choosing a branch from upload timing.

Its example 2 separates entitlement **2025-05-26**, Document delivery **2025-07-03**, earliest period **July/Q3 2025**, and last actual filing **2027-12-31** (Friday). The ordinary latest period is **November/Q3 2027**, not automatically December/Q4. These are separate facts; neither the chosen Reporting Period nor creating an XML establishes timely filing.

Under #222, evaluate new preparation/export using the current business date and record that date. Export and Finalization are not submission to the authority. Preserve historical report downloads; today's date does not prove an archived report was filed late. The inclusive calendar comparison is only one eligibility check.

## Limits and verification

Do not extend this result to advances, special corrections, statutory proportional/reduced deduction under §§ 75–76, RC/EU self-assessment, exceptional EU-law relief, assessment limitation under § 148, or an unverified non-working year-end under the new rule. The newer judgment concerns corrective Documents; only its applied old general-limit dates are used here, not a universal rule for corrections. Separate-supply selections use this calendar only after their eligibility within #222 is established.

Primary NSS HTML texts and GFŘ page 3 were read directly. e-Sbírka's law text was checked through indexed primary-source excerpts because direct pages returned no readable text; the cited law pages identify the general rules, not a judgment deciding their applicability here. Python's Gregorian `datetime.date` independently checked all tabulated weekdays, adjacent dates and derived weekend chains. No application code, DB stack or application test was needed for this document-only ticket. Remaining limitation: no express § 33(4) ratio or expert confirmation was obtained; the contrary older incidental date is retained above for review.
