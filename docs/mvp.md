# iVAT: historický stav MVP po QA v2

Tento dokument zachovává stav po integraci specifikace QA v2 dne 29. října 2026. Není dnešním katalogem funkcí: veřejná registrace byla později uzavřena, review/source evidence a volitelné automatické schvalování dodaly další QA etapy. Aktuální rozlišení dodávek, backlogu a ověřovacích mezer je v [auditu dokumentace](docs-open-items-audit.md).

Původní podklad popisuje funkce doložené v repozitáři k uvedenému datu. Draft požadavků používá jen jako kontext; za implementovanou funkci považuje pouze to, co má oporu ve zdrojovém kódu, databázových migracích, aplikačních testech nebo end-to-end scénáři.

## Co MVP řeší

iVAT je víceuživatelská webová aplikace pro české plátce DPH a účetní kanceláře. Z nahraných zdrojových souborů vytváří strukturované doklady, nechává je projít lidskou kontrolou a z odsouhlasených dokladů sestavuje návrh přiznání k DPH a kontrolního hlášení. Aplikace podání **neodesílá** finanční správě; připravuje podklady a exporty. Hlavní lokální end-to-end scénář ověřuje cestu od registrace přes nahrání a schválení dokladu až po dohledatelný report, validní EPO XML, uzamčení období a export se soft-delete firmy ([README – Testing](../README.md#testing), [E2E acceptance test](../e2e/acceptance.spec.ts)).

## Hlavní uživatelský tok

1. Uživatel se zaregistruje, čímž vznikne organizace a jeho administrátorské členství, nebo se přihlásí e-mailem a heslem či přes Google ([auth.ts](../src/application/auth.ts), [sign-up testy](../tests/sign-up.test.ts)).
2. Administrátor založí firmu plátce DPH, případně si předvyplní její editovatelné údaje z ARES, a nastaví měsíční nebo čtvrtletní frekvenci podávání s historií účinnosti ([companies.ts](../src/application/companies.ts), [ares.ts](../src/application/ares.ts), [company testy](../tests/companies.test.ts)).
3. Uživatel nahraje jeden nebo více zdrojových souborů. Originál se uchová beze změny a asynchronní worker jej rozdělí na doklady a z každého vytěží strukturovaná data ([source-files.ts](../src/application/source-files.ts), [processing.ts](../src/application/processing.ts), [processing testy](../tests/processing.test.ts)).
4. Uživatel porovná vytěžená data s originálem, opraví je, vyřeší validační nálezy a doklad schválí nebo zamítne. Každá oprava vytváří novou neměnnou verzi extrakce ([document review page](../src/app/companies/%5BcompanyId%5D/documents/%5BdocumentId%5D/page.tsx), [review testy](../tests/review.test.ts)).
5. Pro zvolené měsíční nebo čtvrtletní období uživatel vytvoří uložený návrh DPH reportu, projde výpočty až na zdrojové doklady a stáhne kontrolní či formulářové výstupy. Administrátor může report finalizovat a období uzamknout ([VAT reports page](../src/app/companies/%5BcompanyId%5D/vat-reports/page.tsx), [VAT report testy](../tests/vat-reports.test.ts), [period-lock testy](../tests/period-lock.test.ts)).

## Implementovaná funkcionalita

### Organizace, firmy a přístup

- Multi-tenant model `Organization → Company → Membership` s rolemi SuperAdmin, Administrator a User. Organizace může spravovat více firem, uživatel může mít členství ve více firmách a databázové RLS izoluje data organizací i při přímém dotazu ([README – Tenancy, security and audit](../README.md#tenancy-security-and-audit), [tenant isolation testy](../tests/tenant-isolation.test.ts)).
- Pozvánky do organizace i firmy, volba role při pozvání, onboarding nového i existujícího účtu přes pozvánkový odkaz, změna role a odebrání členství ([memberships.ts](../src/application/memberships.ts), [membership testy](../tests/memberships.test.ts), [invitation E2E](../e2e/invitation-onboarding.spec.ts)).
- Přihlášení e-mailem/heslem a přes Google. Google vyžaduje konfiguraci Supabase a Google Cloud podle first-party návodu ([Google sign-in](google-sign-in.md), [auth.ts](../src/application/auth.ts)).
- TOTP MFA s QR/enrollment tokem, jednorázovými recovery kódy a možností odpojení. Administrátor organizace může MFA vynutit; SuperAdmin jej musí mít před přístupem k platformním funkcím ([mfa.ts](../src/application/mfa.ts), [MFA testy](../tests/mfa.test.ts)).
- Založení a editace firmy, validace identifikačních údajů, předvyplnění z ARES, měsíční i čtvrtletní frekvence podávání a její historie podle data účinnosti ([companies.ts](../src/application/companies.ts), [company testy](../tests/companies.test.ts), [quarterly report testy](../tests/vat-reports.test.ts)).
- Administrátorský export dat firmy do ZIP před jejím soft-delete. Firma poté zmizí z aktivního používání, zatímco retenční záznamy včetně schváleného dokladu a zámku období zůstávají zachované ([company-deletion.ts](../src/application/company-deletion.ts), [company deletion testy](../tests/company-deletion.test.ts), [E2E acceptance test](../e2e/acceptance.spec.ts)).

### Příjem a zpracování zdrojových souborů

- Ruční jednotlivý i dávkový upload PDF, PNG, JPEG, XLSX a XLS. Kontroluje se přípona, signatura obsahu, čitelnost, velikost a u PDF počet stran ([source-files.ts](../src/application/source-files.ts), [source file testy](../tests/source-files.test.ts), [upload batch testy](../tests/upload-batches.test.ts)).
- Výchozí limity jsou 20 MiB na soubor, 50 stran PDF a 100 souborů v dávce. SuperAdmin je může měnit; statický hard cap velikosti je 50 MiB ([upload batch migrace](../supabase/migrations/20261102100000_upload_batches.sql), [upload transport migrace](../supabase/migrations/20261107112000_platform_upload_transport.sql), [upload-policy.ts](../src/lib/upload-policy.ts)).
- Originál se ukládá beze změny, je dostupný pro náhled nebo stažení a nese metadata včetně SHA-256. Jeden soubor může obsahovat více dokladů; pro tabulky se pracuje s rozsahy řádků ([source-files.ts](../src/application/source-files.ts), [workbooks.ts](../src/application/workbooks.ts), [source file testy](../tests/source-files.test.ts)).
- Background pipeline `Split → Extract` běží přes pg-boss worker, má opakování po technické chybě a idempotentní zápis výsledků. Selhaný split lze zopakovat a doklad před konečným rozhodnutím znovu vytěžit jako další verzi ([README – Processing](../README.md#processing), [processing.ts](../src/application/processing.ts), [processing testy](../tests/processing.test.ts)).
- Uživatel může opravit hranice chybného rozdělení sloučením sousedních dokladů, rozdělením dokladu nebo přesunem hraniční stránky; dotčené doklady se znovu vytěží a historie zůstává zachována ([documents.ts](../src/application/documents.ts), [split-correction testy](../tests/split-correction.test.ts)).
- Nová firma dostane výchozí platformní AI konfiguraci, zapnutý přístup a doživotní allowance 50 úspěšných extrakcí. Konfigurace, modely, šifrované klíče, přiřazení a allowance spravuje pouze SuperAdmin; uživatelé firmy vidí neutrální stav allowance a čekajících dokladů. Implementované adaptéry jsou Anthropic a OpenAI, lokální vývoj má deterministického fake providera ([README – Getting started](../README.md#getting-started), [AI provider selection](../src/ai/index.ts), [AI configuration testy](../tests/ai-configurations.test.ts), [allowance testy](../tests/ai-processing-allowance.test.ts)).

### Vytěžení, validace a kontrola dokladů

- Extrakční schéma pokrývá typ dokladu, směr, číslo a data, měnu, dodavatele/odběratele, součty, rozpad podle sazeb DPH, režim DPH a údaje dobropisu. Neobsahuje řádkové položky ([Extraction payload](extraction-payload.md), [structured output schema](../src/ai/structured-output.ts)).
- Směr přijatý/vydaný se určuje porovnáním IČO/DIČ firmy se stranami dokladu; uživatel jej může předvolit už při uploadu nebo opravit při kontrole ([direction-detection.ts](../src/application/direction-detection.ts), [direction testy](../tests/direction-detection.test.ts)).
- Deterministické validace kontrolují aritmetiku, povolené sazby DPH k datu plnění, IČO a české DIČ, povinná pole režimů a vybrané podmínky kontrolního hlášení. ADIS kontrola přidává stav nespolehlivého plátce a zveřejněné bankovní účty, aniž by výpadek registru zablokoval celé zpracování ([document-validation.ts](../src/application/document-validation.ts), [validation testy](../tests/document-validation.test.ts), [VAT registry testy](../tests/vat-registry.test.ts)).
- Cizí měna se převádí na CZK denním kurzem ČNB pro datum uskutečnění zdanitelného plnění; ukládá se původní částka, kurz i jeho původ ([exchange-rates.ts](../src/application/exchange-rates.ts), [currency conversion testy](../tests/currency-conversion.test.ts)).
- Duplicate Warning upozorní na shodu DIČ protistrany + čísla dokladu + směru nebo na opakovaný hash souboru. Jde o upozornění, nikoli blokaci ([documents.ts](../src/application/documents.ts), [duplicate warning testy](../tests/duplicate-warnings.test.ts)).
- Review workspace zobrazuje relevantní část PDF nebo obrázek; u tabulek identifikuje zdrojový list a rozsah řádků bez obrazového náhledu. Dovoluje ruční korekce, uchovává neměnnou historii verzí, zobrazuje validační nálezy a umožňuje schválení či zamítnutí uživatelem i administrátorem. Do DPH reportu vstupuje pouze schválený doklad ([document review page](../src/app/companies/%5BcompanyId%5D/documents/%5BdocumentId%5D/page.tsx), [documents.ts](../src/application/documents.ts), [review testy](../tests/review.test.ts)).
- Seznam dokladů lze filtrovat podle stavu, směru, vykazovaného období, protistrany a přítomnosti nálezů. Každý doklad patří do vykazovaného období podle data uskutečnění zdanitelného plnění; datum importu se zobrazuje jen informativně. U přijatého dokladu lze nárok na odpočet odložit do pozdějšího období (Deferred Claim) ([documents.ts](../src/application/documents.ts), [review testy](../tests/review.test.ts)).

### DPH pravidla, reporty a exporty

- Deterministický rules engine podporuje česká domácí plnění, tuzemský reverse charge a pořízení zboží či služeb z EU. Umí dobropisy jako záporné částky. Nepodporovaný režim označí pro ruční klasifikaci a z reportu jej vyloučí ([VAT Rules Engine](vat-rules.md), [vat-rules.ts](../src/application/vat-rules.ts), [VAT rules testy](../tests/vat-rules.test.ts)).
- Report se generuje jako uložený snapshot pro platné měsíční nebo čtvrtletní období. Obsahuje přiznání DPHDP3, kontrolní hlášení DPHKH1, seznam vyloučených dokladů a drill-down z částek na zdrojové doklady ([vat-reports.ts](../src/application/vat-reports.ts), [VAT reports page](../src/app/companies/%5BcompanyId%5D/vat-reports/page.tsx), [VAT report testy](../tests/vat-reports.test.ts)).
- Dostupné výstupy jsou EPO XML pro DPHDP3 i DPHKH1 validované proti vendorizovaným oficiálním XSD, PDF náhled přiznání i kontrolního hlášení a samostatný XLSX přehled období se zvláštním listem pro doklady vyžadující pozornost ([EPO XML](epo-export.md), [epo-xml testy](../tests/epo-xml.test.ts), [VAT return PDF testy](../tests/vat-return-pdf.test.ts), [Control Statement PDF testy](../tests/control-statement-pdf.test.ts), [reporting-period Excel testy](../tests/reporting-period-excel.test.ts)).
- Administrátor může report finalizovat, čímž uzamkne období proti změnám dokladů a přegenerování reportu; může jej také odemknout. Snapshot finalizovaného reportu se nemění ([vat-reports.ts](../src/application/vat-reports.ts), [period-lock testy](../tests/period-lock.test.ts)).

### Provozní a administrátorské funkce

- Append-only audit log zapisovaný databází, čitelný administrátorem organizace, s filtrováním podle firmy, uživatele, akce a data. Aplikační uživatel jej nemůže přepisovat ani mazat ([README – Tenancy, security and audit](../README.md#tenancy-security-and-audit), [audit.ts](../src/application/audit.ts), [audit testy](../tests/audit.test.ts)).
- Měření AI požadavků a tokenů po firmě, AI konfiguraci, provideru a modelu; úplné provozní údaje vidí pouze SuperAdmin, zatímco administrátor firmy vidí allowance a počet čekajících dokladů. Fakturace součástí není ([ai-usage.ts](../src/application/ai-usage.ts), [AI usage testy](../tests/ai-usage.test.ts), [allowance testy](../tests/ai-processing-allowance.test.ts)).
- SuperAdmin konzole zobrazuje organizace a firmy, umožňuje organizaci zablokovat/odblokovat, měnit upload limity, spravovat výchozí a přiřazené AI konfigurace i allowance a řešit seskupené provozní problémy přímo na místě ([platform administration page](../src/app/platform/administration/page.tsx), [platform administration testy](../tests/platform-administration.test.ts), [AI configuration testy](../tests/ai-configurations.test.ts), [operational problem testy](../tests/operational-problems.test.ts)).
- UI je lokalizované do češtiny a angličtiny se stejnou sadou překladových klíčů ([messages/cs.json](../messages/cs.json), [messages/en.json](../messages/en.json), [message test](../tests/messages.test.ts)).

## Co je podmíněné nebo zatím neúplné

- Napojení na Google, ARES, ADIS, ČNB, Anthropic a OpenAI má implementované adaptéry a kontraktní testy, ale v konkrétním prostředí vyžaduje síť, konfiguraci a případně přístupové údaje. Výchozí lokální E2E proto používá fake AI a nevolá externí služby ([README – Testing](../README.md#testing), [ARES contract test](../tests/contract/ares.test.ts), [ADIS contract test](../tests/contract/adis-vat-registry.test.ts), [Anthropic contract test](../tests/contract/anthropic.test.ts), [OpenAI contract test](../tests/contract/openai.test.ts)).
- Existuje spustitelný evaluační harness pro přesnost Split/Extract podle providera a modelu, ale verzovaný golden set obsahuje pouze malé technické ukázky. Repozitář výslovně uvádí, že nejde o produktově kvalitní accuracy baseline a je potřeba doplnit anonymizované reálné vzorky ([Golden set README](../evaluation/golden-set/README.md), [extraction evaluation testy](../tests/extraction-evaluation.test.ts)).
- Repozitář dokládá lokální vývojový a testovací provoz. Produkční cloudové nasazení, jeho dostupnost a provozní parametry z tohoto kódu samy o sobě ověřit nelze ([README – Getting started](../README.md#getting-started), [SRS – Deployment](agents/requirements.md#12-open-questions-and-items-to-be-defined)).
- Daňová logika je implementovaná pro explicitně uvedené režimy a výstupy; tento dokument netvrdí úplnou legislativní pokrytost všech českých DPH situací. Samotný draft SRS připouští, že detailní validační pravidla se ještě specifikují ([SRS – Open Questions](agents/requirements.md#12-open-questions-and-items-to-be-defined), [VAT Rules Engine](vat-rules.md)).

## Mimo současné MVP

Podle explicitního vymezení v projektových požadavcích a podle absence odpovídajících implementovaných toků nejsou součástí současného MVP:

- veřejné API, příjem dokladů e-mailem a ERP/účetní integrace;
- Apple a Microsoft přihlášení;
- samostatný OCR engine, řádkové položky dokladů a automatické schvalování;
- VIES, souhrnné hlášení, dovoz, vývoz, osvobozená plnění, koeficient odpočtu a dodatečná přiznání;
- automatické párování dobropisů;
- automatické odeslání podání finanční správě;
- billing, pokročilé vlastní role a workflow schvalovacích řetězců;
- self-hosted produkční varianta.

Zdroj vymezení: [SRS – Not in MVP](agents/requirements.md#154-not-in-mvp-see-backlog) a [SRS – Future Enhancements](agents/requirements.md#11-future-enhancements).
