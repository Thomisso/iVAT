# New § 73(3): non-working year-end remains an interpretation gap

Verified 7 November 2026 for #238 / specification #222. This note addresses ordinary domestic incoming claims with entitlement arising from 1 January 2025. It does not revise the accepted old-rule legal mechanism or address self-assessment, advances, corrections, proportional/reduced deductions, or individual tax advice.

## Result and evidence strength

**The second primary-source pass supports next-working-day advancement as a bounded implementation inference, not an express § 73(3) holding.** The general Tax Code rule and the same VAT amendment’s explicit application to preclusive taxpayer refund claims support that inference; see the memorandum findings below. Literal 31 December remains the statutory base date. Using that date without advancement is a conservative product policy, not proof that the next-working-day filing would legally fail. Neither alternative was expressly resolved for § 73(3) by the sources found. [GFŘ, section 3, page 3](https://financnisprava.gov.cz/assets/cs/prilohy/d-seznam-dani/94497_Novela_2025_Informace_zmeny_naroku_odpocet_dane.pdf); [Tax Code § 33(4)](https://e-sbirka.gov.cz/sb/2009/280?odkazId=39407959).

GFŘ reproduces the new prohibition after the second calendar year following the entitlement year and says it applies to entitlement arising from **2025-01-01**. Its domestic full-deduction example has entitlement on **2025-05-26**, earliest period July/Q3 2025, and latest actual filing **2027-12-31**; the latest ordinary period is November/Q3 2027. It expressly defines claiming as the day the return containing the deduction is filed; footnote 10 also requires supplementary filing by the deadline. This is a claim-right limit separate from the ordinary due date for a period's return. [GFŘ, section 3, example 2 and footnote 10, page 3](https://financnisprava.gov.cz/assets/cs/prilohy/d-seznam-dani/94497_Novela_2025_Informace_zmeny_naroku_odpocet_dane.pdf).

The exact new paragraph is independently reproduced in the [official adopted PSP text, amendment point 260](https://www.psp.cz/sqw/text/orig2.sqw?idd=248110). It uses expiry of the second calendar year, with no express working-day exception inside that paragraph. [PSP’s legislative history](https://www.psp.cz/sqw/historie.sqw?o=9&t=726) records Senate approval, presidential signature and promulgation as Act 461/2024 on **2024-12-23**. This verifies adopted wording and enactment history; a publication PDF/current consolidated § 73(3) could not be independently extracted from the unreadable [e-Sbírka page](https://e-sbirka.gov.cz/sb/2024/461).

## Why § 33(4) alone does not settle this

Tax Code § 33(4) advances the last day of a deadline falling on Saturday, Sunday or a holiday to the next working day, except for deadlines shorter than days. Its text is not expressly limited to ordinary return due dates. Section 35 concerns preservation by timely acts/submissions. These general provisions do not by themselves decide their scope for the new VAT claim limitation. [Tax Code §§ 33–35, official indexed text](https://e-sbirka.gov.cz/sb/2009/280?odkazId=39407959).

In a different context, NSS expressly held that § 33(4) does **not** advance the substantive assessment limitation under § 148: expiry extinguishes the assessment power even on a non-working day. Its discussion distinguishes procedural deadlines requiring taxpayer activity and § 148's substantive limitation. This is a warning against universal application of § 33, **not** a holding about new § 73(3), and does not overturn the agreed old-rule implementation evidence. [NSS 5 Afs 21/2020-56, 18 June 2021, paragraphs 37–39](https://www.nssoud.cz/stazeni-dokumentu?filepath=SOUDNI_VYKON%2F2020%2F0021_5Afs_2000056_20210618105541_20210618144024_prevedeno.pdf).

The unresolved issue is therefore **applicability**, not weekday arithmetic: does this particular right-to-claim limit use § 33(4), or does the special calendar-year expiry control? The GFŘ example cannot distinguish them because **2027-12-31 is Friday**. For a 2026 entitlement the base is **2028-12-31, Sunday**. Advancement, *if applicable*, would cross the **2029-01-01 New Year holiday, Monday**, reaching **2029-01-02, Tuesday**. Those weekdays were independently calculated with Python Gregorian civil dates; January 1's holiday status follows [Act 245/2000 §§ 1–3](https://e-sbirka.gov.cz/sb/2000/245?odkazId=39429151). These are derived dates, not a ruling or validated new-rule algorithm.

## Calendar correction to the existing old-rule note

The statement that January 1 is the only possible anniversary holiday is false. Keep the accepted old mechanism, but use the full applicable Czech holiday calendar. [Act 245/2000 §§ 1–4](https://e-sbirka.gov.cz/sb/2000/245?odkazId=39429151) includes May 1 and Easter holidays; commemorative days alone are working days.

Derived regression examples, not judicial examples:

- Monthly April 2021 entitlement → start **2021-05-01** → anniversary **2024-05-01, Wednesday**, Labour Day → **2024-05-02, Thursday**.
- Monthly March 2021 entitlement → start **2021-04-01** → anniversary **2024-04-01, Monday**, Easter Monday → **2024-04-02, Tuesday**. The holiday date is independently confirmed by [ČOI's 27 March 2024 announcement](https://coi.gov.cz/na-velikonocni-pondeli-1-dubna-je-v-provozovnach-nad-200-metru-ctverecnich-prodejni-plochy-zakazan-prodej-na-velky-patek-se-tento-zakaz-nevztahuje/).

All example weekdays were checked using Python `datetime.date`. Preserve historical holiday applicability when extending calendar coverage; this search did not independently verify the commencement date of the Good Friday amendment, so it supplies no new historical commencement claim.

## Verification limits

Read GFŘ PDF page 3, the Senate amendment paragraph, NSS paragraphs 37–39, and primary indexed e-Sbírka excerpts for Tax Code/holiday text. Direct e-Sbírka pages were unreadable to this browser; some NSS HTML endpoints also failed, so the official NSS PDF was used. Bounded searches across Financial Administration and NSS sources found no express new-rule non-working-year-end ruling or guidance. Absence from this search is not proof none exists. No production code, tests, database, tracker, Git state, or checkout files were changed; this temporary artifact is for controller review before repository placement.


## Second primary pass: explanatory memorandum and inference

The [official PSP bill 726/0 including its memorandum](https://www.psp.cz/sqw/text/orig2.sqw?idd=243017), special part headed “(§ 73 odst. 3)”, explains shortening by the need to leave the administrator time for later control/assessment when a deduction is claimed near expiry. That section says nothing about weekend computation or retaining/changing § 33 applicability.

The **same memorandum**, “K § 86e / K odstavci 2”, expressly applies Tax Code time computation, including next-working-day advancement, to the refund-claim interval. It then expressly calls that interval preclusive. This is a taxpayer act required to preserve a right. Thus a preclusive label alone does not exclude § 33(4), and § 148’s extinction of the administrator’s assessment power is materially different. These are source-supported distinctions, not a universal test. [Memorandum](https://www.psp.cz/sqw/text/orig2.sqw?idd=243017).

Operative scope: the [adopted text](https://www.psp.cz/sqw/text/orig2.sqw?idd=248110), § 86e(1)–(4), requires a refund return within the claim interval, extinguishes an unclaimed right on expiry, disregards claims outside it, and excludes restoration. Section 86e supplies no fixed calendar date itself. For a concrete calendar-year endpoint, amended **§ 83(5)** ends its refund interval at expiry of the calendar year immediately following the year it began. This makes the memorandum analogy stronger than an ordinary return due-date example: even a preclusive claim interval ending at calendar-year expiry is described as using the general working-day rule.

**Inference:** favor applying § 33(4) to the new § 73(3) claim-filing cutoff, advancing the 2026-entitlement base **2028-12-31 → 2029-01-02**, because claiming requires the taxpayer’s filing act and the amendment gives that calendar treatment to another preclusive VAT claim interval. The gap remains: § 86e governs refunds, not ordinary input deduction, and no express § 73 cross-reference/ruling settles this extension. This reasoning does not depend on the old algorithm or alter its accepted mechanism.

Additional targeted Financial Administration searches for 2028 year-end deduction examples found none relevant. PSP browser extraction omitted attachments; direct read-only official DOCX fetch succeeded. e-Sbírka returned only an unreadable shell. No consolidated-law/publication-PDF claim is made beyond the adopted-text and promulgation evidence above.
