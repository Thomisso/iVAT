# QA v7: otevřené funkce a technická zlepšení

**Datum založení:** 6. 11. 2026
**Stav k 12. 11. 2026:** body 1, 2, 4, 7, 8 a 10–12 jsou dodané do `main` v [PR #243](https://github.com/Thomisso/iVAT/pull/243) ze dne 8. 11. 2026; #222 a jeho implementační tickety jsou uzavřené. Navazující oprava zvýraznění PDF #253 byla dodaná v [PR #265](https://github.com/Thomisso/iVAT/pull/265) dne 10. 11. 2026.
**Zbývající dodávka:** bod 5 → [#276](https://github.com/Thomisso/iVAT/issues/276), bod 6 → [#278](https://github.com/Thomisso/iVAT/issues/278) se závislostí na [#277](https://github.com/Thomisso/iVAT/issues/277). Produktový rozhovor Q1–Q14 včetně upřesnění Q8a–Q8c je uzavřený; [potvrzená navazující zadání](qa-v7-triage.md) uvádějí rozhodnutí, akceptaci i zbývající daňovou ověřovací bránu #277.
**Hranice stavu:** dokončený merge není potvrzením produkčního nasazení. Tato aktualizace nezavádí nové runtime ani vizuální důkazy. Původní číslování QA v6 je zachované; body 3 a 9 a Bugs / Improvements a–g zůstávají dokončené v [QA v6](QA_v6.md).

## Features

### 1. Zvýraznění vytěžených informací přímo v PDF

**Stav:** hotovo v [PR #243](https://github.com/Thomisso/iVAT/pull/243), tickety #239/#240; navazující oprava #253 v PR #265.

**Specifikace:** [revize dokladů](document-review.md), včetně obrázků, Excelu a volitelného Inspect.

- Vytěžené informace zvýraznit přímo v PDF moderním žlutým zvýrazněním.
- Model musí spolu s vytěženými údaji vracet jejich polohu v dokumentu, tedy místo, kde je identifikoval.
- Výběr pole nebo zvýrazněného místa propojí formulář s předlohou. Přiblížený detail se zobrazuje pouze při zapnutém režimu Inspect s lupou podle společné specifikace.

### 2. Adresář dodavatelů a odběratelů

**Stav:** hotovo v [PR #243](https://github.com/Thomisso/iVAT/pull/243), tickety #231–#234.

**Specifikace:** [revize dokladů](document-review.md). Adresář je per Company; pokročilé statistiky zůstávají budoucím rozšířením.

- Vytvořit adresář dodavatelů a odběratelů.
- Vytěžené informace propojit s odpovídajícím dodavatelem nebo odběratelem v adresáři.
- Do budoucna nad adresářem umožnit statistiky, přehledy a filtry; jejich konkrétní rozsah zatím není určen.

### 4. Uplatnění pouze části dokladu

**Stav:** hotovo v [PR #243](https://github.com/Thomisso/iVAT/pull/243), tickety #235/#236.

**Specifikace:** [revize dokladů](document-review.md). Ruční částky po sazbách pro vybraná samostatná plnění běžného tuzemského přijatého dokladu. Rozšířené daňové scénáře pokračují v [#221](https://github.com/Thomisso/iVAT/issues/221); úzký poměrný odpočet provozních výdajů má samostatné zadání [#275](https://github.com/Thomisso/iVAT/issues/275).

- Umožnit ke zpracování a do přiznání zahrnout pouze část dokladu, respektive část jeho částky.
- Příklad: faktura obsahuje několik položek, ale k uplatnění je určena pouze část faktury.
- Způsob zadání, neuplatněný zbytek a zachování součtových kontrol stanoví společná specifikace.

### 5. Přehlednější správa uživatelů a ochrana před odebráním vlastního přístupu

**Stav:** původní jednotná správa dodána v [PR #198](https://github.com/Thomisso/iVAT/pull/198), tickety #192/#193. Zbývající ochrany a tabulka mají potvrzené zadání [#276](https://github.com/Thomisso/iVAT/issues/276), `ready-for-agent`; implementace této části nezačala.

**Potvrzená zbývající dodávka:**

- Zakázat odebrání vlastní Membership a vlastní snížení role; chránit posledního scoped Administratora při respektování zděděné správy a počáteční prázdné Organization podle #158.
- Seznam karet nahradit tabulkou s jedním řádkem na Usera, hledáním podle e-mailu a rozbalitelnými Memberships; pozvánky zobrazit samostatně.
- Existující akce „Změnit roli“ a „Odebrat přístup“ začlenit přímo do gridu a zachovat jejich konkrétní rozsah i dosavadní oprávnění.

### 6. Dashboard s důležitými informacemi

**Stav:** produktová triage dokončená; potvrzené zadání [#278](https://github.com/Thomisso/iVAT/issues/278), `ready-for-agent` s blockerem #277. Implementace nezačala.

- Firemní dashboard: Vyžaduje pozornost, Právě probíhá a aktuální cyklus DPH; akční počty a odkazy podle [potvrzených pravidel](qa-v7-triage.md).
- Hlavní DPH období je předchozí nedokončené, poté aktuální rozpracované; po lhůtě zůstane předchozí s označením Po termínu, starší resty zvlášť. Měsíční i čtvrtletní frekvence, reálný kalendář lhůt.
- Přiznání a KH čtvrtletní právnické osoby mají oddělené cykly a dokončení. Potřebnou podporu měsíčního KH přidává #277; jeho produktový rozsah je potvrzený, daňové pravidlo volby měsíce běžného vstupu uvnitř kvartálu ještě vyžaduje ověření před `ready-for-agent`.
- Schválené doklady s pouhým upozorněním jsou vedlejší informace. Počty nezdvojovat; Source Files nejsou Documents. Obnovení po přibližně 30 sekundách pouze na viditelné stránce, čas posledního úspěchu a pravdivý stav při výpadku.

### 7. Ergonomičtější revize dokladů

**Stav:** hotovo v [PR #243](https://github.com/Thomisso/iVAT/pull/243), tickety #228–#230.

**Specifikace:** [společná specifikace revize dokladů](document-review.md), včetně Q1–Q42 a celého dokumentu schválená uživatelem dne 6. 11. 2026. Zahrnuje také kontextovou nápovědu klávesových zkratek vedle notifikací a opravu pravidel uplatnění.

- Sekci revize dokladů upravit tak, aby byla uživatelsky přívětivější.
- Reorganizovat tlačítka a jako hlavní akce zdůraznit „Schválit“ a „Zamítnout“.
- Zlepšit ergonomii polí a jejich vyplňování.
- Zachovat split view pro souběžné zobrazení dokumentu a jeho údajů.

### 8. Volitelné automatické schvalování bezproblémových dokladů

**Stav:** hotovo v [PR #243](https://github.com/Thomisso/iVAT/pull/243), tickety #241.

**Specifikace:** [revize dokladů](document-review.md) a ADR-0019; opt-in bez AI confidence prahu.

- Do nastavení firmy přidat volbu „Automaticky schválit doklady, které nevyžadují pozornost“.
- Pokud je volba pro firmu zapnutá, doklady vyhodnocené jako bezproblémové automaticky schválit.
- Doklad bez potřeby pozornosti splňuje všechny podmínky společné specifikace, včetně nulových chyb a upozornění, žádné nalezené duplicity a způsobilého období.

### 10. Společná příprava verzí vytěžení (Extraction Version)

**Stav:** hotovo v [PR #243](https://github.com/Thomisso/iVAT/pull/243), tickety #225.

**Specifikace:** [revize dokladů](document-review.md), podpůrná změna pro shodné výsledky všech vstupních cest.

**Doplněno:** 6. 11. 2026 na základě architektonické revize. **Doporučení:** silné; realizovat jako první z bodů 10–12. Původní návrh byl zahrnut do #222 a dodán v #225; níže zůstává odůvodnění a výchozí stav.

- Ruční vytvoření dokladu, oprava uživatelem a AI vytěžení dnes samostatně skládají převod měny podle ČNB, deterministickou validaci, zjištění z registru plátců DPH a výsledný seznam nálezů.
- Soustředit společnou posloupnost do jednoho modulu s malým rozhraním, které skryje pořadí operací a skládání výsledků. Zachovat existující moduly převodu a validace i skutečné a testovací adaptéry ČNB a registru.
- Zachovat rozdíly vstupních cest: validaci neúplného ručního konceptu a odstranění AI confidence při ručním zápisu, automatické určení směru pouze při AI vytěžení a samostatné účtování AI spotřeby.
- Autorizace, schvalování, zámky období a zápis neměnných verzí vytěžení zůstávají v PostgreSQL podle ADR-0003, ADR-0005, ADR-0008 a ADR-0015.
- Přínos: změna společné přípravy má jedno místo; její výsledky lze ověřovat přes rozhraní modulu pro všechny tři cesty. Zachovat ověření příkazů proti databázi a stávající scénáře převodů, nálezů a platebních účtů.
- Výchozí místa: `src/application/documents.ts` (`createManualDocument`, `correctDocument`), `src/application/processing.ts`; existující ověření v `tests/review.test.ts` a `tests/bank-advisories.test.ts`.

### 11. Společná pravidla selhání rozdělení zdroje a AI vytěžení

**Stav:** hotovo v [PR #243](https://github.com/Thomisso/iVAT/pull/243), tickety #226.

**Specifikace:** [revize dokladů](document-review.md), se zachováním současných provozních invariantů.

**Doplněno:** 6. 11. 2026 na základě architektonické revize. **Doporučení:** stojí za rozpracování. Původní návrh byl zahrnut do #222 a dodán v #226; níže zůstává odůvodnění a výchozí stav.

- Obsluha rozdělení zdrojového souboru (Split) a vytěžení dokladu (Extraction) opakuje rozhodování mezi technickým opakováním, čekáním na zásah platformy a konečným selháním, přestože už sdílí dílčí pomocné funkce.
- Soustředit společná pravidla rozhodování, zápisu diagnostické odpovědi poskytovatele a evidence provozního problému do jednoho modulu; nevytvářet obecný framework pro úlohy ani nové rozhraní pro každou pomocnou funkci.
- Zachovat identitu požadavku a ochranu proti opožděnému workeru, životní cyklus rezervace AI allowance, navazující odesílání úloh po Splitu a omezená oprávnění workeru podle ADR-0010 a ADR-0011.
- Selhání uložení diagnostické odpovědi nesmí nahradit původní chybu. Přechodné selhání a čekání na zásah platformy musí nadále vést k odlišnému chování.
- Přínos: jedna změna pravidel pokryje oba druhy úloh. Přes existující rozhraní pro spuštění úlohy ověřovat přechodné a konečné chyby i čekání na zásah platformy; zachovat testy souběhu, rezervací a generací požadavků.
- Výchozí místo: `src/application/processing.ts`; existující ověření v `tests/processing.test.ts`, `tests/ai-processing-allowance.test.ts` a `tests/platform-administration.test.ts`.

### 12. Společné načítání podkladů pro revizi dokladu

**Stav:** hotovo v [PR #243](https://github.com/Thomisso/iVAT/pull/243), tickety #227.

**Specifikace:** [revize dokladů](document-review.md), včetně správných nálezů aktuální a historické verze.

**Doplněno:** 6. 11. 2026 na základě architektonické revize. **Doporučení:** stojí za rozpracování; očekávaný přínos omezuje zatím jediný volající. Původní návrh byl zahrnut do #222 a dodán v #227; níže zůstává odůvodnění a výchozí stav.

- Stránka revize dnes sama vybírá aktuální nebo historickou verzi vytěžení, porovnává její identitu se samostatně načtenými ověřeními platebního účtu a rozhoduje o nahrazení či potlačení souvisejících upozornění.
- Soustředit výběr verze a vyhodnocení příslušných nálezů do jednoho modulu pro načítání podkladů revize. Ve stránce ponechat vykreslení, překlady a navigační odkazy; využít existující modul ověření platebních účtů.
- Zachovat rozdíl mezi aktuálními nálezy doplněnými datovaným ověřením účtu a nálezy při prohlížení zaznamenané verze. Opožděné ověření starší verze nesmí nahradit nálezy aktuálních údajů.
- Datovaná ověření platebního účtu zůstávají oddělená od neměnných verzí vytěžení podle ADR-0005 a ADR-0018. Refaktor nemění schválení, zámky období, uložené výkazy DPH ani význam nálezů v ostatních přehledech.
- Přínos: pravidla verzí a jejich nálezů mají jedno místo a lze je ověřovat přes rozhraní načítacího modulu s lokální Supabase. Zachovat prohlížečové ověření výběru historie a zobrazení; nový adaptér pouze kvůli tomuto přesunu není potřeba.
- Výchozí místa: `src/app/companies/[companyId]/documents/[documentId]/page.tsx`, `src/application/bank-account-checks.ts`, `src/application/documents.ts`, `src/application/document-reporting.ts`; existující ověření v `tests/bank-advisories.test.ts` a `e2e/bank-advisories.spec.ts`.

## Bugs / Improvements

Z QA v6 se nepřenáší žádná otevřená chyba. Nové nálezy zapisovat sem.
