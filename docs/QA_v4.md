# QA v4: spolehlivé dávky, pravdivý stav exportů a jednotná administrace

**GitHub issue:** [#133](https://github.com/Thomisso/iVAT/issues/133) — uzavřené po merge [PR #151](https://github.com/Thomisso/iVAT/pull/151) do `main` dne 30. 10. 2026.

**Aktualizace stavu 12. 11. 2026:** dodávka této etapy je dokončená; následující text zachovává původní schválenou specifikaci a tehdejší testovací plán. Nové ověřování se řídí současnými [CLI pravidly](agents/cli-processes.md).

**Stav:** schválená specifikace podle uzavřeného rozhovoru nad QA v4. Uživatel potvrdil také testovací rozhraní: stávající Playwright scénáře, integrační testy aplikačních služeb proti lokální databázi a cílené databázové kontroly oprávnění, souběžných duplicit a zamykání. Implementace není součástí vytvoření této specifikace.

## Problem Statement

Přidávání souborů do fronty dnes nahrazuje předchozí výběr. Uživatel proto nemůže spolehlivě připravit dávku postupným výběrem, přetažením nebo fotografováním. Chybí odebrání čekajícího souboru a ochrana před totožnými soubory v jedné dávce. Filtr dávek podle zdaňovacího období navíc neodpovídá tomu, že jedna dávka může obsahovat doklady z více období.

Průvodce DPH nerozlišuje dokončení obou XML výstupů, přeskočení draftu a následné finální exporty. Dnes může jediný vytvořený artefakt dokončit exportní krok a samotné uzamčení dokončit závěrečný krok, přestože finální XML nebyla stažena. Exportní tlačítka pouze odkazují na detail místo přímého exportu. Chybějí údaje ekonomické činnosti a územního pracoviště i neblokující upozornění na datum vyhotovení a načasování podání.

Identita firmy se z ARES předvyplňuje neúplně a uživatel musí zbytečně doplňovat typ osoby. Nulové řádky rozpisu DPH zhoršují čitelnost. Chybějící nebo neověřený bankovní účet potřebuje srozumitelné upozornění bez blokování schválení.

V rozhraní se překrývá ovládání zdaňovacích roků, checkboxy se zobrazují nad popisky a některé administrační karty nevyužívají desktopovou plochu. Datumová pole opakují nápovědu formátu a nemají kalendářový výběr. Z detailu otevřeného ze Zpracování se nelze vrátit do původního kontextu. Navigace duplikuje administraci, běžnému uživateli ukazuje firemní Nastavení a SuperAdminovi nedává požadovaný přístup napříč firmami bez Membership.

## Solution

Umožnit postupně sestavit obnovitelnou Upload Queue bez totožných souborů, upravit ji před zahájením uploadu a jedním tlačítkem „Nahrát dávku“ vytvořit Upload Batch. Při částečném neúspěchu pokračovat pouze s neúspěšnými soubory ve stejné dávce. Dávky filtrovat podle data jejich založení.

Rozlišit volitelný Export DRAFT XML a povinné dokončení finálních XML po Finalization. Pro VAT Return a Control Statement sledovat jednotlivé úspěšné downloady, zobrazovat „Částečně dokončeno“, „Vynecháno“ a „Hotovo“ podle skutečnosti a spouštět export přímo z průvodce. Úplné nastavení firmy použít bez mezikroku; formulář automaticky nabídnout pouze při chybějících údajích. Zachovat dobrovolnou úpravu ekonomické činnosti pro konkrétní export.

Doplnit ARES předvyplnění, neblokující bankovní a datumová upozornění, čitelný rozpis DPH, kalendář vedle ručního zadávání data a návrat do původního pracovního kontextu. Sjednotit layout a navigaci pro firemní, organizační a platformní pohled. SuperAdmin získá skutečná administrátorská oprávnění napříč Organizations a Companies pod vlastní identitou, při zachování MFA, auditu a doménových ochran.

## User Stories

1. As an Administrator, I want ARES to prefill whether a Company is a natural or legal person, so that I do not have to re-enter reliably available identity data.
2. As an Administrator, I want reliable natural-person identity fields prefilled and missing fields editable, so that incomplete registry data does not prevent Company setup.
3. As an Administrator, I want to confirm the responsible or signing person independently of the Company name, so that exports identify the intended signatory.
4. As a User, I want successive file selections and drops to accumulate in one Upload Queue, so that adding files does not erase my previous selection.
5. As a mobile User, I want successive photographs to accumulate in the Upload Queue, so that I can prepare one batch from multiple captures.
6. As a User, I want to remove an individual waiting file with an accessible icon action, so that I can correct the queue before upload.
7. As a User, I want my pending Upload Queue restored after reloading the page and kept separate for each Company, so that I do not lose work or upload into the wrong Company.
8. As a User, I want identical file contents prevented from appearing twice in one Upload Batch even under different names, so that I do not upload the same Source File twice.
9. As a User, I want a brief explanation when an identical file is not added, so that the omission is understandable.
10. As a User, I want “Nahrát dávku” to create the Upload Batch only when I start uploading, so that the distinction between preparation and upload is clear.
11. As a User, I want a started Upload Batch to keep its original file selection, so that retries refer to a stable batch.
12. As a User, I want failed files retried in the same Upload Batch without re-uploading successful files, so that partial failures do not create duplicates.
13. As a User, I want individual upload failures to remain visible and recoverable, so that I can identify what did not arrive.
14. As a User, I want Upload Batches filtered by an inclusive “Nahráno od–do” date range, so that mixed-period batches can be found by their upload activity.
15. As a User, I want Reporting Period filters retained for Documents, so that I can still find Documents by their tax treatment period.
16. As a User, I want all-zero Rate Breakdown rows omitted, so that empty rates do not obscure meaningful amounts.
17. As a User, I want nonzero bases with zero VAT and negative Credit Note amounts preserved, so that valid tax data is not removed.
18. As a User, I want distinct warnings for a missing bank account, an unpublished account and an unavailable registry check, so that I understand the verification result.
19. As a User, I want bank-account warnings alone to permit Document approval and reporting, so that advisory findings do not become blockers.
20. As an Administrator, I want to maintain the Company’s default economic activity, so that VAT Return exports include the required product data.
21. As an authorized exporting User, I want the economic activity prefilled from Company settings, so that I can export without repeated entry.
22. As an authorized exporting User, I want “Upravit pro tento export” to allow an economic-activity override, so that a particular export can differ from the default.
23. As an Administrator, I want territorial offices offered according to the selected financial office, so that I can choose a compatible office.
24. As an authorized exporting User, I want complete saved filing details used immediately, so that an export click directly starts the download.
25. As an authorized exporting User, I want missing filing details requested in place before continuing the export, so that incomplete settings do not send me through unrelated screens.
26. As an Administrator, I want Company defaults changed only through an explicit save choice, so that a one-off export adjustment does not silently change future exports.
27. As an authorized exporting User, I want separate warnings for a future preparation date, an unfinished Reporting Period and a potentially late filing, so that I can review timing without losing access to the export.
28. As a User, I want the optional step labelled “Export DRAFT XML”, so that draft outputs are distinguishable from final outputs.
29. As a User, I want each draft XML action to export and record the selected output directly, so that I do not have to follow a link to another export form.
30. As a User, I want the draft step marked “Částečně dokončeno” after one of its two distinct outputs is downloaded, so that progress reflects the actual work.
31. As a User, I want the draft step marked “Hotovo” only after both distinct outputs are downloaded, so that repeated exports of one format do not falsely complete it.
32. As a User, I want to skip both draft exports and see “Vynecháno”, so that optional drafts do not block Finalization.
33. As a User, I want to skip the remaining draft after downloading one and retain a partial-completion label, so that the completed work is not hidden.
34. As a User, I want to revisit skipped draft outputs while the Reporting Period is unlocked, so that skipping is reversible.
35. As a Company member, I want draft completion and skip choices shared for the current VAT Report version and reset on regeneration, so that collaborators see consistent progress.
36. As an Administrator, I want Finalization to continue locking the Reporting Period independently of export completion, so that document protection and download progress have distinct meanings.
37. As an authorized exporting User, I want final VAT Return and Control Statement XML actions enabled only while the Reporting Period is locked, so that drafts cannot stand in for final exports.
38. As a User, I want the final step marked “Částečně dokončeno” with 0/2 or 1/2 downloads and “Hotovo” only at 2/2, so that a lock alone does not claim the exports are finished.
39. As a User, I want every new Finalization to require both final downloads again even for an unchanged report version, so that completion refers to the current Period Lock.
40. As a User, I want older XML artifacts retained in history, so that resetting current progress does not erase prior exports.
41. As a User, I want export progress recorded only after the browser receives XML and initiates its download, so that artifact creation or a failed response does not falsely count as a download.
42. As a User, I want repeated exports of one format counted once and failed attempts not counted, so that completion stays truthful.
43. As a User, I want to return from a detail to the originating Company, Reporting Period, filters and list page, so that following a finding does not lose my workflow.
44. As a User entering a detail from a direct link, I want a sensible fallback destination, so that a missing origin does not leave me stranded.
45. As an Administrator, I want Reporting Year controls that do not overlap, so that I can change or delete a year without ambiguous actions.
46. As a User, I want checkboxes beside their labels and finalization notices wide enough to read, so that confirmations remain clear.
47. As a User, Administrator or SuperAdmin, I want consistent card alignment, spacing and responsive layouts, so that all administrative levels feel coherent on desktop and mobile.
48. As a User, I want every date field to support both manual entry and calendar selection, so that I can use the input method that suits the task.
49. As a User, I want redundant date-format help text removed while useful instructions and errors remain, so that forms are compact without hiding validation.
50. As a User, I want Company and Organization Settings hidden while personal security and MFA remain accessible, so that navigation matches my Role without removing account protection.
51. As an Administrator, I want one Settings entry with distinct Company and Organization areas visible according to my scope, so that administrative functions are discoverable without duplicated menus.
52. As a SuperAdmin, I want to switch between Company work and the SuperAdmin section and reach platform functions through its Settings, so that navigation does not repeat administration links.
53. As a SuperAdmin, I want to discover, enter and administer every Organization and Company without a Membership, so that platform support does not require artificial tenant assignments.
54. As a SuperAdmin, I want to act under my own identity with mandatory MFA and attributable audit records, so that cross-tenant actions remain accountable without impersonation.
55. As a SuperAdmin, I want to administer a blocked Organization while the block continues to apply to its other users, so that I can investigate and resolve problems.
56. As a SuperAdmin, I want ordinary processing to resume only after an Organization is unblocked, so that support access does not silently reactivate work.
57. As a SuperAdmin, I want access to retained history and audit of a deleted Company without restoring it or enabling ordinary processing, so that historical inspection respects its deleted state.
58. As an Administrator or SuperAdmin, I want Period Locks, required confirmations, Finalization readiness and deletion safeguards preserved, so that broader access does not waive business rules.
59. As an ordinary User or Administrator, I want tenant isolation and my existing Role scope preserved, so that SuperAdmin expansion does not expose another Company’s data to me.
60. As a Czech- or English-speaking User, I want the same workflows, navigation and state meanings in both languages, so that locale does not change the product contract.

## Implementation Decisions

- Extend the existing Company identity and ARES prefill boundary to carry reliably available person type and natural-person identity fields. Preserve manual correction and explicit handling of unavailable or incomplete data. Do not infer a signatory from the business name. Verify the provider’s actual field semantics against its official contract before mapping them.
- Extend the existing Company filing-defaults, export-details validation and EPO serialization boundaries with economic activity and territorial office. Economic activity is product-required for VAT Return export; this is not a claim that every relevant XSD marks it mandatory.
- Offer territorial offices scoped to the selected financial office and prevent an incompatible saved selection from being used after the financial office changes. Verify the official catalogue and XML field mapping rather than inventing office codes.
- Resolve export inputs from saved Company defaults. With complete settings, the primary action exports immediately. If required values are missing, collect them in place, preserve the current workflow context and continue the requested export. “Upravit pro tento export” is a separate voluntary action. A per-export override does not persist as a Company default unless an authorized Administrator or SuperAdmin explicitly saves it.
- Add independent nonblocking export warnings for preparation date after today, a Reporting Period that has not ended, and potential late filing according to the selected period, output and filing kind. Use Prague calendar dates and a controllable current date for verification. Invalid calendar input remains an ordinary validation error; the timing warnings do not block generation or download.
- Establish exact deadline rules, filing-kind differences, non-working-day adjustments and any output-specific frequency differences from official sources during implementation. Record the source and effective scope with the rule cases. The conversation specifies the warning behavior, not a new statutory deadline table.
- Keep the existing Company-scoped, locally restorable upload draft. Append file selections, drops and successive photographs instead of replacing them. Waiting entries expose an accessible remove action before upload starts.
- Content equality, rather than filename equality, determines an identical file within one Upload Queue or Upload Batch. Reject or reuse an existing identical entry and briefly explain that another copy was not added. Equal filenames with different content remain distinct files.
- Enforce the no-identical-content rule at the authoritative upload boundary as well as in the browser, including concurrent submissions. Scope it to one Upload Batch; do not introduce a global ban across batches or Companies. Preserve idempotent retries of the same Source File rather than treating them as a new forbidden duplicate.
- “Nahrát dávku” starts the Upload Batch. Once started, freeze its selected file set, preserve the Batch and Source File identities across reloads and retry only unsuccessful transfers. Successful files remain untouched, and per-file failures remain visible.
- Keep identical-file prevention distinct from existing Document Duplicate Warnings, which remain nonblocking and may concern different Source Files containing the same financial Document.
- Replace the Upload Batch Reporting Period filter with optional creation-date bounds labelled “Nahráno od–do”. Include both endpoint days using Europe/Prague calendar boundaries. Apply bounds to batch creation, not completion, first-file time or a contained Document’s period. Preserve Document Reporting Period filters.
- Omit Rate Breakdown rows only when both net and VAT amounts are zero. Preserve nonzero bases with zero VAT and negative Credit Note amounts. Do not rewrite existing immutable Extraction Versions; suppress empty rows in current preparation and presentation consistently without changing meaningful tax amounts.
- Keep VAT payer registry checks behind the existing boundary. Distinguish a missing account, an unpublished account and an unavailable or failed check with advisory findings. Do not present an unavailable check as proof that an account is unpublished. These findings alone do not block approval, reporting or Finalization, and they do not remove the ordinary human review of AI Extraction.
- Preserve the existing five-stage processing flow, but distinguish the optional Draft XML stage from Finalization plus final-export completion. Draft and final output actions call the existing export flow directly rather than linking to a report-detail anchor.
- Persist draft skip and download progress for the Company, Reporting Period and current VAT Report version, shared across authorized Company users and browser sessions. A version needs its generation identity; the report row identifier alone is insufficient because regeneration can reuse it.
- Track the VAT Return and Control Statement as distinct outputs. The draft state is unfinished before any action, “Vynecháno” if both are skipped, “Částečně dokončeno” after one successful distinct download, and “Hotovo” after both. Skipping the remainder after one download retains “Částečně dokončeno — 1/2, druhý export vynechán”. Permit later draft download while unlocked. Regeneration clears the current version’s progress and skip choices without deleting history.
- Draft export and its completion are optional. Finalization is available when the existing readiness and authorization prerequisites are met, including when drafts were skipped or only one was downloaded.
- Finalization remains the explicit act that creates a Period Lock. It is not a filing event and does not itself mark final exports complete. Preserve current confirmation, current-snapshot, identity and blocker requirements.
- Final XML actions are enabled only for a locked Reporting Period. Draft XML cannot satisfy a final download. At 0/2 and 1/2, the final stage shows “Částečně dokončeno” with the count; only 2/2 is “Hotovo”.
- Persist final-download progress against both the report version and a distinct current Finalization/lock identity. Every new lock begins at 0/2, including unlock/relock without regeneration. Retain old immutable artifacts and audit history. Existing artifact identity tied only to report generation is insufficient to distinguish lock cycles.
- An XML artifact being generated and archived is not a completed browser download. Record success only after the browser receives the successful XML response and initiates downloading it. This does not claim to verify a local disk save.
- The authorized completion command must identify the corresponding artifact and reject mismatched Company, period, format, report version or current lock identity. Persist acknowledgements idempotently so duplicate callbacks, repeated exports of one output and failed responses cannot falsely reach 2/2. A failure after server-side archiving but before browser receipt leaves history intact without completing the output. A retry or re-download may complete only an artifact belonging to the current applicable version and lock.
- Extend the existing application/query boundaries for wizard state, skip choices and acknowledged downloads, and their database-backed transitions, rather than introducing a parallel workflow engine. Keep the existing authenticated export routes and validation/archive behavior; no new public API is required.
- Carry an explicit, safe internal return context when opening a detail from a list or finding. Restore the Company, period, filters, list page and relevant workflow location; supply an appropriate fallback for direct entry. Do not trust an arbitrary external return URL.
- Keep the accepted desktop-oriented visual direction and shared shell/layout components. Fix Reporting Year control overlap, legacy narrow card constraints, Batch deletion and Organization member layouts, and the finalization notice width without changing Reporting Year domain semantics.
- Use a consistent checkbox-left/text-right pattern with readable multiline labels. “Same cards” means consistent alignment, spacing, typography and responsive sizing appropriate to content, not identical fixed dimensions.
- Extend the shared date-field component to allow calendar selection alongside manual Czech-format entry. Keep typed and selected values synchronized with the existing calendar-date submission format, required/disabled behavior, clearing, reset and validation. Apply it to Document dates, XML preparation dates, Organization audit, Platform AI usage and the new Upload Batch date bounds. Remove only redundant format hints, not meaningful instructions or errors.
- Remove the duplicated Administration navigation. Keep a Company work section and a SuperAdmin section, with an explicit switch for SuperAdmin. In Company work, expose a single Settings entry to Administrator and SuperAdmin, with separate Company and Organization areas according to scope. Put existing platform administration destinations under Settings in the SuperAdmin section.
- A User has no Company or Organization Settings entry but retains personal security/MFA access. Hiding navigation is not authorization. Do not expand Administrator or User scope while changing navigation.
- Implement the accepted platform-wide SuperAdmin authority in the database visibility policies and privileged commands, including listing, entering and administering Companies and Organizations without Memberships. Do not simulate it with hidden links, synthetic Memberships, client-side permission checks or impersonation.
- SuperAdmin acts under their own authenticated identity with required MFA. Audit records retain the actual actor and keep existing User personal-data constraints. Broad authority does not bypass Period Locks, explicit unlock confirmation and reason, Finalization readiness, data retention or current archive-before-deletion safeguards.
- Permit SuperAdmin inspection and administration of blocked Organizations while ordinary users remain blocked. Ordinary processing resumes only after unblocking. Expose a deleted Company’s retained data and audit as history without automatically restoring it or allowing ordinary processing.
- Preserve the existing platform ownership of AI Configurations and AI Processing Allowance. Global SuperAdmin access does not restore Company-managed AI credentials or broaden ordinary Roles.
- Keep Czech and English copy, states and routes consistent. Export progress survives navigation and reload and is derived from persisted facts, not optimistic clicks or artifact row counts.
- Build implementation tickets in isolated worktrees with their own local Supabase stacks and free development ports. If this spec is split into parallel tickets, follow the established independent review gates, focused per-ticket test budget and final integration verification workflow.

## Testing Decisions

- **Confirmed test strategy:** the user accepted the existing Playwright user-journey seam as the primary UI seam and application-service integration tests under actual Role identities against the local database as the domain/authorization seam. Use direct database requests only where they add evidence for authorization, concurrency or invariant enforcement. No separate testing framework or general-purpose test facade is required.
- Good tests assert visible outcomes, generated XML, durable state, preserved files, refusals and audit attribution. Avoid assertions that mirror reducers, helper calls, CSS classes, component nesting or implementation-specific state wiring.
- Extend the existing upload-workspace, mobile-capture and Source File/Upload Batch coverage for sequential picks/drops/photos, individual removal, Company-scoped restoration, renamed identical contents, same-name different contents, concurrent identical uploads, stable retries after response loss, mixed transfer outcomes and a frozen started batch. Verify byte preservation and that retries do not duplicate work.
- Extend existing Company onboarding/ARES coverage and its Postman ARES simulation with legal-person, natural-person, incomplete and unavailable responses. Check editable fallback and independent signatory entry through the application/browser boundaries. Verify official mapping with the existing opt-in contract-test approach; regular tests must not call the live registry.
- Extend Document review, validation and VAT registry prior art to cover zero/zero row suppression, meaningful zero-tax and negative rows, unchanged historical versions, missing/unpublished/unavailable bank findings and approval/report inclusion despite those warnings. Retain genuine blocker behavior and mandatory review after AI Extraction.
- Extend Company filing-defaults and EPO export tests to verify required economic activity, compatible territorial office selection, saved defaults, per-export overrides, explicit default persistence, complete-settings direct export and missing-settings inline completion. Validate emitted XML with the existing official-schema and fixture approach for VAT Return and Control Statement, including monthly, quarterly and empty report fixtures where currently supported.
- Exercise the wizard through the browser with actual downloads and reloads: no draft action, skip both, one draft, skip the remainder, both drafts, regeneration, final lock with 0/2, one final output, repeated same output, both final outputs, failed response, unlock and unchanged-version relock. Extend the existing wizard, export-history and draft/final artifact integration coverage for shared persisted progress, idempotent acknowledgement and stale/mismatched artifact refusal. Test a response failure after artifact creation to prove history alone cannot complete the step.
- Use a fixed clock and official-source-derived cases for future preparation dates, unfinished periods and potentially late filing. Cover period/output/filing-kind differences and relevant calendar boundary cases; warnings remain visible but permit valid XML export. Keep malformed dates and missing required fields as separate validation cases.
- Extend existing date-field and Czech-date browser coverage for keyboard entry, calendar choice, synchronization, clearing/reset, required/disabled behavior and invalid calendar dates. Check the batch date filter at both inclusive Prague-day bounds, around UTC offset/day changes and with batches containing Documents from different Reporting Periods. Verify returning from a finding preserves the original filters and page.
- Extend existing Company, Organization and Platform shell journeys for the simplified navigation, User Settings visibility, personal security access and Company/Platform switching. Verify discoverability and direct-link access for a SuperAdmin with no target Membership rather than using a fixture that already has tenant access.
- Extend existing tenant-isolation, Membership, MFA, platform administration, audit, Period Lock and Company-deletion integration tests. Positive cases cover membership-independent SuperAdmin access, blocked-Organization administration and deleted-Company history. Negative cases retain ordinary Role isolation, failed MFA refusal, no processing while blocked/deleted, locked-data refusals, unlock prerequisites and archive-before-deletion requirements. Verify actions attribute the real SuperAdmin without synthetic Memberships.
- Reuse desktop-layout and shell-contract prior art for Reporting Year controls, confirmation checkboxes, wider notices, Batch deletion and Organization members. Check long labels/values and the accepted 360, 720, 1024 and 1440 widths for non-overlapping controls, usable focus and no page-level horizontal overflow. Use representative visual inspection and accessibility checks rather than broad snapshots of every page.
- Keep external services deterministic through the existing local simulation/fake boundaries. Extend the ARES simulation contract alongside its adapter changes. Do not invent a new ADIS mock platform or run regular tests against public services; reuse the existing registry test boundary and opt-in contract checks.
- Run focused tests, typecheck and lint for each implementation ticket. After integration, run the serial full test suite, typecheck, lint, production build and relevant runtime/browser journeys on the integration result. Next.js changes require verification in a running isolated dev app under the project’s runtime-check workflow. Do not run competing full database suites in parallel ticket worktrees.
- These are acceptance and verification requirements for implementation. Creating this specification does not mean that the behavior or its tests have already passed.

## Out of Scope

- Submitting VAT Return or Control Statement to the tax authority, or treating download completion as proof of filing.
- Replacing existing VAT rules, changing Reporting Period assignment or Deferred Claim semantics, changing Reporting Year generation, or adding unsupported filing regimes.
- Automatic human-review approval, blocking approval solely because of the bank findings described here, or removing meaningful zero-tax/negative Rate Breakdown rows.
- Rewriting historical immutable Extraction Versions, deleting historical XML when progress resets, or counting draft downloads as final downloads.
- Removing Document Duplicate Warnings, globally rejecting identical files across different batches, or preventing different Source Files merely because they contain a duplicate financial Document.
- Adding files to an already started Upload Batch.
- Confirming that the user saved a download to disk; the agreed observable event is response receipt plus download initiation.
- Impersonation, synthetic SuperAdmin Memberships, relaxing MFA, bypassing Period Locks, changing other Roles’ tenant scope or waiving deletion/retention safeguards.
- Restoring deleted Companies or resuming their ordinary processing; silently reactivating a blocked Organization.
- Company- or Organization-owned AI credentials, alternative AI commercial limits, a new public API, or a new tax-authority submission integration.
- A new visual brand, identical fixed-size cards, a replacement test framework, or an unrelated architecture rewrite.
- Starting implementation, opening implementation PRs or creating a child-ticket breakdown as part of publishing this spec.

## Further Notes

- This specification synthesizes the confirmed QA v4 discussion, including the later calendar picker requirement, partial completion at 1/2 draft outputs, partial completion at 0/2 or 1/2 final outputs, fresh final downloads for every lock cycle, direct export from complete settings and full SuperAdmin authority.
- The accepted domain decisions are recorded in the root glossary and ADR-0007, ADR-0008, ADR-0009, ADR-0011 and ADR-0014. ADR-0014 extends the current membership-gated implementation; ADR-0008 continues to require PostgreSQL authorization. Navigation changes alone cannot satisfy this specification.
- The accepted design direction remains the shared accounting workbench. The Reporting Year overlap screenshot is local QA evidence and must not be assumed to be an attachment available from the GitHub issue.
- The local glossary, QA v4 document and new ADR-0014 were uncommitted when the spec was prepared. The issue is self-contained; an implementer must carry the approved domain-document changes into the implementation branch rather than assume a remote checkout already contains them.
- Existing XML fixtures show that both output formats can be generated for empty report data. The completion contract counts the two distinct outputs and does not introduce an empty-data exemption or make a legal claim that an empty Control Statement must be filed.
- External registry fields, financial-office catalogues and exact filing calendars are facts to verify from primary official sources during implementation, not additional product interview questions. The warning-only timing behavior and product-required economic activity are already decided.
- Original QA traceability: finding 1 → ARES/identity; 2 → Reporting Year layout; 3 → Upload Queue; 4 → Rate Breakdown; 5 → bank warnings; 6 → economic activity/territorial office; 7 → timing warnings; 8 → checkbox layout; 9 → optional Draft XML/direct export; 10 → finalization notice width; 11 → locked final outputs; 12 → contextual return; 13 → shared card/layout consistency; 14 → batch creation-date filter; 15 → redundant hints plus calendar choice; 16 → navigation and SuperAdmin access.
- Related completed work is historical context, not outstanding dependencies: the QA v3 parent spec is #115; its processing-wizard, layout, date and period-filter tickets established the behavior corrected here.
