# QA v3: opravy dokladů, zdaňovací období a desktopový pracovní tok

**Stav:** QA nálezy strukturované pro navazující specifikaci
**Původ:** ruční QA aplikace po změnách QA v1 a QA v2
**Návaznost:** navazuje na QA v1 a QA v2; zachovává platformně řízené AI a ochranu uzamčených období

## Problem Statement

Kontrola dokladů obsahuje zbytečné překážky. Rozdíl mezi celkovou částkou s DPH a součtem základu a DPH je blokující i tehdy, když může jít o zaokrouhlení. Schválený doklad nelze snadno opravit, takže omylem potvrzená chyba vede do slepé uličky.

Přiřazení do zdaňovacího období není dostatečně srozumitelné. Nárok na odpočet má standardně vycházet z DUZP, přesun do jiného období i filtry mají používat výběr existujících období. Editovatelné datum přijetí tuto volbu komplikuje. Chybí také jasná možnost vytvořit další nebo historická období, celý rok či více let.

Nahrání souborů, sekce Zpracování v DPH a historie exportů vyžadují zpřehlednění. Upload obsahuje špatně zarovnanou kartu a nadbytečné ovládání směru. Dávku nelze pohodlně smazat a návštěva jejího detailu po dokončení není propojena s přečtením notifikace. V historii exportů se údaje podání překrývají s popisky.

Část rozhraní nevyužívá desktopovou plochu. Některé karty působí jako mobilní layout roztažený na počítač, zejména AI konfigurace. Administrační dropdown je příliš dlouhý a vyžaduje rolování. Formáty dat nejsou jednotné. Využití AI potřebuje filtry, souhrny a případně cenu volání, pokud ji poskytovatel skutečně vrací.

## Solution

Zjednodušit kontrolu a opravy dokladů: rozdíl součtů zobrazovat jako varování a umožnit opravu omylem schváleného dokladu mimo uzamčené období. Výchozí období určit podle DUZP a případný přesun nároku na odpočet řešit výběrem období. Datum importu ponechat pouze jako informaci.

Zpřístupnit vytváření dalších i historických období a sjednotit výběry období i zobrazení dat. Nahrání souborů zjednodušit, automatické určení směru vysvětlit bez přepínače při importu a doplnit smazání dávky s ochranou uzamčených období. Zpracování v DPH a historii exportů upravit tak, aby byly stav, další krok i údaje podání čitelné.

Rozhraní navrhovat primárně pro práci na počítači. Upravit administrační navigaci a rozložení karet, zachovat použitelnou mobilní variantu a akci Vyfotit doklad zobrazovat pouze na mobilu. Platformní Využití AI doplnit o filtry a souhrny odpovídající zvolenému výběru; cenu uvádět pouze při dostupnosti skutečných údajů.

## User Stories

1. As a User, I want a mismatch between the total including VAT and the sum of the taxable base and VAT to appear as a warning, so that rounding does not prevent approval.
2. As a User, I want to correct an accidentally approved Document outside a Period Lock, so that approval does not leave an error impossible to fix.
3. As a User, I want the default Reporting Period to follow the Tax Point Date, a Deferred Claim and period filters to use dropdowns, and the Import Date to remain read-only, so that period assignment is explicit and predictable.
4. As a Company Administrator, I want to generate future and historical Reporting Periods, including a whole year or multiple years, so that I can work beyond the initially generated year.
5. As a User, I want dates displayed consistently as day, month and four-digit year, so that I can read them without ambiguity.
6. As a User, I want a simple, aligned file-upload surface with the camera action shown only on mobile, so that uploading is straightforward on my device.
7. As a User, I want Direction determined automatically from Company identity without an import-time selector, so that I do not have to configure it for each upload.
8. As a User, I want to delete an Upload Batch unless it contains a Document in a locked Reporting Period, so that I can remove an unwanted batch while respecting finalized data.
9. As a User, I want a clear and simple VAT processing workflow, so that I understand the current state and the next action.
10. As a User, I want export history and resolved filing details displayed without overlapping labels, so that I can inspect the information used for an export.
11. As an Administrator, I want administration navigation that does not depend on a long downward dropdown, so that I can reach its destinations comfortably.
12. As a desktop User, I want Settings and AI Configuration layouts to use the available screen width, so that the primary working environment is efficient while mobile remains usable.
13. As a SuperAdmin, I want AI Usage filters, summaries for the selected data and call prices when returned by the provider, so that I can inspect platform usage.
14. As a User, I want opening a completed Upload Batch's detail to allow its notification to be marked as read, so that notification state reflects the work I have inspected.

## Implementation Decisions

- A mismatch between the total including VAT and the sum of the taxable base and VAT is a warning rather than a blocker. It remains visible during review.
- An Approved Document must have a correction path outside a Period Lock. The existing Return to Review concept provides the domain baseline; finalized periods retain their protection.
- The Tax Point Date determines the default Reporting Period. A Deferred Claim is selected from available Reporting Periods rather than entered as free text. Period filters also use dropdowns.
- The Import Date is informational, read-only and does not determine the Reporting Period. A separate editable receipt date is not required by this workflow.
- Period generation must support additional and historical periods, whole years and multiple years. The existing Reporting Year model and the Company's monthly or quarterly filing frequency remain the baseline.
- User-visible dates use the requested Czech display convention `dd / mm / rrrr`. Storage and machine-readable export formats are not presentation formats.
- The upload surface focuses on file selection and uploading with consistent alignment. The explicit Vyfotit doklad action is mobile-only.
- Automatic Direction determination from Company identity is presented as explanatory UI rather than an import-time setting. The User cannot change it during upload.
- An Upload Batch can be deleted unless one of its Source Files contains a Document assigned to a locked Reporting Period. The lock check protects the entire batch deletion.
- The VAT processing section requires a redesign of its workflow and actions, with a clear current state and next step. Its detailed interaction design remains to be specified.
- Export history must display filing details and their labels without overlap, with a readable hierarchy on desktop and mobile.
- The long administration dropdown is replaced with another navigation pattern. Settings and AI Configuration layouts use available desktop width while retaining a usable mobile presentation.
- Platform AI Usage gains filters and summaries corresponding to the selected data. A call price is displayed if the provider response actually supplies it; an estimated price must not be presented as a returned price.
- Opening the detail of a completed Upload Batch supports marking the corresponding notification as read. Whether this happens automatically or through an explicit action remains to be specified.

## Testing Decisions

- Extend application-service tests to prove that a total mismatch remains visible as a warning and does not by itself block approval.
- Cover correction of an Approved Document outside a Period Lock and refusal to change a Document in a locked Reporting Period.
- Verify default period assignment from the Tax Point Date, Deferred Claim selection and the informational-only Import Date.
- Cover generation of future and historical periods, whole years and multiple years, including monthly and quarterly Companies.
- Cover deletion of an eligible Upload Batch and refusal to delete a batch containing a Document in a locked Reporting Period.
- Extend browser coverage for period dropdowns and filters, the simplified upload flow, the absence of an import-time Direction selector and the mobile-only camera action.
- Verify the redesigned VAT processing flow, export-history readability and administration navigation through representative user journeys once the interaction details are defined.
- Use focused desktop and mobile visual checks for Settings, AI Configurations, upload alignment, date display and export filing details, including longer values that previously overlapped labels.
- Verify AI Usage filtering and summaries against the same selected dataset. Cover provider responses with and without a returned call price.
- Verify that marking a completed batch notification as read affects the corresponding notification for the current User and Company.
- Prefer externally observable domain and user behavior over assertions about component structure, CSS classes or internal implementation details.

## Out of Scope

- Editing or deleting Documents inside a locked Reporting Period without the existing unlock workflow.
- Company- or Organization-managed AI credentials, provider selection or usage pricing; platform ownership from QA v2 remains in effect.
- Invented provider prices when the API response does not contain a price. A separately estimated pricing model is not specified here.
- Changes to machine-readable date formats in stored data or tax-authority exports solely to match the UI display convention.

## Further Notes

### Traceability

The fourteen User Stories retain the order of the fourteen original QA findings. The document organizes those findings; it does not imply that the changes have been implemented or verified.

Canonical terminology is defined in the root [glossary](../GLOSSARY.md), especially Return to Review, Tax Point Date, Import Date, Deferred Claim, Reporting Year and Period Lock. Existing decisions about [period assignment](adr/0012-reporting-period-follows-tax-point-date.md) and [Reporting Year generation](adr/0013-reporting-years-are-generated.md) provide the baseline for the related changes.

### Details to resolve before implementation

- Define the target VAT processing screens, action order and presentation of readiness, saved reports, finalization and exports.
- Choose the replacement administration navigation and the desktop layout for Settings and AI Configurations.
- Confirm whether individual historical months are generated independently or through their Reporting Year, consistent with the current domain model.
- Define the permissions, confirmation and treatment of related processing and export records when deleting an Upload Batch.
- Choose the AI Usage filter dimensions and summaries, and confirm which supported provider responses contain an actual call price.
- Decide whether visiting a completed batch detail marks its notification as read automatically or offers an explicit action.
