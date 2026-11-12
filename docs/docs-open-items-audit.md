# Otevřené a odložené body v dokumentaci

**Audit:** 12. 11. 2026. Rozsah: všech 58 Markdown dokumentů v `docs` na `main` (`ffcf4ec60c90a8a5aaa282695c696597e2b758d3`), text všech tří PDF předloh v `docs/PDF`, související aktuální issues/PR a již připravený záznam [QA v7 triage](qa-v7-triage.md).

**Závěr:** tři zadání #276–#278 nejsou úplným seznamem otevřené práce napříč dokumentací. Přímo v QA v7 navíc zůstávají odložené pokročilé statistiky protistran. Starší QA a požadavky obsahují širší backlog; reálný anonymizovaný golden set chybí. Část zdánlivě otevřených implementací je naopak už dodaná a pouze nesprávně popsaná jako pending.

Tento inventář nevytváří závazek implementovat všechny budoucí nápady. Rozlišuje potvrzené zadání, explicitní odklad, skutečnou mezeru v kvalitě či důkazech a historický text. Čtení kódu a uzavření issue samo neprokazuje všechny runtime/klientské akceptační scénáře.

## QA v7 po jednotlivých bodech

| Bod | Dodané / aktuálně schválené | Co skutečně zbývá |
| --- | --- | --- |
| 1 Zdrojové zvýraznění a Inspect | #239/#240 v PR #243; navazující PDF oprava #253 v PR #265 | Žádné další konkrétní implementační zadání z tohoto bodu nebylo nalezeno; klientské a vizuální důkazy mají samostatné hranice níže |
| 2 Adresář protistran | #231–#234 v PR #243: adresář, identita, základní hledání/filtry, správa a vazby na Documents | **Pokročilé statistiky, finanční přehledy a další analytické filtry jsou stále odložené a nespecifikované. Samostatný otevřený ticket nebyl nalezen.** |
| 4 Částečné uplatnění | #235/#236 v PR #243 | Širší daňové scénáře #221; úzký poměrný odpočet #275 je samostatné připravené zadání |
| 5 Správa uživatelů | Dosavadní sjednocení #192/#193 v PR #198 | #276: vlastní/poslední přístup, potvrzení, tabulka Users a Invitations |
| 6 Dashboard | Produktová rozhodnutí v nynějším rozhovoru potvrzená | #278 čeká na #277; nejde o celý cross-company/BI backlog |
| 7 Ergonomie revize | #228–#230 v PR #243 | Nová konkrétní funkční mezera v tomto auditu nezjištěna; klientské důkazy nepředstírat |
| 8 Automatické schválení | #241 v PR #243, podle ADR-0019, bez confidence prahu | Confidence výzkum/workflow je jiné odložené téma |
| 10 Společná příprava Extraction Version | #225, modul `extraction-preparation.ts`, PR #243 | Není otevřený refaktor čekající na návrh |
| 11 Společné rozhodování Split/Extract chyb | #226, modul `ai-processing-failures.ts`, PR #243 | Není otevřený refaktor čekající na návrh |
| 12 Společné načtení revize | #227, modul `document-review.ts`, PR #243 | Není otevřený refaktor čekající na návrh |

[QA v7](QA_v7.md) je v hlavní větvi stále ve starém stavu, dokud nebude sloučen dokumentační [PR #279](https://github.com/Thomisso/iVAT/pull/279). Tento audit a opravy patří do téhož PR. Produkční nasazení se z merge samotného neodvozuje.

## Schválená a dosud nedodaná zadání

| Issue | Stav k auditu | Rozsah |
| --- | --- | --- |
| [#158](https://github.com/Thomisso/iVAT/issues/158) | ready-for-agent | SuperAdmin založí Organization; první Administrator se přidá později. Veřejná registrace tím není schválená |
| [#275](https://github.com/Thomisso/iVAT/issues/275) | ready-for-agent | Poměrný odpočet drobných provozních výdajů se skutečným ručně zadaným poměrem |
| [#276](https://github.com/Thomisso/iVAT/issues/276) | ready-for-agent | Ochrana přístupu a tabulky uživatelů/pozvánek |
| [#277](https://github.com/Thomisso/iVAT/issues/277) | needs-triage, produkt rozhodnut | Oddělené měsíční KH; zbývá doložit pravidlo měsíce běžného přijatého vstupu uvnitř kvartálu |
| [#278](https://github.com/Thomisso/iVAT/issues/278) | ready-for-agent, nativní blocker #277 | Firemní dashboard a aktuální cyklus DPH |

Aktuální otevřený seznam obsahoval 18 produktových issues a jeden infrastrukturní registr #207. Kromě pěti výše jde o třináct backlog issues níže. Nové nepopsané budoucí nápady z dokumentace do tohoto čísla nepatří.

## Backlog s existujícími otevřenými issues

| Issue | Odložený rozsah |
| --- | --- |
| [#1](https://github.com/Thomisso/iVAT/issues/1) | Pevný kurz cizích měn |
| [#2](https://github.com/Thomisso/iVAT/issues/2) | Automatické párování Credit Notes s původním Document |
| [#3](https://github.com/Thomisso/iVAT/issues/3) | Souhrnné hlášení; vlastník jej v této triage výslovně odložil |
| [#4](https://github.com/Thomisso/iVAT/issues/4) | VIES |
| [#5](https://github.com/Thomisso/iVAT/issues/5) | Dovoz, vývoz, osvobozená plnění, krácení odpočtu |
| [#6](https://github.com/Thomisso/iVAT/issues/6) | Dodatečná/opravná přiznání a opravná/následná KH; vlastník je v této triage odložil |
| [#7](https://github.com/Thomisso/iVAT/issues/7) | Veřejné ingestion API; samo nepokrývá všechny ERP integrace |
| [#8](https://github.com/Thomisso/iVAT/issues/8) | Příjem dokladů e-mailem |
| [#9](https://github.com/Thomisso/iVAT/issues/9) | Apple/Microsoft přihlášení |
| [#10](https://github.com/Thomisso/iVAT/issues/10) | Samostatná OCR strategie, pokud si ji vyžádá kvalita/cena |
| [#11](https://github.com/Thomisso/iVAT/issues/11) | Položkové vytěžování |
| [#14](https://github.com/Thomisso/iVAT/issues/14) | Billing/subscriptions; automatické dokoupení allowance ještě nemá samostatnou specifikaci |
| [#221](https://github.com/Thomisso/iVAT/issues/221) | Odhady/korekce a majetek nad úzký #275, §76 a kombinace, částečný nárok a oddělená období RC/EU, částečné dobropisy; koordinace s #5/#2 |

Výchozí soupis je v [requirements v0.2, 15.4](agents/requirements.md) a v [revizi dokladů](document-review.md). Označení backlog není schválení úplné implementační specifikace.

## Další explicitní odklady bez samostatného otevřeného ticketu

U těchto témat nebyl v aktuálním otevřeném seznamu nalezen odpovídající samostatný ticket. Neznamená to, že existuje schválená dodávka nebo že je vhodné vytvořit jeden obří ticket pro celou skupinu.

| Téma | Zdroj a vymezení |
| --- | --- |
| **Pokročilé statistiky protistran** | [QA v7, bod 2](QA_v7.md), [revize dokladů, Adresář protistran](document-review.md). Základní adresář, filtry a seznam navázaných dokladů jsou dodané |
| Cross-company dashboard | [QA v1, oddíl 18](QA_v1.md); výslovně mimo aktuální #278 |
| Skládání více fotografií do jednoho vícestránkového Document | QA v1, oddíl 18; není totéž jako už podporované vícestránkové PDF |
| Ořez, perspektiva a hodnocení kvality fotografií | QA v1, oddíl 18; není totéž jako oprava souřadnic PDF #253 |
| Plně resumable/chunkovaný upload | QA v1, oddíl 18; stávající draft/retry/přetrvání fronty je užší schopnost |
| Podání přes zástupce / daňového poradce | QA v1, oddíl 18; současné exportní údaje podepisující osoby nejsou celý tento proces |
| Kalibrovaná nejistota/confidence a její výzkum | QA v1, oddíl 18; výzkum providerů/API a navazující workflow až po doložení korelace. Nejde o dodanou automatiku podle ADR-0019 |
| Bezpečné Company-managed AI credentials/BYOK | [QA v2, Out of Scope](QA_v2.md), [ADR-0011](adr/0011-platform-owns-ai-credentials-and-company-access.md); možné budoucí přehodnocení, dnešní vlastnictví zůstává platformové |
| Dark mode | QA v2, Out of Scope; dnešní světlý vzhled je záměrný |
| Externí provozní alerty SuperAdmina | QA v2, Out of Scope, ADR-0011; e-mail/SMS jsou odložené, in-app monitoring je dodaný |
| Samostatná dlouhodobá historie incidentů nad Audit Log | QA v2, Out of Scope; explicitně vyloučený rozsah, nikoli skrytý závazek |
| Budoucí veřejná registrace | [Google sign-in](google-sign-in.md); #158 byl převeden na SuperAdmin provisioning, takže už není jejím ticketem |

### Širší budoucí vize SRS

[Requirements, oddíly 2.4 a 11](agents/requirements.md), navíc uvádí následující dosud neschválená rozšíření. Nejde automaticky o neuzavřenou QA akceptaci:

- vlastní role a granular permissions; konfigurovatelné schvalovací řetězce/workflow;
- další AI provideři a processing strategie nad konkrétní OCR #10;
- další strukturované či nestrukturované vstupní formáty, zatím bez konkrétního kontraktu;
- ERP/účetní integrace a pokročilá správa integrací nad ingestion API #7;
- pokročilá klasifikace dokladů, automatické účetní zápisy a pokročilé daňové určení nad konkrétní režimy #5;
- DPH pro další země a další zákonné výkazy nad konkrétní souhrnné hlášení #3;
- automatické podání správci daně;
- širší BI/reporting/analytika nad firemní dashboard a statistiky protistran;
- automatické reconciliation/matching nad konkrétní párování dobropisů #2.

### Uzavřené nebo nahrazené odklady

- [#13 Self-hosted deployment](https://github.com/Thomisso/iVAT/issues/13) je **uzavřené jako wontfix**. Stará zmínka v requirements/MVP se nesmí automaticky oživit jako otevřený produktový ticket. Současný Compose pilot sám neznamená distribuovanou self-hosted produktovou variantu.
- [#12 Confidence-based automatic approval](https://github.com/Thomisso/iVAT/issues/12) je **uzavřené jako wontfix**. Dodané #241 má jiný potvrzený model bez confidence prahu; research kalibrace ve starém QA v1 je samostatná odložená myšlenka.
- Oficiální PDF formuláře a zdrojové zvýrazňování z historických Out of Scope seznamů později dodaly #211/PR #215 a #222/PR #243. Neotevírat je znovu jen podle starého odkladu.
- Historické odstranění objektů při publikaci [#268](https://github.com/Thomisso/iVAT/issues/268) vlastník výslovně uzavřel jako not planned: neposílal se požadavek GitHub Support a netvrdí se odstranění cache objektů. Repozitář je při aktuálním API readbacku PUBLIC. Runbook [publication](publication.md) není sám dnešní otevřená migrace.

## Konkrétní nedodělek kvality a mezery v důkazech

| Oblast | Co zbývá nebo jaká je přesná hranice |
| --- | --- |
| **Reálný anonymizovaný golden set / accuracy baseline** | [Historický MVP podklad](mvp.md), část Co je podmíněné, a [golden-set README](../evaluation/golden-set/README.md) výslovně říkají, že technické ukázky nejsou produktová baseline. Aktuální manifest obsahuje jen dvě ilustrativní blank cases. Harness #32 existuje; reálná reprezentativní sada a smysluplné měření přesnosti zatím nejsou dodané. Samostatný otevřený ticket nebyl nalezen |
| Měsíc ordinary incoming KH uvnitř kvartálu | #277 obsahuje konkrétní otevřenou faktickou bránu; produktová volba již potvrzená. Neřešit dotazem na uživatele, jaké je právo |
| Kalendářní hranice nároku §73 | [Stará lhůta](research/claim-deadline.md) a [nová year-end hranice](research/claim-deadline-new-yearend.md) zachovávají omezení síly výkladu. Implementace #224/#238 je dodaná; závěr o nepracovním konci je zdokumentovaná omezená inference, nikoli nově doložené výslovné rozhodnutí soudu nebo odborné potvrzení. Není to automatický důkaz nové vady |
| Klientské a vizuální chování revize | [Akceptační inventář](document-review-acceptance.md) výslovně neprokazuje HTTP/SSR testy hydrataci, fokus, zkratky, resize, Inspect rendering, vizuální správnost či přístupnost. Zachované browser testy jsou source inventory; dnešní procesy je nesmějí spouštět. Nedokládat je vymyšleným passing stavem, ani je zaměnit za nově zjištěnou chybu |
| Google a live-provider konfigurace | [Google runbook](google-sign-in.md) popisuje výchozí vypnutý provider a podmínky skutečné konfigurace. Kontrolované settings a lokální HTTP nejsou live Google OAuth proof. Ostatní kontraktní adaptéry mají podobně opt-in hranice; chybějící důkaz není automaticky chybějící adaptér |
| Roští DNS root cause | [QA v6, bod g](QA_v6.md) ponechává šetření resolveru nepotvrzené. Aplikační interní transport #195–#197/PR #198 je dodaný; jeho úspěch nevysvětluje externí příčinu. Bez nového oprávnění se nepíše podpoře |
| Doručitelnost iCloud | Závěrečné záznamy #169/#180 dokládají úspěšnou autentizaci a dokončení pozvánek/obnovy, ale historická iCloud klasifikace Junk nebyla vydávaná za vyřešené doručování do Inboxu. Není to důvod znovu otevřít celý dodaný SMTP tok |
| Skutečné CI úspory / náklady | [CI runbook](ci.md) a [audit 9. 11.](ci-workflow-audit-2026-11-09.md) odlišují pozorované runner intervals, zaokrouhlené odhady, skutečné faktury a srovnatelnost vstupů. Konkrétní aktuální finanční úsporu nelze vydat za ověřenou jen z lokálních policy testů nebo jednoho kratšího běhu |
| Automatické uzavírání issues a sledování | [Tracker runbook](agents/agent-tracking.md) má omezený setup readback a odlišuje skutečnou PR-caused closure. Chybějící podporovaný setting API není nový produktový požadavek ani opakovaný implementační gate. Historické nepozorování cron triggeru v krátkém acceptance okně není důkaz dnešní nefunkčnosti |
| Obnova bez záložního kódu či pokračovacího důkazu | [MFA recovery](mfa-recovery.md) vymezuje dostupné schopnosti a potřebu samostatného operator procesu pro případ mimo ně. V tomto auditu nebyl nalezen schválený nový postup; nezavádět z něj MFA bypass |
| Duplicitní ovládání úloh | [QA v6 implementační záznam](QA_v6_implementation.md) ponechává volitelnou údržbovou připomínku. Není to neuzavřený hard finding původní dodávky |

### Reálné release běhy už existují

Staré věty o chybějícím skutečném candidate execution v [CI](ci.md) a [deployment](deployment.md) nelze bez časového kontextu považovat za dnešní stav:

- [Release candidate verification 43019472638](https://github.com/Thomisso/iVAT/actions/runs/43019472638), 11. 11. 2026, head `ffcf4ec…`, je úspěšný. API jobs/steps potvrzuje tři aplikační shardy, společné kontroly, tracker/release kontroly, skutečné HTTP acceptance a build/boot/test/stop produkčního Docker runtime; nejde pouze o zelený přeskočený agregát.
- [Pre-main acceptance 43009802273](https://github.com/Thomisso/iVAT/actions/runs/43009802273), 11. 11. 2026, je také úspěšný a má skutečné full/runtime jobs.

Toto je read-only kontrola skutečného průběhu. Není novou validací každého artifact digestu, schválením budoucího kandidáta ani důkazem aktivace konkrétního release. Starší invalidované tracker receipts po přepisu historie se nepřenášejí na novou revizi. Nic se znovu nedispatchovalo ani nenasazovalo.

## Opravy dokumentačního driftu v PR 279

- QA v7 a společná revize se už nepopisují jako neticketizované/neimplementované, když #222/#223–#242 byly dodané. Zároveň je u adresáře výslovně oddělen odložený analytický rozsah.
- ADR-0012, ADR-0019 a ADR-0020 už netvrdí implementation pending; stav se váže na PR #243, právní hranice důkazů zůstávají zachované.
- `mvp.md` má výslovně historický rámec po QA v2, místo názvu slibujícího dnešní katalog. Jeho později překonané výroky o registraci, automatice nebo směru při uploadu nejsou novou implementační frontou.
- Google runbook neodkazuje na #158 jako budoucí veřejnou registraci; #158 už má jiné potvrzené zadání.
- Historická SRS v0.2, vizuální prototyp a CI/QA záznamy jsou čtené podle jejich data a pozdějších ADR/dodávek. Věty o nehotovém schématu či nepodporované automatice nejsou důvod duplikovat dodaný kontrakt a #241.

Nové nevybrané funkce z inventáře nedostaly automaticky ready-for-agent ani příslib implementace. Jejich prioritu a konkrétní rozsah je třeba rozhodnout při další triage. Nejkonkrétnější nově opomenuté položky jsou statistiky protistran a reálný golden set; ostatní odklady zůstávají viditelně evidované.

## Pokrytí dokumentů

Následuje úplný seznam vstupních souborů z hlavní větve. U Markdown dokumentů byly hledány a posouzeny explicitní otevřené body, scope, stavové a ověřovací oddíly. PDF byly kontrolované textově jako referenční formuláře, bez vizuální inspekce. Audit není nový funkční test všech popsaných schopností.

### Markdown 58 souborů

- [QA_v1.md](QA_v1.md)
- [QA_v2.md](QA_v2.md)
- [QA_v3.md](QA_v3.md)
- [QA_v4.md](QA_v4.md)
- [QA_v6.md](QA_v6.md)
- [QA_v6_implementation.md](QA_v6_implementation.md)
- [QA_v7.md](QA_v7.md)
- [adr/0001-organization-tenant-with-shared-postgres-rls.md](adr/0001-organization-tenant-with-shared-postgres-rls.md)
- [adr/0002-typescript-supabase-stack-local-first.md](adr/0002-typescript-supabase-stack-local-first.md)
- [adr/0003-ai-extracts-rules-engine-computes.md](adr/0003-ai-extracts-rules-engine-computes.md)
- [adr/0004-split-then-extract-with-multimodal-llms.md](adr/0004-split-then-extract-with-multimodal-llms.md)
- [adr/0005-immutable-extraction-versions.md](adr/0005-immutable-extraction-versions.md)
- [adr/0006-ai-credentials-and-data-sharing-consent.md](adr/0006-ai-credentials-and-data-sharing-consent.md)
- [adr/0007-finalization-locks-reporting-period.md](adr/0007-finalization-locks-reporting-period.md)
- [adr/0008-database-is-the-authority-for-access-and-roles.md](adr/0008-database-is-the-authority-for-access-and-roles.md)
- [adr/0009-audit-log-holds-no-personal-data-of-users.md](adr/0009-audit-log-holds-no-personal-data-of-users.md)
- [adr/0010-worker-acts-as-service-role-through-narrow-grants.md](adr/0010-worker-acts-as-service-role-through-narrow-grants.md)
- [adr/0011-platform-owns-ai-credentials-and-company-access.md](adr/0011-platform-owns-ai-credentials-and-company-access.md)
- [adr/0012-reporting-period-follows-tax-point-date.md](adr/0012-reporting-period-follows-tax-point-date.md)
- [adr/0013-reporting-years-are-generated.md](adr/0013-reporting-years-are-generated.md)
- [adr/0014-superadmin-has-platform-wide-tenant-access.md](adr/0014-superadmin-has-platform-wide-tenant-access.md)
- [adr/0015-documents-can-exist-without-source-files.md](adr/0015-documents-can-exist-without-source-files.md)
- [adr/0016-invitations-authorize-narrow-auth-administration.md](adr/0016-invitations-authorize-narrow-auth-administration.md)
- [adr/0017-internal-supabase-transport-preserves-public-identity.md](adr/0017-internal-supabase-transport-preserves-public-identity.md)
- [adr/0018-bank-account-checks-are-dated-observations.md](adr/0018-bank-account-checks-are-dated-observations.md)
- [adr/0019-optional-company-automatic-approval.md](adr/0019-optional-company-automatic-approval.md)
- [adr/0020-claim-eligibility-is-distinct-from-tax-point-period.md](adr/0020-claim-eligibility-is-distinct-from-tax-point-period.md)
- [agents/agent-tracking-acceptance.md](agents/agent-tracking-acceptance.md)
- [agents/agent-tracking.md](agents/agent-tracking.md)
- [agents/cli-processes.md](agents/cli-processes.md)
- [agents/domain.md](agents/domain.md)
- [agents/implementation-workflow.md](agents/implementation-workflow.md)
- [agents/issue-tracker.md](agents/issue-tracker.md)
- [agents/requirements.md](agents/requirements.md)
- [agents/triage-labels.md](agents/triage-labels.md)
- [ares-company-identity.md](ares-company-identity.md)
- [ares.md](ares.md)
- [branding.md](branding.md)
- [ci-workflow-audit-2026-11-09.md](ci-workflow-audit-2026-11-09.md)
- [ci.md](ci.md)
- [deployment.md](deployment.md)
- [deployments/2026-10-30-rosti-pilot.md](deployments/2026-10-30-rosti-pilot.md)
- [design/visual-direction.md](design/visual-direction.md)
- [document-review-acceptance.md](document-review-acceptance.md)
- [document-review.md](document-review.md)
- [epo-export-timing.md](epo-export-timing.md)
- [epo-export.md](epo-export.md)
- [extraction-payload.md](extraction-payload.md)
- [google-sign-in.md](google-sign-in.md)
- [manual-source-recovery.md](manual-source-recovery.md)
- [mfa-recovery.md](mfa-recovery.md)
- [mvp.md](mvp.md)
- [password-change.md](password-change.md)
- [publication.md](publication.md)
- [qa-v5-verification.md](qa-v5-verification.md)
- [research/claim-deadline-new-yearend.md](research/claim-deadline-new-yearend.md)
- [research/claim-deadline.md](research/claim-deadline.md)
- [vat-rules.md](vat-rules.md)

### PDF 3 předlohy

- [DPHDP3-XXXXXXXXXX-20261106-104851.pdf](PDF/DPHDP3-XXXXXXXXXX-20261106-104851.pdf)
- [DPHKH1-XXXXXXXXXX-20261106-104935.pdf](PDF/DPHKH1-XXXXXXXXXX-20261106-104935.pdf)
- [Vzorovy-formular-kontrolniho-hlaseni-DPH.pdf](PDF/Vzorovy-formular-kontrolniho-hlaseni-DPH.pdf)

Navíc byl porovnán nový [záznam potvrzené QA v7 triage](qa-v7-triage.md) z dokumentační větve.
