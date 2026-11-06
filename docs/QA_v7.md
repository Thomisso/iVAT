# QA v7: otevřené funkce a technická zlepšení

**Datum založení:** 6. 11. 2026
**Stav:** otevřeno; převzato z uzavřeného [QA v6](QA_v6.md).
**Rozsah:** 10 nedokončených položek Features, včetně částečně splněného bodu 5. Původní číslování z QA v6 je zachováno pro dohledatelnost; body 3 a 9 jsou dokončené a zůstávají v QA v6. Všechny Bugs / Improvements a–g z QA v6 jsou dokončené.
**Další postup:** rozpracovat dosud otevřené požadavky; body 10–12 jsou technické návrhy k samostatnému posouzení. Přesun do QA v7 sám neschvaluje konkrétní řešení ani nezahajuje implementaci.

## Features

### 1. Zvýraznění vytěžených informací přímo v PDF

**Stav:** otevřeno; převzato z QA v6 dne 6. 11. 2026.

- Vytěžené informace zvýraznit přímo v PDF moderním žlutým zvýrazněním.
- Model musí spolu s vytěženými údaji vracet jejich polohu v dokumentu, tedy místo, kde je identifikoval.
- Kliknutí do boxu má zobrazit přiblížený detail příslušného místa v PDF. Přesnou podobu boxu a interakce upřesnit při rozpracování.

### 2. Adresář dodavatelů a odběratelů

**Stav:** otevřeno; převzato z QA v6 dne 6. 11. 2026.

- Vytvořit adresář dodavatelů a odběratelů.
- Vytěžené informace propojit s odpovídajícím dodavatelem nebo odběratelem v adresáři.
- Do budoucna nad adresářem umožnit statistiky, přehledy a filtry; jejich konkrétní rozsah zatím není určen.

### 4. Uplatnění pouze části dokladu

**Stav:** otevřeno; převzato z QA v6 dne 6. 11. 2026.

- Umožnit ke zpracování a do přiznání zahrnout pouze část dokladu, respektive část jeho částky.
- Příklad: faktura obsahuje několik položek, ale k uplatnění je určena pouze část faktury.
- Konkrétní způsob výběru části dokladu a zadání částky zůstává k rozpracování.

### 5. Přehlednější správa uživatelů a ochrana před odebráním vlastního přístupu

**Stav:** částečně hotovo. Jednotná správa uživatelů, konkrétní Memberships a akce pro jejich rozsah byly dodány v [PR #198](https://github.com/Thomisso/iVAT/pull/198), tickety [#192](https://github.com/Thomisso/iVAT/issues/192) a [#193](https://github.com/Thomisso/iVAT/issues/193). Zbývající část původního Feature 5 je uvedena níže.

**Zbývá:**

- V sekci „Uživatelé a přístupy“ zabránit odebrání vlastního přístupu. Současná správa nabízí odebrání spravovatelné Membership bez zvláštní ochrany vlastního uživatele.
- Seznam uživatelů převést ze současného seznamu karet do přehledného gridu.
- Existující akce „Změnit roli“ a „Odebrat přístup“ začlenit přímo do gridu a zachovat jejich konkrétní rozsah i dosavadní oprávnění.

### 6. Dashboard s důležitými informacemi

**Stav:** otevřeno; převzato z QA v6 dne 6. 11. 2026.

- Na dashboardu zobrazovat dlaždice s důležitými informacemi.
- Obsah, výběr informací a konkrétní podoba dlaždic: **TBD**.

### 7. Ergonomičtější revize dokladů

**Stav:** otevřeno; převzato z QA v6 dne 6. 11. 2026.

- Sekci revize dokladů upravit tak, aby byla uživatelsky přívětivější.
- Reorganizovat tlačítka a jako hlavní akce zdůraznit „Schválit“ a „Zamítnout“.
- Zlepšit ergonomii polí a jejich vyplňování.
- Zachovat split view pro souběžné zobrazení dokumentu a jeho údajů.

### 8. Volitelné automatické schvalování bezproblémových dokladů

**Stav:** otevřeno; převzato z QA v6 dne 6. 11. 2026.

- Do nastavení firmy přidat volbu „Automaticky schválit doklady, které nevyžadují pozornost“.
- Pokud je volba pro firmu zapnutá, doklady vyhodnocené jako bezproblémové automaticky schválit.
- Přesná definice dokladu, který „nevyžaduje pozornost“, zůstává k rozpracování.

### 10. Společná příprava verzí vytěžení (Extraction Version)

**Stav:** otevřeno; převzato z QA v6 dne 6. 11. 2026.

**Doplněno:** 6. 11. 2026 na základě architektonické revize. **Doporučení:** silné; realizovat jako první z bodů 10–12. Návrh k rozpracování, mimo specifikace #185 a #200; konkrétní rozhraní ani implementační tickety zatím nejsou navržené.

- Ruční vytvoření dokladu, oprava uživatelem a AI vytěžení dnes samostatně skládají převod měny podle ČNB, deterministickou validaci, zjištění z registru plátců DPH a výsledný seznam nálezů.
- Soustředit společnou posloupnost do jednoho modulu s malým rozhraním, které skryje pořadí operací a skládání výsledků. Zachovat existující moduly převodu a validace i skutečné a testovací adaptéry ČNB a registru.
- Zachovat rozdíly vstupních cest: validaci neúplného ručního konceptu a odstranění AI confidence při ručním zápisu, automatické určení směru pouze při AI vytěžení a samostatné účtování AI spotřeby.
- Autorizace, schvalování, zámky období a zápis neměnných verzí vytěžení zůstávají v PostgreSQL podle ADR-0003, ADR-0005, ADR-0008 a ADR-0015.
- Přínos: změna společné přípravy má jedno místo; její výsledky lze ověřovat přes rozhraní modulu pro všechny tři cesty. Zachovat ověření příkazů proti databázi a stávající scénáře převodů, nálezů a platebních účtů.
- Výchozí místa: `src/application/documents.ts` (`createManualDocument`, `correctDocument`), `src/application/processing.ts`; existující ověření v `tests/review.test.ts` a `tests/bank-advisories.test.ts`.

### 11. Společná pravidla selhání rozdělení zdroje a AI vytěžení

**Stav:** otevřeno; převzato z QA v6 dne 6. 11. 2026.

**Doplněno:** 6. 11. 2026 na základě architektonické revize. **Doporučení:** stojí za rozpracování. Návrh mimo specifikace #185 a #200; konkrétní rozhraní ani implementační tickety zatím nejsou navržené.

- Obsluha rozdělení zdrojového souboru (Split) a vytěžení dokladu (Extraction) opakuje rozhodování mezi technickým opakováním, čekáním na zásah platformy a konečným selháním, přestože už sdílí dílčí pomocné funkce.
- Soustředit společná pravidla rozhodování, zápisu diagnostické odpovědi poskytovatele a evidence provozního problému do jednoho modulu; nevytvářet obecný framework pro úlohy ani nové rozhraní pro každou pomocnou funkci.
- Zachovat identitu požadavku a ochranu proti opožděnému workeru, životní cyklus rezervace AI allowance, navazující odesílání úloh po Splitu a omezená oprávnění workeru podle ADR-0010 a ADR-0011.
- Selhání uložení diagnostické odpovědi nesmí nahradit původní chybu. Přechodné selhání a čekání na zásah platformy musí nadále vést k odlišnému chování.
- Přínos: jedna změna pravidel pokryje oba druhy úloh. Přes existující rozhraní pro spuštění úlohy ověřovat přechodné a konečné chyby i čekání na zásah platformy; zachovat testy souběhu, rezervací a generací požadavků.
- Výchozí místo: `src/application/processing.ts`; existující ověření v `tests/processing.test.ts`, `tests/ai-processing-allowance.test.ts` a `tests/platform-administration.test.ts`.

### 12. Společné načítání podkladů pro revizi dokladu

**Stav:** otevřeno; převzato z QA v6 dne 6. 11. 2026.

**Doplněno:** 6. 11. 2026 na základě architektonické revize. **Doporučení:** stojí za rozpracování; očekávaný přínos omezuje zatím jediný volající. Návrh mimo specifikace #185 a #200; konkrétní rozhraní ani implementační tickety zatím nejsou navržené.

- Stránka revize dnes sama vybírá aktuální nebo historickou verzi vytěžení, porovnává její identitu se samostatně načtenými ověřeními platebního účtu a rozhoduje o nahrazení či potlačení souvisejících upozornění.
- Soustředit výběr verze a vyhodnocení příslušných nálezů do jednoho modulu pro načítání podkladů revize. Ve stránce ponechat vykreslení, překlady a navigační odkazy; využít existující modul ověření platebních účtů.
- Zachovat rozdíl mezi aktuálními nálezy doplněnými datovaným ověřením účtu a nálezy při prohlížení zaznamenané verze. Opožděné ověření starší verze nesmí nahradit nálezy aktuálních údajů.
- Datovaná ověření platebního účtu zůstávají oddělená od neměnných verzí vytěžení podle ADR-0005 a ADR-0018. Refaktor nemění schválení, zámky období, uložené výkazy DPH ani význam nálezů v ostatních přehledech.
- Přínos: pravidla verzí a jejich nálezů mají jedno místo a lze je ověřovat přes rozhraní načítacího modulu s lokální Supabase. Zachovat prohlížečové ověření výběru historie a zobrazení; nový adaptér pouze kvůli tomuto přesunu není potřeba.
- Výchozí místa: `src/app/companies/[companyId]/documents/[documentId]/page.tsx`, `src/application/bank-account-checks.ts`, `src/application/documents.ts`, `src/application/document-reporting.ts`; existující ověření v `tests/bank-advisories.test.ts` a `e2e/bank-advisories.spec.ts`.

## Bugs / Improvements

Z QA v6 se nepřenáší žádná otevřená chyba. Nové nálezy zapisovat sem.
