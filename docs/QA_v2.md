# QA v2: sjednocení aplikace a platformně řízené AI

**Navazující backlog triage 12. 11. 2026:** [potvrzené Q26–Q40 a další Q41–Q49](qa-remaining-triage.md) upřesňují dnešní stav odkladů níže. Původní specifikace a její historická hranice zůstávají zachované.

**Stav:** dodáno do `main` v [PR #114](https://github.com/Thomisso/iVAT/pull/114) dne 29. 10. 2026; [#91](https://github.com/Thomisso/iVAT/issues/91) je uzavřené. Níže zůstává schválená specifikace této etapy.
**Datum rozhodnutí:** 29. října 2026
**Původ:** ruční QA současného MVP a navazující produktové grilování
**Návaznost:** tato specifikace nahrazuje části QA v1 a requirements v0.2, které předpokládají Organization BYOK nebo Organization AI Settings

## Problem Statement

Uživatel dnes prochází vizuálně i informačně nesourodou aplikací. Company, Organization, Platform Administration a přihlašovací obrazovky používají odlišné shelly, layouty, gridy a někdy i rozdílný barevný režim. Důležité počty a stavy nejsou vždy proklikávací, Settings míchá nesouvisející oblasti na jedné dlouhé stránce, notifikace zabírají obsahovou plochu a finalizace VAT Reportu opakuje potvrzovací informaci.

Ruční QA současně odhalilo tři provozní chyby. Kvartální XML artefakt VAT Return nelze uložit kvůli databázovému constraintu přijímajícímu pouze měsíční Reporting Period. Nově nahraný Document se po Extraction data spadajícího do locked Reporting Period může zaseknout v `processing`. Pozvánka může obsahovat neplatnou callback URL a nový User nemá funkční cestu k nastavení hesla a přijetí Membership.

Stávající AI model navíc neodpovídá požadovanému produktu. Organization Administrators mohou spravovat BYOK, zatímco novým cílem je provozovat AI jako platformní know-how. SuperAdmin musí vlastnit AI Configurations, přidělovat je Companies, řídit celoživotní AI Processing Allowance a vidět všechny provozní stavy vyžadující zásah. Company Administrators potřebují pouze informaci o čerpání a čekajících Documents; Users nesmějí vidět provider, model ani credential.

## Solution

Aplikace bude používat jeden světlý vizuální systém odvozený od Company shellu. Company, Organization a Platform Administration budou měnit obsah navigace podle aktivního kontextu, nikoli celou vizuální identitu. Login převezme stejné tokeny a značku bez navigace přihlášené aplikace. Obrazovky budou sdílet společný grid, hlavičky, zarovnání a responzivní chování. Company Settings se rozdělí do samostatných rout se sekundárním menu.

Izolované chyby budou opraveny samostatně: databáze přijme měsíční i kvartální Reporting Period artefaktu; Extraction nového Documentu se zachová i tehdy, když jeho datum ukazuje na locked Reporting Period, ale schválení nebo přiřazení do zamčeného období zůstane blokované; pozvánka poskytne bezpečný jednorázový onboarding s nastavením hesla pro nového Usera a přihlášením existujícího Usera.

AI se převede na platformně vlastněné, pojmenované AI Configurations. Jedna konfigurace obsahuje provider credential a modely pro Split a Extraction a může být přiřazena jedné nebo více Companies. Nová Company dostane výchozí konfiguraci, zapnuté AI a lifetime allowance 50 úspěšných Extractions. SuperAdmin může přiřazení, limit nebo neomezený režim měnit. Vyčerpaná allowance a platformní konfigurační problémy povedou k explicitnímu čekajícímu stavu, nikoli k nekonečným retry nebo skrytému `processing`.

Platform Administration dostane operační dashboard, který seskupí aktivní problémy podle kořenové příčiny, AI Configuration a Company, nabídne přímé nápravné akce a zachová zásahy v Audit Logu. Company notifikace a platformní provozní upozornění zůstanou oddělené podle aktivního kontextu.

## User Stories

1. As a User, I want every Company screen to use the same visual language, so that I can focus on my work instead of relearning each page.
2. As a User, I want the login screen to look like the application I am entering, so that the transition feels trustworthy and coherent.
3. As a User, I want the application to remain consistently light, so that individual screens do not unexpectedly turn dark because of my operating-system preference.
4. As a User, I want page headers, content edges and actions to align to one grid, so that the interface is predictable.
5. As a User, I want dense tables and workspaces to use available width without losing alignment, so that I can inspect data efficiently.
6. As a User, I want responsive navigation and content on mobile, so that core workflows remain usable on a narrow screen.
7. As a keyboard User, I want context menus, notification panels and secondary navigation to be operable and visible with keyboard focus, so that I am not blocked by pointer-only controls.
8. As a Company Administrator, I want Company Settings split into clear sections, so that unrelated configuration is not mixed in one long form.
9. As a Company Administrator, I want separate Settings sections for Company details, VAT and reporting, Users, and data and deletion, so that I can find the correct task quickly.
10. As a Company Administrator, I want the setup checklist in Settings instead of Overview, so that the operational overview is not mixed with configuration.
11. As a User, I want Overview to contain operational information only, so that it tells me what needs attention now.
12. As a SuperAdmin, I want Platform Administration to use the same shell as the rest of the application, so that changing context does not feel like entering another product.
13. As an Organization Administrator, I want Organization administration to use the same shell and navigation principles, so that administrative levels remain understandable.
14. As a User, I want a clear active-context label, so that I know whether I am working in a Company, Organization or Platform context.
15. As a User, I want notifications behind a bell for the current Company, so that completed uploads do not permanently occupy the main content area.
16. As a User, I want the bell to display the current Company's unread count, so that I can see whether attention is required.
17. As a User, I want to mark every notification in the current Company as read, so that I can clear acknowledged updates efficiently.
18. As a User, I want to dismiss every notification in the current Company, so that obsolete messages no longer clutter my inbox.
19. As a mobile User, I want the notification panel to use the whole screen, so that it remains readable and operable.
20. As a User, I want blocker and warning counts to represent unique Documents, so that one Document with several findings is not mistaken for several Documents.
21. As a User, I want blocker and warning counts to open a prefiltered Documents workspace, so that I can act on the affected Documents immediately.
22. As a User, I want the rejected count to open rejected Documents, so that I can inspect them without implying that rejection itself must be resolved.
23. As a Company Administrator, I want the finalization explanation, confirmation checkbox and action next to each other, so that I make one clear decision instead of reading duplicated instructions.
24. As a User, I want a Control Statement PDF preview consistent with the VAT Return preview, so that both report outputs can be reviewed in the same way.
25. As a Company Administrator, I want to export all Company data without beginning Company deletion, so that export is useful as an independent administrative action.
26. As a Company Administrator, I want the existing complete ZIP archive reused for standalone export, so that export and pre-deletion protection do not diverge.
27. As a Company Administrator, I want quarterly VAT Return XML to download successfully, so that quarterly Companies can complete their reporting workflow.
28. As a Company Administrator, I want persisted monthly and quarterly EPO XML artifacts to obey the same Reporting Period rules as VAT Reports, so that artifact storage cannot reject a valid report.
29. As a User, I want a newly uploaded Document to finish Extraction even when its date indicates a locked Reporting Period, so that it does not remain stuck in processing.
30. As a User, I want such a Document to enter review with a Period Lock warning, so that I understand why it cannot yet be approved or assigned.
31. As a Company Administrator, I want approval and assignment into a locked Reporting Period to remain blocked, so that finalized VAT Reports are not changed accidentally.
32. As a new invited User, I want the invitation link to let me set a password, so that I can create usable credentials without receiving a password from an Administrator.
33. As a new invited User, I want successful password setup to authenticate me, accept the Membership and continue into the target Company, so that onboarding is one coherent flow.
34. As an existing User, I want an invitation to ask for my existing credentials instead of replacing my password, so that joining another Company does not alter my account.
35. As an invited User, I want invalid, used and expired links to explain the problem safely, so that I know an Administrator must send another invitation.
36. As a SuperAdmin, I want to create a named AI Configuration containing a provider credential and the Split and Extraction models, so that AI behavior is controlled by the platform.
37. As a SuperAdmin, I want to assign one AI Configuration to several Companies, so that a shared credential is stored once.
38. As a SuperAdmin, I want to assign a configuration to only one Company, so that a dedicated credential is supported without a second configuration model.
39. As a SuperAdmin, I want one AI Configuration to be the default for new Companies, so that AI processing works without Company-side setup.
40. As a SuperAdmin, I want every new Company to receive an allowance of 50 successful Extractions by default, so that platform usage is bounded from the start.
41. As a SuperAdmin, I want to change a Company's allowance or make it unlimited, so that commercial exceptions can be handled centrally.
42. As a SuperAdmin, I want allowance to be a lifetime total without automatic reset, so that granted processing is explicit.
43. As a Company Administrator, I want to see successful Extractions used against the Company's allowance, so that I know how much capacity remains.
44. As a Company Administrator, I want to see how many Documents wait for allowance, so that a processing delay is understandable.
45. As a User, I want Split, failed attempts and technical retries not to consume the allowance, so that I am charged only for successful Extractions.
46. As a SuperAdmin, I want a successful repeated Extraction to consume another allowance unit, so that repeated AI work is counted.
47. As a User, I want a multi-Document Source File processed in page order until the remaining allowance is exhausted, so that available capacity produces useful results deterministically.
48. As a User, I want remaining Documents to wait visibly when allowance runs out, so that they do not become failed or remain indefinitely in processing.
49. As a User, I want waiting Documents requeued automatically when the allowance increases, so that no manual per-Document recovery is required.
50. As a User, I want an exact allowance-exhausted message telling me to contact the SuperAdmin, so that I know who can resolve the situation.
51. As a User, I want provider, model, credit and credential details hidden, so that platform know-how and secrets are not exposed.
52. As a SuperAdmin, I want technical provider and credential failures visible, so that I can identify the actual remediation.
53. As a SuperAdmin, I want transient provider outages retried automatically and terminal failures listed for manual retry, so that temporary and persistent failures are treated differently.
54. As a SuperAdmin, I want invalid credentials and insufficient provider credits to wait for platform intervention without useless retries, so that the queue does not churn.
55. As a SuperAdmin, I want a dashboard count of unresolved platform problems, so that I know when intervention is required.
56. As a SuperAdmin, I want Companies at or above 80% of allowance highlighted, so that I can intervene before processing stops.
57. As a SuperAdmin, I want problems grouped by root cause, AI Configuration and Company, so that one shared failure is not presented as hundreds of unrelated jobs.
58. As a SuperAdmin, I want a shared-configuration incident to list every affected Company, so that I understand its impact.
59. As a SuperAdmin, I want each dashboard problem to show its age and affected Document count, so that I can prioritize work.
60. As a SuperAdmin, I want to change allowance, assign or repair a configuration, resume waiting work and retry failed jobs from the dashboard, so that routine remediation does not require navigation across unrelated screens.
61. As a SuperAdmin, I want only a configuration label, provider and credential suffix shown, so that the full secret is never returned to the browser.
62. As a SuperAdmin, I want resolved conditions removed from the active dashboard automatically, so that it remains an actionable queue.
63. As an auditor, I want SuperAdmin remediation retained in the Audit Log, so that platform interventions remain attributable.
64. As a SuperAdmin, I want Platform alerts separated from Company notifications, so that operational incidents do not appear as Company workflow messages.
65. As an Organization Administrator, I want Organization BYOK and AI settings removed, so that the interface reflects platform ownership of AI.
66. As an Organization Administrator, I want Organization AI usage views removed, so that provider and cost information stays within Platform Administration.

## Implementation Decisions

- The work is delivered as a multi-ticket integration. Isolated defects do not wait for the design-system or AI-model migrations; UI tickets depend on the shared shell foundation, and allowance/dashboard tickets depend on the platform AI model.
- The current Company shell and design tokens are the canonical visual baseline. Auth, Organization and Platform contexts reuse that visual system with context-specific navigation.
- The current release supports light mode only. Automatic operating-system dark-mode adoption is removed until a complete dark theme is designed and tested.
- A shared layout grid defines page gutters, aligned headers and action areas. Forms and prose use a narrower measure; tables and workspaces may use a wider measure while preserving the same alignment anchors.
- Company Settings uses separate routes and a responsive secondary navigation. Its sections are Company details, VAT and reporting, Users, and data and deletion. AI configuration is absent.
- The Company setup checklist moves into the Settings landing page. Overview remains an operational surface.
- Company notifications are scoped to the currently active Company. The bell displays unread count and opens a panel; bulk read and bulk dismissal affect only that Company. Dismissal removes notifications from the User's inbox without rewriting unrelated audit data.
- Reporting readiness summary counts are unique-Document counts. Blockers and warnings navigate to a filtered Documents workspace; rejected Documents navigate to the rejected filter. Finding-level detail remains on the Document/report detail surface.
- The finalization Notice contains the confirmation explanation and checkbox immediately beside the finalization action. The same semantic confirmation is not repeated elsewhere.
- The Control Statement PDF is a readable preview of the saved report snapshot using the VAT Return PDF's visual conventions. It is not an imitation of the official tax-authority form.
- Company data export becomes a standalone Settings action and reuses the complete, independently verified ZIP archive already required before Company deletion.
- The artifact Reporting Period constraint accepts the same month and quarter formats as VAT Reports. Artifact persistence, not just in-memory XML serialization, is part of the contract.
- A newly uploaded Document is not considered part of a locked Reporting Period merely because its extracted date indicates that period. Extraction is preserved and the Document proceeds to review; approval and reporting assignment into the locked period remain blocked.
- Invitation links remain single-use and expire after seven days. A new invitee sets an eight-character-minimum password, receives an authenticated session, accepts the Membership and enters the target Company. An existing User authenticates with existing credentials before acceptance. Callback URLs must be allowlisted and generated as valid URLs rather than assembled by delimiter concatenation.
- AI Configuration is a platform-owned entity containing a display label, provider, encrypted credential, credential suffix, Split model and Extraction model. One configuration can be assigned to many Companies. A dedicated configuration is one with a single Company assignment.
- Exactly one usable AI Configuration can be selected as the default for new Companies. New Companies receive that assignment, enabled AI access and a finite allowance of 50 unless the SuperAdmin overrides it.
- Organization BYOK, Organization AI Settings and Organization AI Usage are removed. Company Administrators and Users cannot select providers, models, regions or credential sources.
- AI Processing Allowance is enforced per Company as a lifetime total. It counts successful AI-authored Extraction Versions, including a successful re-Extraction. Split, User-authored corrections, failed provider calls and technical retries do not consume it.
- Allowance enforcement is race-safe. Concurrent jobs cannot complete more successful Extractions than the finite allowance permits; a failed call cannot permanently consume a reserved unit.
- When a Split creates more Documents than remaining allowance, extraction proceeds in Source File page order until capacity is exhausted. Remaining Documents enter an explicit allowance-wait state. Raising the allowance or selecting unlimited processing automatically requeues the oldest waiting Documents.
- Waiting for allowance, a missing configuration, invalid credentials or provider-credit intervention is distinct from terminal processing failure. These conditions do not enter a wasteful retry loop. Transient provider failures use the existing retry policy and become terminal only after that budget is exhausted.
- The allowance-exhausted User message is: “Dosažen limit počtu zpracovaných dokladů, kontaktujte super administrátora.” Other User-facing AI failures remain platform-neutral. Provider, model, credential and credit details are SuperAdmin-only.
- Company Administrators receive a read-only successful-Extractions/allowance value and waiting-Document count. Users receive only per-processing status. SuperAdmin receives usage requests, tokens, allowance and wait data by AI Configuration and Company.
- Platform Administration evolves from a raw terminal-job list into an operational dashboard. It reports exhausted allowance, allowance at or above 80%, waiting Documents, missing/invalid configuration, provider-credit failure, repeated provider unavailability and terminal processing jobs.
- Dashboard incidents are derived from current authoritative state and grouped by root cause, AI Configuration and Company. Resolved state disappears automatically; a separate incident-history subsystem is not introduced.
- Dashboard remediation includes allowance changes, unlimited mode, configuration assignment/editing, resuming waiting work and retrying terminal jobs. Every privileged change is authorized by the database and recorded in the Audit Log.
- Platform navigation and the Platform-context bell show unresolved operational counts. Platform alerts do not enter the current-Company notification inbox. Email operational alerts are not part of this release.
- Full credentials are never returned after storage. SuperAdmin surfaces show only configuration label, provider and the last four credential characters.

## Testing Decisions

- Tests assert externally observable domain and user behavior rather than component structure, CSS class names, SQL implementation details or internal queue call counts.
- The primary domain seam is the existing database-backed application-service integration suite running against local Supabase. It covers RLS/role authority, Reporting Period constraints, Period Locks, invitation state, AI Configuration assignment, allowance accounting, waiting/requeue behavior, usage visibility, audit events and dashboard queries.
- The primary browser seam is the existing Playwright E2E suite. It covers new-User and existing-User invitations through local Auth and the rendered email link, context navigation, Settings routes, notification bulk actions, filtered readiness links, finalization confirmation, standalone Company export and SuperAdmin remediation.
- The invitation E2E must use the real local Auth redirect allowlist and email template. A fake mailer alone is insufficient because it cannot detect malformed callback links.
- Quarterly XML regression coverage persists and downloads a quarterly draft/final artifact. Serializer-only tests are retained for XML content, but do not substitute for persistence coverage.
- Locked Reporting Period coverage begins with a newly uploaded Source File, runs real Split/Extraction orchestration, observes review with a lock warning, and proves approval/assignment remains refused until unlock.
- Allowance tests cover zero, one, default 50, unlimited, concurrent final units, successful re-Extraction, failed calls, retries, multi-Document partial processing, deterministic page order and automatic oldest-first requeue after a limit increase.
- AI Configuration tests cover dedicated and shared assignments, default assignment for a new Company, secret masking, removal of Organization controls and visibility differences among User, Company Administrator and SuperAdmin.
- Dashboard tests create authoritative underlying conditions rather than inserting presentation rows. They prove grouping of a shared-configuration failure, 80% warning behavior, direct remediation, automatic disappearance after resolution and retained Audit Log events.
- Existing terminal processing job/retry integration tests are prior art for SuperAdmin recovery. Existing period-lock, processing, AI usage, organization AI, platform administration, Company deletion/export and final artifact suites are extended or replaced as their contracts change.
- Visual consistency is tested with a focused Playwright screenshot matrix for representative Auth, Company, Organization and Platform pages at desktop and mobile widths. The matrix verifies the shared shell/grid and absence of accidental dark-mode divergence, not pixel identity between semantically different screens.
- Accessibility checks cover landmarks, heading order, visible focus, menu/panel keyboard behavior, notification semantics, form labels and color-independent status communication.
- Control Statement PDF tests assert the rendered report content, period, Company identity, sections and totals. They do not compare it with an official-form layout.
- The integration branch receives the repository's full serial database suite, typecheck, lint, build and relevant E2E/runtime checks only after focused ticket tests and reviews have passed.

## Out of Scope

- Company- or Organization-managed provider credentials and BYOK. Safe Company Administrator key entry may return in a future design.
- An official-form visual replica of the Control Statement PDF.
- Dark mode.
- Email, SMS or external operational alerts for SuperAdmin.
- A standalone long-term incident-history system beyond the existing Audit Log.
- Changes to the accounting workflow that will be proposed only after the visual system is consistent.
- Corrective or supplementary VAT Returns and Control Statements.
- Submission of VAT Reports to the tax authority.
- Billing or automatic purchasing of additional AI allowance.
- Provider/model/credential visibility for Company Administrators or Users.

## Further Notes

### Delivery order and proposed tickets

1. **Quarterly XML artifact regression** — correct the Reporting Period constraint and add persisted-artifact coverage. Independent.
2. **Invitation password onboarding** — repair callback generation and implement new/existing User branches with real local-Auth E2E. Independent.
3. **Extraction across a Period Lock** — preserve Extraction, expose the warning and retain approval/assignment enforcement. Independent.
4. **Shared light shell and layout grid** — establish the canonical shell, context navigation, light-only behavior and responsive grid. Blocks tickets 5–8.
5. **Auth, Organization and Platform shell migration** — move remaining contexts to the shared system. Blocked by ticket 4.
6. **Company Settings information architecture and standalone export** — split routes, move setup, remove Company AI controls and expose export. Blocked by tickets 4 and 9.
7. **Actionable readiness and finalization UX** — unique-Document links and consolidated confirmation. Blocked by ticket 4.
8. **Current-Company notification center** — bell, unread badge, panel and bulk actions. Blocked by ticket 4.
9. **Platform AI Configurations and BYOK removal** — schema, SuperAdmin management, assignments, defaults, secrets and role visibility. Blocks tickets 10–12.
10. **Lifetime AI Processing Allowance** — race-safe accounting, unlimited mode, partial multi-Document processing and waiting/requeue lifecycle. Blocked by ticket 9.
11. **AI error classification and role-scoped usage** — neutral User messages, Company Administrator allowance view and SuperAdmin technical detail. Blocked by tickets 9 and 10.
12. **SuperAdmin operational dashboard** — grouped incidents, thresholds, contextual counts, remediation and audit. Blocked by tickets 9–11.
13. **Control Statement PDF preview** — readable saved-snapshot PDF and download flow. Independent after report snapshot interfaces are confirmed unchanged.
14. **Combined visual, accessibility and workflow acceptance** — cross-context screenshot matrix and end-to-end verification after all child tickets merge.

Implementation follows the repository's multi-ticket integration workflow: each child ticket is reviewed against the coding standards and this specification before merge; the combined behavior receives a final spec review and full verification on the integration branch.

ADR-0006 is superseded by ADR-0011. ADR-0007 is clarified for newly uploaded Documents whose extracted dates indicate a locked Reporting Period. Canonical vocabulary is defined in the root glossary, including AI Configuration and AI Processing Allowance.
