# QA v6: vytěžování, revize dokladů a správa přístupů

**Datum zápisu:** 31. 10. 2026
**Stav:** `grill-with-docs`, `to-spec` i `to-tickets` dokončeny pro Bugs / Improvements a–g. Uživatel potvrdil společné porozumění v Q22, testovací hranice specifikace i rozdělení ticketů. Specifikace [#185](https://github.com/Thomisso/iVAT/issues/185) má 12 podřízených issues #186–#197 s označením `ready-for-agent` a ověřenými nativními závislostmi. Sekce Features nebyla součástí tohoto rozpracování.
**Features 3:** samostatné `grill-with-docs`, `to-spec` i `to-tickets` dokončeny 6. 11. 2026; rozhodnutí Q1–Q8, závěrečné společné porozumění Q9, hranice testování i rozdělení ticketů jsou potvrzené. Specifikace [#211](https://github.com/Thomisso/iVAT/issues/211) má tři nativní sub-issues [#212](https://github.com/Thomisso/iVAT/issues/212), [#213](https://github.com/Thomisso/iVAT/issues/213) a [#214](https://github.com/Thomisso/iVAT/issues/214), všechny s labelem `ready-for-agent` a ověřenými nativními závislostmi. #212 prošel nezávislým review a byl začleněn do větve `integration/pdf-forms-211`; #213 a #214 navazují na tento společný základ. Implementace probíhá podle integračního workflow.
**Rozsah:** 9 funkcí a 7 chyb nebo zlepšení. Identifikátory zachovávají původní číslování a označení nálezů.
**Další postup:** implementace připravených ticketů pomocí `mattpocock-skills:implement-spec` podle nativních závislostí a [integračního workflow](agents/implementation-workflow.md). Implementace zatím nebyla zahájena. Samostatně povolená lokální diagnostika bodu b je dokončena a její výsledky jsou níže; opravy aplikace ani změny produkce provedeny nebyly.

## Features

### 1. Zvýraznění vytěžených informací přímo v PDF

- Vytěžené informace zvýraznit přímo v PDF moderním žlutým zvýrazněním.
- Model musí spolu s vytěženými údaji vracet jejich polohu v dokumentu, tedy místo, kde je identifikoval.
- Kliknutí do boxu má zobrazit přiblížený detail příslušného místa v PDF. Přesnou podobu boxu a interakce upřesnit při rozpracování.

### 2. Adresář dodavatelů a odběratelů

- Vytvořit adresář dodavatelů a odběratelů.
- Vytěžené informace propojit s odpovídajícím dodavatelem nebo odběratelem v adresáři.
- Do budoucna nad adresářem umožnit statistiky, přehledy a filtry; jejich konkrétní rozsah zatím není určen.

### 3. PDF náhled přiznání podle reálného formuláře

**Rozpracování:** `grill-with-docs` dokončeno 6. 11. 2026. Uživatel potvrdil rozhodnutí Q1–Q8 a závěrečné společné porozumění v Q9 odpovědí „Ano souhlasím.“ Při rozporu s původními požadavky platí potvrzená rozhodnutí a souhrn níže. Implementace tohoto bodu probíhá podle specifikace #211 a integračního workflow.

**Specifikace:** `to-spec` dokončeno 6. 11. 2026 po výslovném potvrzení hranic testování. Publikováno jako [#211 — QA v6: PDF náhled přiznání a kontrolního hlášení podle reálných formulářů](https://github.com/Thomisso/iVAT/issues/211) s labelem `ready-for-agent`; obsah issue i label byly po publikaci ověřeny. Nejde o součást specifikace #185 ani #200. Pro navazující práci je výsledným zadáním #211; níže zůstávají schválené podklady a rozhodnutí.

**Schválené rozdělení `to-tickets` — publikováno 6. 11. 2026**

Uživatel schválil velikost tří ticketů a jejich závislosti odpovědí „Vyhovuje to. OK.“ Každý ticket byl publikován jako nativní sub-issue #211 s labelem `ready-for-agent`. Obsah, labely, nativní rodič i blokující vazby byly po publikaci ověřeny.

| Ticket | Co dodá | Blokováno |
| --- | --- | --- |
| [#212 — Shodná data a aktuální exportní nastavení PDF a XML](https://github.com/Thomisso/iVAT/issues/212) (T1) | Ze současných stránek lze stáhnout oba PDF výstupy se stejnými hodnotami a aktuálními údaji jako odpovídající XML, i s neúplnou PDF hlavičkou. Nejprve sjednotí přípravu EPO dat a exportní kontext; vzhled může dočasně zůstat tabulkový. | Nic |
| [#213 — Zelený formulář VAT Return s miniaturou první stránky](https://github.com/Thomisso/iVAT/issues/213) (T2) | Úplný průchod přiznáním: skutečná zelená česká předloha, samostatná věrná miniatura s dostupnými údaji firmy, kliknutí i původní stažení celého PDF a vizuální ověření. | #212 |
| [#214 — Zelený formulář Control Statement s miniaturou a stránkováním](https://github.com/Thomisso/iVAT/issues/214) (T3) | Úplný průchod kontrolním hlášením: zelené předlohy bez „VZOR“, samostatná miniatura, všechny naplněné podporované oddíly, pokračování a souhrn C, stažení i vizuální ověření. | #212 |

#213 a #214 na sobě navzájem nezávisí; po splnění #212 mohou běžet souběžně podle [implementačního workflow](agents/implementation-workflow.md). Každý ticket má vlastní cílené integrační, prohlížečové a odpovídající vizuální kontroly; společné finální kontroly a review celé specifikace zůstávají branou existujícího implementačního workflow. Pro implementaci je výsledným zadáním specifikace #211 a její tři podřízené tickety; první dostupný je #212. Samotná publikace práci nespouští.

- PDF náhled přiznání zpracovat podle reálných PDF formulářů.
- V náhledu zobrazit také miniaturu s možností kliknutím stáhnout PDF.
- Miniatura má již obsahovat vyplněné údaje první stránky, zejména údaje firmy.
- Rozsah zahrnuje přiznání k DPH (VAT Return) i kontrolní hlášení (Control Statement).
- Dodané podklady jsou v `docs/PDF/`: `DPHDP3-XXXXXXXXXX-20261106-104851.pdf` pro přiznání a `DPHKH1-XXXXXXXXXX-20261106-104935.pdf` spolu s `Vzorovy-formular-kontrolniho-hlaseni-DPH.pdf` pro kontrolní hlášení. Podle zadání je jedna varianta kontrolního hlášení bez pozadí a druhá s pozadím a vodoznakem „VZOR“.
- Výsledný náhled ani stažené PDF nemají obsahovat vodoznak „VZOR“.
- Původní požadavek na vyplnění karty byl upřesněn odpovědí Q3 níže: zachovat současný design karty a pouze doplnit miniaturu první stránky PDF.

**Potvrzená rozhodnutí — Q1–Q8 (6. 11. 2026)**

- **Q1 — vzhled:** zachovat zelenou podobu formulářů. U kontrolního hlášení nepřecházet na bílou předlohu pouze kvůli dostupnosti varianty bez vodoznaku; výsledná zelená podoba bude bez „VZOR“.
- **Q2 — data:** PDF obsahuje stejná data jako odpovídající XML, včetně zaokrouhlení a údajů hlavičky. Nejde o samostatně počítanou alternativu XML výstupu.
- **Q3 — miniatura:** zachovat stávající design karet a pouze přidat miniaturu první stránky PDF. Zobrazí dostupné údaje firmy; její příprava nevyžaduje výpočet ani vygenerování celého výstupu.
- **Q4 — jazyk:** formuláře jsou vždy česky, také při anglickém rozhraní aplikace.
- **Q5 — věrnost miniatury:** zobrazit skutečnou zelenou předlohu první stránky s věrným rozvržením, poměrem stran, popisky a písmem. Vyplnit pouze dostupné údaje hlavičky a firmy; daňové tabulky mohou zůstat prázdné. Nejde o obecnou ilustraci formuláře ani o nutnost vyrenderovat celý vyplněný výkaz. Stažené PDF obsahuje celý výkaz.
- **Q6 — konkrétní XML kontext:** PDF používá data uloženého výkazu a údaje právě nastavené ve formuláři exportu XML, včetně změn kontaktů, podepisující osoby a data sestavení. Shoda se vztahuje k XML, které by vzniklo ze stejného výkazu a stejných exportních údajů. Tento bod nepřidává vazbu PDF na konkrétní historický XML artefakt ani novou historii PDF exportů.
- **Q7 — neúplná hlavička:** náhledové PDF lze stáhnout i při chybějících povinných údajích pro XML, například finančním úřadu. Dostupné údaje se zobrazí a chybějící pole zůstanou prázdná. Podmínky pro stažení XML se nemění.
- **Q8 — stránkování kontrolního hlášení:** celý výstup obsahuje úvodní stránku, pouze naplněné detailní oddíly a souhrnnou stránku. Při větším počtu dokladů se stránky příslušného oddílu opakují; žádné řádky se neztratí. Souhrn C se zobrazí vždy včetně nulových hodnot odpovídajících XML. Prázdné detailní oddíly se neexportují.

**Schválený souhrn — závěrečné potvrzení Q9 (6. 11. 2026)**

- Přiznání k DPH i kontrolní hlášení budou věrně zobrazovat české zelené formuláře bez „VZOR“; vyplnění a částky odpovídají stejným údajům jako XML export. Vzhled předloh nemění rozsah podporovaných údajů a oddílů XML.
- Na současných stránkách výstupů zůstávají dosavadní karty a ovládání stažení; přibude klikací miniatura první stránky. Její dostupné údaje firmy vycházejí ze stejné identity jako XML a doplňující hlavička ze stejného exportního nastavení. Miniatura používá reálnou předlohu, ale nemusí obsahovat daňové částky ani vyžadovat sestavení celého PDF.
- Celé PDF se připraví při stažení, může obsahovat neúplnou hlavičku a u kontrolního hlášení se délka přizpůsobí naplněným oddílům. Součástí změny není nová historie PDF exportů ani změna požadavků na XML export.

**Potvrzené hranice testování pro `to-spec` (6. 11. 2026)**

- Hlavní hranice: existující stránky výstupů a autentizované stažení. Pro oba formuláře ověřit skutečnou miniaturu, kliknutí i dosavadní ovládání stažení, promítnutí změn exportní hlavičky, české formuláře při českém i anglickém rozhraní a zachování rozložení karet. Miniatura nesmí záviset na stažení celého PDF ani novém výpočtu výkazu.
- Doplňující existující hranice: aplikační exporty nad uloženým výkazem se skutečnými databázovými oprávněními. Porovnat významově odpovídající hodnoty PDF a XML pro stejné exportní nastavení; pokrýt zaokrouhlení, souhrn C, neúplnou hlavičku, fyzickou i právnickou osobu, diakritiku, záporné a nulové hodnoty, pokračování naplněného oddílu a izolaci Company/Organization. Jednorázové změny exportu nesmějí měnit výchozí nastavení firmy.
- Vizuálně ověřit vyrenderované reprezentativní stránky PDF a miniatury: zelené předlohy bez „VZOR“, věrné rozvržení a písmo, čitelná pole, poměr stran a žádné překryvy či ořezy. Samotné textové porovnání PDF není dostatečné; nepřidávat testovací rozhraní pro interní kreslicí funkce ani vyžadovat shodu bajtů PDF.
- Vycházet z dosavadního pokrytí PDF výstupů, XML exportů, navigace výstupů a jednorázových změn exportní hlavičky; upravit očekávání původních tabulek a anglických popisků podle schváleného zadání. Jde o plán pro implementaci, nikoli o již provedené testy.

**Zjištění při přípravě rozhovoru (6. 11. 2026; nejde o schválená rozhodnutí)**

- Současné generátory PDF vytvářejí vlastní tabulky bez formulářových předloh; karty stažení zatím miniaturu neobsahují.
- PDF čerpá z uloženého VAT Report včetně tehdejší identity a adresy Company. XML navíc řeší údaje finančního úřadu, kontakty a podepisující osobu z nastavení a vstupu exportu, případně potvrzenou adresu pro EPO. Existující XML artefakty uchovávají vyřešené údaje exportu; PDF je nepoužívá.
- U přiznání XML zaokrouhluje řádky na celé Kč a součty odvozuje ze zaokrouhlených řádků; současné PDF zobrazuje desetinné hodnoty uloženého výkazu. U kontrolního hlášení současné PDF nenahrazuje obecné součty oficiálním oddílem C.
- Dodané přiznání má 2 strany, kontrolní hlášení bez pozadí 2 strany a zelený vzor kontrolního hlášení 8 stran včetně detailních oddílů. Zelený vzor není pouhou barevnou variantou dodaného dvoustránkového exportu. Jeho vodoznak je samostatný vektorový prvek, který je technicky možné oddělit od podkladu; odstranění zatím nebylo provedeno.
- Finanční správa publikuje také [úplný formulář kontrolního hlášení 25 5564, vzor č. 2](https://financnisprava.gov.cz/assets/tiskopisy/5564_2.pdf); [databáze daňových tiskopisů](https://financnisprava.gov.cz/cs/dane/danove-tiskopisy) jej uvádí jako vzor 2. Přechod na jeho bílou podobu nebyl v Q1 zvolen; platí zelený vzhled podle potvrzených rozhodnutí.
- Obě současné stránky výstupů vyžadují uložený VAT Report; bez něj nejsou karty dostupné. Miniatura přidaná do existujících karet sama nevyžaduje nové napočítání výkazu ani generování celého PDF.
- Formulář exportu XML umožňuje změny pouze pro daný export. Finalizace sama XML artefakt nevytváří a jedno období může mít více historických XML exportů s různými údaji; nelze tedy bez dalšího ztotožnit aktuální PDF s jedním historickým XML. Význam shody určuje Q6.

### 4. Uplatnění pouze části dokladu

- Umožnit ke zpracování a do přiznání zahrnout pouze část dokladu, respektive část jeho částky.
- Příklad: faktura obsahuje několik položek, ale k uplatnění je určena pouze část faktury.
- Konkrétní způsob výběru části dokladu a zadání částky zůstává k rozpracování.

### 5. Přehlednější správa uživatelů a ochrana před odebráním vlastního přístupu

- V sekci „Uživatelé a přístupy“ nesmí být možné odebrat přístup sám sobě.
- Seznam uživatelů zobrazit v přehledném gridu.
- Akce „Změnit roli“ a „Odebrat přístup“ začlenit přímo do gridu.

### 6. Dashboard s důležitými informacemi

- Na dashboardu zobrazovat dlaždice s důležitými informacemi.
- Obsah, výběr informací a konkrétní podoba dlaždic: **TBD**.

### 7. Ergonomičtější revize dokladů

- Sekci revize dokladů upravit tak, aby byla uživatelsky přívětivější.
- Reorganizovat tlačítka a jako hlavní akce zdůraznit „Schválit“ a „Zamítnout“.
- Zlepšit ergonomii polí a jejich vyplňování.
- Zachovat split view pro souběžné zobrazení dokumentu a jeho údajů.

### 8. Volitelné automatické schvalování bezproblémových dokladů

- Do nastavení firmy přidat volbu „Automaticky schválit doklady, které nevyžadují pozornost“.
- Pokud je volba pro firmu zapnutá, doklady vyhodnocené jako bezproblémové automaticky schválit.
- Přesná definice dokladu, který „nevyžaduje pozornost“, zůstává k rozpracování.

### 9. Průběžné sledování práce agentů nad issues v GitHubu

**Doplněno:** 3. 11. 2026. Rozpracování potvrzeno a specifikace publikována 4. 11. 2026 jako [#200](https://github.com/Thomisso/iVAT/issues/200) s labelem `ready-for-agent`. Není součástí specifikace #185 ani jejích implementačních ticketů. Pro navazující rozpad a implementaci je výsledným zadáním #200; níže jsou podklady a dohodnutá rozhodnutí.

**Rozsah a provozní rozhodnutí (dohodnuto 4. 11. 2026)**

- Tracking pokryje samostatné běhy `implement` i více-ticketové běhy `implement-spec` společným rozhraním pro hlášení stavu.
- První verze dovolí nejvýše jeden řídicí běh pro celý repozitář; uvnitř něj může paralelně pracovat více implementerů a reviewerů.
- Nezávislá kontrola v GitHub Actions bude označovat zastaralé potvrzení aktivity i po ukončení řídicího běhu. Hranice 15 minut je orientační, protože plánované Actions mohou mít zpoždění nebo vynechat běh; původní čas potvrzení zůstane viditelný. Viz [omezení plánovaných běhů](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule).
- Potvrzení aktivity vychází ze zprávy konkrétního implementera či reviewera nebo z ověření jeho běhu. Samotný časovač aktivitu nepotvrzuje. Fáze práce, potvrzená aktivita a poslední výsledek jsou samostatné údaje.
- Úplná obnova je v první verzi zaručena na stejném počítači z trvalého místního záznamu včetně dosud nepublikovaných aktualizací. Převzetí na jiném počítači vyžaduje výslovný obnovovací postup a ověření dostupných issues, větví, commitů a review; chybějící důkazy zůstanou neověřené.
- Práci řídí společné příkazy; GitHub Project je publikovaný přehled. Ruční přesun karty nepotvrzuje dokončení ani nespouští práci. Synchronizace rozpor oznámí a opraví podle doloženého výsledku. Zastavení a převzetí běhu mají vlastní výslovné příkazy.
- Výslovně zrušená implementace má stav Zrušeno a povinný důvod. Přerušení agenta zachová dosaženou fázi a změní údaj o aktivitě; samo práci neruší.
- Již převzatý běh může při výpadku GitHubu pokračovat lokálně a trvale ukládat nepublikované události. Před označením výsledného PR jako připraveného k review musí synchronizace doběhnout. Bez ověření vlastnictví práce nelze zahájit ani převzít jiný řídicí běh.
- Počáteční naplnění zahrne otevřené implementační issues s labelem `ready-for-agent` a jejich nadřazené specifikace. Nové schválené tickety se přidávají automaticky; již sledované tickety v projektu zůstávají i po změně triage labelu. Historie uzavřených issues se zpětně nedoplňuje.
- Společné porozumění i hranice testování jsou potvrzené a úplná specifikace je publikovaná jako #200. Schválený rozpad je publikovaný v šesti nativních sub-issues #201–#206 s labelem `ready-for-agent` a nativními blokujícími vazbami. Implementace byla zahájena ticketem #201 na samostatné větvi a worktree; další tickety čekají na své implementační závislosti.

**Problém a cíl**

- Otevřené issue s labelem `ready-for-agent` nerozlišuje čekající práci, aktivního agenta, review a dokončenou implementaci v integrační větvi. Informace jen v konverzaci, lokálním souboru nebo později vytvořeném PR nestačí.
- Přímo v GitHubu zobrazit, na kterém issue agent právě pracuje, co je připravené, co čeká na review či odblokování a co už prošlo integrací. Uživatel má vidět i stáří poslední aktualizace.

**Doporučené řešení: jeden GitHub Project pro repozitář**

- Do projektu přidávat existující issues; nevytvářet jejich kopie. Nabídnout board podle stavu a tabulku s filtrem podle nadřazené specifikace. [GitHub Projects podporuje různé pohledy, vlastní pole a automatizace](https://docs.github.com/en/issues/planning-and-tracking-with-projects/learning-about-projects/about-projects).
- Nadřazenou specifikaci zobrazovat a filtrovat přes nativní `Parent issue`, pokud je vztah uložen jako sub-issue; nevést vedle něj duplicitní textové pole. Viz [pole Parent issue](https://docs.github.com/en/issues/planning-and-tracking-with-projects/understanding-fields/about-parent-issue-and-sub-issue-progress-fields).
- Použít samostatné projektové pole `Status`. Stávající [triage labely](agents/triage-labels.md) nadále vyjadřují připravenost zadání, nikoli průběh implementace.

| Status | Význam a okamžik aktualizace |
| --- | --- |
| Připraveno | Schválený ticket čeká na převzetí; jeho implementační závislosti jsou splněné. |
| Implementace | Konkrétní agent převzal ticket; je uvedena jeho pracovní větev. |
| Review | Implementace a cílené kontroly jsou dokončené; probíhá nezávislé review. Připomínky vracejí ticket do Implementace. |
| V integrační větvi | Review prošlo a změna je sloučená do integrační větve; issue zůstává otevřené. |
| Hotovo | Výsledné PR je po společných kontrolách a review sloučené do cílové větve a issue uzavřené. Nasazení do produkce je samostatný krok. |
| Blokováno | Nelze pokračovat kvůli závislosti, chybějícím podkladům nebo jiné překážce; uvést důvod a podmínku návratu do předchozí fáze. |
| Zrušeno | Výslovně rozhodnuto, že se ticket nebude implementovat; uvést důvod. Uzavření bez implementace není Hotovo. |

**Informace u každého ticketu**

- Číslo a název issue, nadřazená specifikace, Status, jméno implementujícího agenta a případně reviewera, pracovní větev, související PR a čas posledního potvrzeného stavu v UTC. Samostatně uchovat čas skutečného ověření aktivity agenta; pozdější doručení starého potvrzení jeho čas neobnoví. Časy s hodinami ukládat jako text v ISO 8601.
- Aktivitu zobrazovat odděleně od Status: potvrzená, neověřená nebo neaktivní. Čekající, integrované, dokončené a zrušené tickety bez pracujícího agenta jsou neaktivní; stáří jejich záznamu samo nevytváří podezření na přerušený běh. Potvrzená aktivita neprokazuje správnost ani pokrok implementace.
- Nativní GitHub assignee označuje odpovědný účet; samostatné pole Agent rozlišuje souběžné agenty běžící pod týmž účtem. Při čekání musí být zřejmé, že agent už aktivně nepracuje.
- U integrace uchovat odkaz na merge commit a výsledek review; u blokace důvod a odkaz na blokující issue. Podrobné důkazy kontrol mohou být v jednom průběžně aktualizovaném stavovém komentáři issue, aby nevznikal komentář při každém kroku.
- V pohledu specifikace ukázat počty ticketů podle stavů a zvlášť stav společných testů, celkového review a integračního PR. Součet ticketů „V integrační větvi“ sám o sobě neznamená připravenost celého PR. Odkaz na projekt má být snadno dostupný z dokumentace repozitáře a přehledu specifikace.

**Jak aktualizace implementovat**

- Doplnit do orchestrace implementace společný příkazový adaptér pro publikování stavu přes `gh project` a podle potřeby `gh api`. Projektová pole lze měnit přes [`gh project item-edit`](https://cli.github.com/manual/gh_project_item-edit). Identifikátory projektu, polí a hodnot spravovat v jedné konfiguraci; přihlašovací údaje do ní nepatří.
- Orchestrátor je jediným původcem změn implementační fáze. Publikuje je při převzetí ticketu, předání na review, vrácení připomínek, integraci, blokaci, obnovení, zrušení a finálním merge. Pracující agenti mu hlásí výsledky. Nezávislá kontrola v Actions vyhodnocuje čerstvost potvrzené aktivity; nepotvrzuje review, integraci ani Hotovo a nepřebírá práci.
- Publikování implementačních událostí a vyhodnocení aktivity musí respektovat stejné vlastnictví běhu a pořadí aktualizací. Identita běhu a revize odliší opakování od opožděné zprávy předchozího běhu. Starší událost ani starší vyhodnocení aktivity nesmí přepsat novější údaj.
- Při zahájení a obnovení běhu doplnit chybějící položky projektu a porovnat uložený stav se skutečnými větvemi, commity, review a PR. Publikování musí být opakovatelné bez duplicit a odolné vůči opožděné zprávě ze staršího běhu agenta. Obnovitelný stav synchronizace nesmí být uložen jen v dočasném `/tmp` souboru.
- Při delší práci publikovat skutečně ověřenou aktivitu nejvýše jednou za pět minut. Nezávislá kontrola v Actions vyhodnotí potvrzení starší než 15 minut jako neověřené, se zohledněním omezení plánovaných běhů uvedeného výše. Zachovat dosaženou fázi i původní čas potvrzení. Zmeškané potvrzení samo neopravňuje jiného agenta převzít stejný ticket.
- Selhání zápisu do GitHubu nesmí být vydáno za úspěšnou aktualizaci. Uchovat požadovanou změnu pro opakování, oznámit chybu v konverzaci a po obnově spojení stav dorovnat. Uživatel musí podle času aktualizace poznat zastaralý údaj.
- Zachovat [review a testovací brány integračního workflow](agents/implementation-workflow.md). Závislost ticketu uvnitř jedné specifikace může být implementačně splněna po čistém review a merge do integrační větve, přestože blokující issue zůstává otevřené. Rozlišit tuto situaci od externí závislosti čekající na finální merge; nepoužívat jen počet otevřených blockerů a neuzavírat issues předčasně.
- Nativní automatizace používat pouze tam, kde zachovají uvedený význam stavů. Samotné uzavření issue nebo PR nepotvrzuje Hotovo; musí být doložený merge výsledného PR a příslušné kontroly. Výslovné ukončení bez implementace patří do Zrušeno. Znovuotevření nebo revert vyžaduje nové vyhodnocení skutečného výsledku; nesmí ponechat neplatné Hotovo ani samo spustit implementera.
- Při realizaci sjednotit pravidla v dokumentaci issue trackeru, integračního workflow a instrukcích pro implementaci. Tracking je vývojářský workflow v GitHubu; nevyžaduje dashboard v aplikaci iVAT ani automatizaci produkčního releasu.

**Doporučený postup realizace**

1. Propojit jeden skutečný ticket se společným příkazovým rozhraním, trvalým místním záznamem a GitHub Projectem. Ověřit opakované publikování bez duplicit a sdílení řídicího stavu napříč worktrees. Konfigurace projektu a polí je verzovaná, běhová data se necommitují a zůstávají zachovaná i po odstranění ticketového worktree.
2. Zapojit rozhraní do samostatného `implement` i orchestrace `implement-spec`. Na více závislých ticketech ověřit převzetí, nezávislé review, návrat k opravám, integraci a oddělené společné kontroly specifikace.
3. Přidat nezávislou kontrolu aktivity v Actions a ověřit přerušení, obnovu, výpadky, opožděné události i ruční rozpory. Celá cesta musí splnit akceptaci níže, včetně podmínky synchronizace před předáním finálního PR k review.

Toto rámcové pořadí rozpracovává šest schválených ticketů: [#201](https://github.com/Thomisso/iVAT/issues/201) první řízený ticket, [#202](https://github.com/Thomisso/iVAT/issues/202) backlog a pohledy, [#203](https://github.com/Thomisso/iVAT/issues/203) review a integrace, [#204](https://github.com/Thomisso/iVAT/issues/204) obnova a synchronizace, [#205](https://github.com/Thomisso/iVAT/issues/205) nezávislá kontrola aktivity a [#206](https://github.com/Thomisso/iVAT/issues/206) souhrnné brány a dokončení. Výsledné zadání zachycuje specifikace #200; konkrétní závislosti jsou nativně uložené u ticketů. První dostupný ticket je #201.

**Podmínky nastavení GitHubu (ověřeno 4. 11. 2026)**

- Aktivní účet `gh` je `Thomisso`, vlastník repozitáře je uživatelský účet `Thomisso`. Současné přihlášení má scopes `gist`, `read:org`, `repo`, `workflow`; chybí oprávnění Projects. Dotaz na seznam projektů skončil chybou chybějícího `read:project`, takže existence použitelného projektu zatím není ověřena.
- Pro zápis přes místní CLI je potřeba doplnit scope `project`. GitHub Actions potřebují samostatně vhodné přihlašovací údaje s přístupem k projektu; běžný repository `GITHUB_TOKEN` přístup k Projects neposkytuje. Viz [CLI Projects](https://cli.github.com/manual/gh_project) a [Projects v Actions](https://docs.github.com/en/issues/planning-and-tracking-with-projects/automating-your-project/automating-projects-using-actions).
- Rozšíření přihlášení a nastavení CI přístupu jsou součástí navazující realizace. Přihlašovací údaje patří do úložiště credentials nebo GitHub secrets, nikoli do konfigurace projektu či stavových komentářů. V rámci tohoto rozpracování nebyla oprávnění ani nastavení GitHubu změněna.

**Akceptační ověření**

- U specifikace s několika souběžnými tickety lze bez čtení konverzace určit aktivní agenty, čekající práci, review, blokace i již integrované změny, včetně odkazu na odpovídající větev nebo PR.
- Ověřit návrat z review k opravám, odblokování po integraci stále otevřeného issue, přerušení a obnovení běhu, opakované doručení stejné události, výpadek GitHubu a obnovu synchronizace bez duplicit či přepsání novějšího stavu.
- Ověřit odmítnutí druhého řídicího běhu, opravu ručně neplatného Status, zrušení bez falešného Hotovo a zachování sledování po změně triage labelu. Neověřená aktivita zachová fázi; neaktivní čekající ticket není vydáván za přerušeného agenta.
- V řízených testech simulovat čas, restarty a selhání transportu na hranici společných příkazů; na skutečném GitHubu ověřit konfiguraci, výsledná pole a oprávnění. Testovací běh nesmí ovládat aktivní lidský nebo implementační běh.
- Po integraci všech ticketů zůstává viditelné čekání na společné kontroly a finální merge. Teprve merge výsledného PR uzavře příslušná issues a nastaví Hotovo; tím se nespouští produkční nasazení.
- Publikované údaje obsahují pouze technický průběh práce a potřebné odkazy, bez tokenů, session, soukromých dokladů a obsahu lokálních debug podkladů.

## Bugs / Improvements

### a. Povinnost DIČ podle částky dokladu

- Požadavek: DIČ vyžadovat pouze u dokladů s částkou **nad 10 000 Kč včetně DPH**.

### b. Podezření na nesprávné ověřování zveřejněného platebního účtu

- Prověřit hlášení „Platební účet není u tohoto dodavatele zveřejněn v registru plátců DPH“.
- Existuje podezření, že kontrola nefunguje správně; příčina ani chyba zatím nejsou potvrzené.
- Při navazující práci provést debug session této kontroly.

### c. Vyřešené a neúspěšné úlohy v Přehledu platformy

- V Přehledu platformy umožnit zrušit nebo smazat neúspěšné úlohy.
- Pokud byl problém neúspěšné úlohy vyřešen, nemá se úloha nadále zobrazovat SuperAdminovi jako položka k vyřešení.
- Příklad vyřešení: ruční doplnění údajů dokladu a jeho následné schválení.
- Konkrétní význam zrušení, smazání a označení úlohy za vyřešenou upřesnit při rozpracování.

### d. Odlišné rozložení menu SuperAdmina

- Menu SuperAdmina má jiné rozložení než ostatní části aplikace.
- Sjednotit rozložení; konkrétní rozdíly a cílovou podobu upřesnit při navazující revizi.

### e. Duplicitní a nefunkční cesta ke správě uživatelů

- V Nastavení je odkaz na uživatele organizace, který vede do sekce SuperAdmina a nezobrazuje žádné uživatele.
- Vedle toho existuje sekce „Uživatelé a přístupy“, kde se uživatelé zobrazují správně.
- Vyřešit chybný odkaz a nejasnost mezi oběma cestami ke správě uživatelů. Cílové uspořádání upřesnit při rozpracování.

### f. Návrat ze Zabezpečení do firmy

- Ze sekce Zabezpečení umožnit návrat zpět do firmy.

### g. Výpadky přihlášení při chybném veřejném DNS překladu z produkce

- **Stav:** potvrzený produkční nález; opravu rozpracovat a implementovat společně s ostatními položkami QA v6. Při diagnostice nebyla měněna produkční konfigurace ani aplikace.
- **Incident:** 31. 10. 2026 v **15:16:23 SEČ** (14:16:23 UTC), opakovaně v 15:17:29 a 15:17:33. Web zaznamenal `[auth:login-failed]` s `AuthRetryableFetchError`, bez kódu a se statusem `0`. V kontrolovaném intervalu chyběl odpovídající požadavek v logu Auth služby.
- **Ověřená příčina selhání spojení:** resolver Roští `10.3.0.1`, používaný přes Docker DNS `127.0.0.11`, vracel pro `api.ivat.cz` IPv4 `185.8.237.22`. Tento endpoint předkládal self-signed certifikát WEDOS Global s `CN=invalid`; požadavky z produkčního webového kontejneru opakovaně selhaly s `DEPTH_ZERO_SELF_SIGNED_CERT`.
- **Srovnávací ověření:** veřejné resolvery 1.1.1.1 a 8.8.8.8 vracely přes `lb.rosti.cz` IPv4 `185.58.41.93`. Po použití této adresy pro diagnostický požadavek ze stejného kontejneru vrátilo `/auth/v1/settings` HTTP 200 s platným ověřením TLS. Interní cesta `http://gateway:8000/auth/v1/settings` také opakovaně vracela HTTP 200. Proč resolver Roští vracel chybnou odpověď, zůstává neobjasněné.
- **Nastavení domén ověřeno:** všechny čtyři autoritativní nameservery WEDOS vracely pro `app.ivat.cz` a `api.ivat.cz` CNAME na `lb.rosti.cz` s TTL 300. Obě domény byly přiřazené běžícímu stacku Roští a `redirect_to_first` byl vypnutý. Veřejné HTTPS přes správnou IPv4 fungovalo; diagnostika neprokázala chybu v těchto zákaznických nastaveních.
- **Slabé místo aplikace:** serverový Supabase klient a session proxy používají veřejné `NEXT_PUBLIC_SUPABASE_URL`. Produkční konfigurace již obsahuje `SUPABASE_INTERNAL_URL=http://gateway:8000`, které využívá worker, ale webová autentizace je nevyužívá. Přihlášení a ověřování session tak závisejí na veřejném DNS a vnějším HTTPS i při komunikaci služeb uvnitř stejného stacku.
- **Navržená náprava:** serverovou komunikaci s Auth a souvisejícími interními API směrovat přes interní gateway. Zachovat identitu přihlašovacích cookies a veřejné URL pro prohlížeč, OAuth návraty, e-mailové odkazy a podepsané odkazy na soubory. Rozsah a provedení upřesnit při rozpracování; pouhá globální výměna Supabase URL není dostatečně ověřený návrh.
- **Provozní návaznost:** předat podpoře Roští čas incidentu a rozdílné DNS odpovědi k prověření resolveru. Nápravu serverové komunikace lze připravit nezávisle na tomto šetření. Změna klasifikace chyb v [PR #184](https://github.com/Thomisso/iVAT/pull/184) již rozlišuje nedostupnost přihlášení od chybných údajů, ale příčinu výpadku neřeší.
- **Požadované ověření opravy:** přihlášení, obnovení session, odhlášení, MFA, obnova hesla a pozvánky musí fungovat při simulované chybě veřejného DNS nebo TLS, pokud jsou interní služby dostupné. Ověřit také veřejné návratové a souborové odkazy a kompatibilitu stávajících cookies. Dosavadní diagnostické GET požadavky samy neprokazují průchod celým přihlášením.
- **Dostupnost:** doplnit vhodnou kontrolu dostupnosti Auth a diagnostiku závislostí. Při incidentu byly web i Auth označené jako healthy, přestože přihlášení přes veřejnou cestu selhávalo. Výpadek infrastruktury se nesmí vykazovat jako nesprávné heslo; logy nesmějí obsahovat hesla, tokeny ani session.

## Rozpracování Bugs / Improvements — potvrzená rozhodnutí

Tento oddíl je schváleným výstupem uzavřeného rozhovoru: zahrnuje souhlas s doporučeními Q1, Q3–Q19 a Q21, upřesnění Q20 a závěrečné potvrzení Q22. Q2 poskytla podklady pro diagnostiku; její původní návrh omezit kontrolu účtů na přijaté doklady nahradila Q17. Při rozporu s původním nálezem platí upřesnění v tomto oddílu; původní nálezy a–g výše zůstávají pro dohledatelnost. Žádná položka Features 1–8 se tímto neschvaluje ani nezahajuje.

### a. DIČ — hranice požadavku

- U běžných tuzemských dokladů umožnit schválení bez vyplněného DIČ protistrany, pokud celková částka včetně DPH nepřesahuje 10 000 Kč. Přesně 10 000 Kč spadá do výjimky; u cizí měny se porovnává částka po přepočtu na Kč.
- Zachovat zvláštní požadavky reverse charge a EU režimů a povinné DIČ vlastní Company.
- Rozlišovat chybějící údaj v iVAT od náležitostí originálu. Výjimka pro identifikaci odběratele na zjednodušeném daňovém dokladu sama o sobě neznamená obecnou výjimku pro DIČ dodavatele; viz [stanovisko GFŘ z 21. 7. 2026](https://app.fs.gov.cz/dotazy-verejnosti/dotaz/zadost-o-metodicke-stanovisko-k-rozsahu-identifikacnich-udaju-odberatelu-na-ucetnich-dokladech-4929).
- U běžného tuzemského dokladu do limitu ponechat při chybějícím DIČ dodavatele neblokující upozornění; schválení zůstává možné. Text odliší chybějící údaj v iVAT od náležitostí originálu.
- Tato výjimka se týká chybějícího údaje. Dosavadní kontrola vyplněného, ale neplatného DIČ se nemění.
- Dosavadní posuzování hranice v absolutní hodnotě u záporných částek se zachovává; změna nepřidává automatické párování opravných a původních dokladů.

### b. Platební účet — konkrétní podklady pro diagnostiku

- Uživatel označil produkční doklady Company „Tomáš Masopust“ v období 2026-Q3 jako konkrétní příklady varování.
- Je povoleno potřebné doklady stáhnout a diagnostikovat lokálně. Na produkci se nesmí debugovat ani měnit data či konfigurace; přístup slouží pouze k získání podkladů. Pokud přístup není dostupný, může doklady dodat uživatel.
- Před diagnostikou byl rozdíl porovnávání českého IBAN a domácího čísla účtu pouze kandidát příčiny; výsledek ověření je uveden níže.
- Odpověď k Q2 dodala podklady a oprávnění k diagnostice. Po jejím dokončení uživatel v Q17 potvrdil zachování kontroly přijatých i vydaných dokladů; původní návrh omezit ji pouze na přijaté doklady neplatí.

#### Potvrzené výsledné chování

- Opravit oba potvrzené vzory porovnávání: ekvivalenci nulového a chybějícího předčíslí a ekvivalenci českého IBAN s domácím číslem účtu. Podklady z produkce zůstávají soukromé; regresní ověření má použít neosobní příklady těchto vzorů.
- Payment Account je jedna informace: u českého účtu jsou domácí číslo a český IBAN vzájemně odvoditelné zápisy téhož účtu. Jediný validní zápis pro identifikaci stačí; shodné zápisy nejsou dva samostatně ověřované účty. Příklad obou podob téhož účtu uvádí [ČNB](https://www.cnb.cz/cs/platebni-styk/iban/iban-mezinarodni-format-cisla-uctu/).
- Zachovat kontrolu přijatých i vydaných dokladů. U vydaného dokladu jasně uvést, že se ověřuje zveřejnění vlastního účtu Company, nikoli účtu odběratele.
- Údaj bez rozpoznaného bankovního formátu, například identifikátor platební brány, má neblokující výsledek „Účet nelze ověřit“ s vysvětlením formátu. Nelze jej označit za nezveřejněný bankovní účet ani kontrolu tiše přeskočit.
- Výsledek „Účet není zveřejněný“ je přípustný pouze pro platný podporovaný formát účtu po úspěšném ověření bez nalezené shody. Nedostupnost registru a neověřitelný údaj jsou odlišné výsledky; bankovní upozornění neblokují schválení.
- Přidat ruční akci „Znovu ověřit účet“ pro uživatele se stávajícím přístupem k dokladu, včetně schválených dokladů a zamčených období. Nový datovaný výsledek ověření uložit odděleně od neměnných Extraction Versions a předchozích kontrol; výsledek dokládá stav při nové kontrole, nikoli historické zveřejnění při vystavení dokladu.
- Nové ověření nemění údaje dokladu, stav schválení, Period Lock ani VAT Report. Historické výsledky se zachovají; tato etapa nezavádí automatickou hromadnou obnovu. Oddělení kontrol od neměnných verzí zachycuje [ADR-0018](adr/0018-bank-account-checks-are-dated-observations.md).
- Původní doporučení Q20 samostatně ověřovat dva odlišné účty neplatí: obě pole mají popisovat jeden Payment Account. Pokud IBAN po převodu neodpovídá současně vyplněnému domácímu číslu, zobrazit neblokující upozornění „IBAN a domácí číslo účtu si neodpovídají“. Do opravy netvrdit, že je účet zveřejněný či nezveřejněný, a žádný zápis automaticky neupřednostnit (Q21).

#### Výsledek lokální diagnostiky

- Produkce sloužila pouze ke čtení v SQL transakci READ ONLY a stažení originálů. Nebyly měněny doklady, nálezy, konfigurace ani spouštěno zpracování.
- Staženo 19 relevantních originálů a jejich uložené Extraction Versions/nálezy, z toho 12 přijatých a 7 vydaných. Originály byly ověřeny proti uloženým SHA-256; oba relevantní produkční zdrojové soubory odpovídaly lokálnímu checkoutu.
- Opakovatelný lokální replay přes skutečný ADIS adaptér a `vatRegistryFindings` reprodukoval 18 varování při účtech odpovídajících aktuálnímu registru. Čtyři případy způsobuje neekvivalence nulového a chybějícího předčíslí; čtrnáct případů neekvivalence českého IBAN a domácího čísla účtu spolu s předností pole IBAN.
- Kontrolované lokální sondy: odstranění pouze nulového předčíslí odstranilo 4/4 varování; odstranění pouze IBAN při ponechání správného domácího účtu odstranilo 14/14 varování. Změna pouze mezer nepomohla. Obejití parseru ADIS zachovalo všech 18 varování; parser tyto případy nezpůsobuje.
- Sedm vydaných dokladů kontroluje DIČ a příjmový účet vlastní Company; všechny patří do skupiny IBAN/domácí účet. Jedenáct falešných varování se týká přijatých dokladů.
- Devatenáctý případ není chybou extrakce proti originálu: originál obsahuje pod označením čísla účtu identifikátor GoPay a uvádí platbu kartou. Identifikátor nemá formát bankovního účtu; označení „nezveřejněný účet“ proto zaměňuje nemožnost porovnání za negativní výsledek ověření.
- SOAP odpovědi byly získány nově lokálně z veřejného registru. Dokládají současný stav a umožňují replay bez sítě, nikoli rekonstrukci historického stavu registru. Nejde o end-to-end ověření rozhraní.
- Soukromé originály, payloady a opakovatelný diagnostický příkaz jsou mimo Git v `~/.config/ivat/qa-v6-bank-debug/evidence.md`. Příkaz byl opakovaně spuštěn s očekávaným neúspěchem: `Expected 0 false unpublished-account warnings; actual 18/18`. Oprava aplikace dosud nebyla provedena.
- Registry findings se ukládají do neměnných Extraction Versions a čtení je automaticky neověřuje znovu. Současná obnova probíhá při uložení nové verze; u schváleného dokladu vyžaduje návrat do revize, u zamčeného období také odemčení. Samotná oprava porovnávání proto historická varování automaticky neodstraní.
- Při současném vyplnění odlišného IBAN a domácího čísla účtu má dnes IBAN bez vysvětlení přednost a druhý účet se nekontroluje.

### c. Neúspěšné úlohy — vyřešení a rozsah

- Automatické mizení vyřešených problémů, odvození z aktuálního stavu a audit zásahů navazují na již schválené QA v2; nezavádí se samostatný subsystém historie incidentů.
- Technický problém AI zpracování přestává vyžadovat zásah SuperAdmina již převzetím dokladu do ruční revize. Schválení či zamítnutí nemusí předcházet jeho zmizení z aktivního přehledu; zbývající revize je práce uživatele.
- Historické selhání se zachovává. Nová chyba při pozdějším zpracování musí být znovu aktivním problémem.
- Rozsah zahrnuje Split, Extraction i export Company; export dostane vlastní odpovídající akce, nikoli převzetí do revize dokladu.
- Pro neúspěšný Split nebo Extraction nabídnout SuperAdminovi akci „Převzít k ručnímu zpracování“. Ta předá soubor nebo doklad do ruční revize a teprve úspěšným převzetím ukončí aktivní technický problém. Vyřazení souboru či zamítnutí dokladu zůstávají samostatnými akcemi. Period Lock a další existující ochrany se zachovávají; odmítnutá akce problém neskryje.
- Pro neúspěšný export nabídnout auditovanou akci „Ukončit pokus o export“ jako alternativu k opakování. Odstraní tento konkrétní pokus z aktivního řešení, ale zachová fakt neúspěchu a umožní později vytvořit nový export. Neznamená dokončení archivu, nepřepisuje jeho snapshot a nesplňuje podmínku exportu pro smazání Company.
- Stará chyba exportu přestane automaticky vyžadovat zásah, pokud snapshot již neodpovídá datům Company nebo pokud stejný User úspěšně dokončí jiný export téže Company a téže revize dat. Úspěch jiného Usera ji automaticky neuzavře; chyba nového pokusu se zobrazí samostatně.

### d. Design a menu SuperAdmina

- Sjednotit design i menu podle firemního Nastavení: umístění, rozměry, odsazení, aktivní stavy a responzivní chování.
- Zachovat schválené přepínání Firma / Platforma a platformní funkce pod Nastavením dle QA v4.

### e. Jedna správa uživatelů

- Uživatel zvolil sjednocení do jedné správy uživatelů; oddělené managementy působí duplicitně.
- Jednotná správa zobrazuje informace a dostupné akce podle Role a oprávněného rozsahu. Toto rozhodnutí samo nemění autorizační model Memberships ani pravomoci jednotlivých Rolí.
- Kontrola současného kódu nepotvrdila doslovné přesměrování organizačního odkazu do Platformy: organizační stránka načítá organizační Memberships, firemní stránka efektivní přístup k Company. Prázdný organizační seznam proto sám o sobě není důkazem chybného načítání.
- Jednotná stránka otevřená z Company má výchozí filtr na tuto Company. Oprávněný Administrator na téže stránce může přepnout rozsah na celou Organization nebo její další spravované Companies. Samostatná organizační obrazovka správy uživatelů odpadne; dosavadní vstupy mají vést do jednotné správy s odpovídajícím kontextem.
- Company Administrator vidí pouze svůj oprávněný rozsah; Organization Administrator může spravovat Organization a její Companies. SuperAdmin pracuje ve zvoleném organizačním či firemním kontextu. Jednotná správa nerozšiřuje viditelnost ani oprávnění napříč Organizations.
- V aktuálně oprávněném rozsahu zobrazit každého Usera jednou a u něj jednotlivé Memberships, například „celá organizace / firma A / firma B“, s Rolí a akcemi pro konkrétní rozsah. Stejný User může mít různé Role v různých Companies; nezavádí se jedna globální role člověka.
- Čekající Invitations zobrazit ve stejné správě a jasně odlišit od platných přístupů.
- Změna Role a odebrání přístupu vždy označí cílový rozsah. U zděděného přístupu Company Administrator uvidí původ a vysvětlení; organizační Membership může spravovat oprávněný Organization Administrator nebo SuperAdmin. Pokud po odebrání jedné Membership zůstává přístup díky jiné, rozhraní to sdělí a nebude tvrdit, že byl celý přístup odebrán.

### f. Návrat ze Zabezpečení

- Obnovit konkrétní stránku a kontext, ze kterých uživatel otevřel Zabezpečení; zahrnuje i návrat do Platformy u SuperAdmina.
- Při přímém vstupu nabídnout poslední dostupnou Company, jinak výběr Company. Návrat smí směřovat pouze do platného interního cíle, ke kterému má uživatel stále přístup.

### g. Interní serverová komunikace

- Veškerou serverovou Supabase komunikaci uvnitř produkčního stacku směrovat přes interní gateway. Zahrnout přihlášení, obnovování session, odhlášení, MFA, obnovu hesla, pozvánky a související serverová API.
- Zachovat kompatibilitu stávajících cookies a veřejné URL pro prohlížeč, OAuth, e-mailové a souborové odkazy; nejde o globální výměnu veřejné URL.
- Důvod oddělení interního transportu od veřejné identity zaznamenává [ADR-0017](adr/0017-internal-supabase-transport-preserves-public-identity.md).
- Při nedostupnosti interní gateway oznámit dočasnou nedostupnost bez automatického přechodu serverových požadavků na veřejnou Supabase adresu. Samotný výpadek nesmí způsobit hromadné odhlášení ani být vykázán jako nesprávné heslo.
- Rozlišovat běh webu od schopnosti webového prostředí spojit se s Auth. Kontrola závislosti je pouze pro čtení, samostatná od kontroly běhu webu; při selhání hlásí omezenou dostupnost. Porucha Auth sama nespouští automatické restarty jinak zdravého webu.
- Ověření musí pokrýt přihlášení, obnovování session, odhlášení, MFA, obnovu hesla a Invitations při simulovaném selhání veřejného DNS/TLS a dostupné interní gateway; dále nedostupnou gateway bez veřejného fallbacku, zachování cookies a session, veřejné OAuth/e-mailové/souborové URL a odlišení kontroly webu od kontroly Auth. Úplné přihlašovací scénáře se ověřují lokálně, nikoli opakovaným automatickým přihlašováním produkčních uživatelů.
- Návaznost na klasifikaci chyb v PR #184 zůstává součástí přípravy implementace. Podklady pro šetření resolveru Roští lze připravit nezávisle; tato session neobjednává odeslání zprávy podpoře.

## Implementační tickety Bugs / Improvements

Schválené rozdělení specifikace [#185](https://github.com/Thomisso/iVAT/issues/185). Každý ticket obsahuje vlastní akceptační kritéria a testování; všechny byly založeny s `ready-for-agent`. Závislosti jsou vedené nativně v GitHubu. Obsah ani stav rodičovské specifikace nebyly při rozdělení měněny.

| Ticket | Co dodá | Závisí na |
| --- | --- | --- |
| [#186](https://github.com/Thomisso/iVAT/issues/186) | DIČ podle částky dokladu napříč validací, schválením a reporty | — |
| [#187](https://github.com/Thomisso/iVAT/issues/187) | Jeden Payment Account napříč domácím číslem a českým IBAN; pravdivé výsledky kontroly | — |
| [#188](https://github.com/Thomisso/iVAT/issues/188) | Opakované datované Bank Account Checks bez otevření schválených dokladů či zamčeného období | [#187](https://github.com/Thomisso/iVAT/issues/187) |
| [#189](https://github.com/Thomisso/iVAT/issues/189) | Vyřešení překonaných AI chyb a explicitní převzetí k ručnímu zpracování | — |
| [#190](https://github.com/Thomisso/iVAT/issues/190) | Ukončení a automatické vyřešení neúspěšných exportních pokusů | — |
| [#191](https://github.com/Thomisso/iVAT/issues/191) | Sjednocení designu a menu Platformy s firemním Nastavením | — |
| [#192](https://github.com/Thomisso/iVAT/issues/192) | Jednotná správa Users a konkrétních Memberships ve firemním kontextu | — |
| [#193](https://github.com/Thomisso/iVAT/issues/193) | Organizační filtr jednotné správy a převod původních organizačních vstupů | [#192](https://github.com/Thomisso/iVAT/issues/192) |
| [#194](https://github.com/Thomisso/iVAT/issues/194) | Bezpečný návrat ze Zabezpečení do původního pracovního kontextu | — |
| [#195](https://github.com/Thomisso/iVAT/issues/195) | Interní Supabase transport pro přihlášení a běžné session se zachováním veřejné identity | — |
| [#196](https://github.com/Thomisso/iVAT/issues/196) | Interní Auth transport pro Invitations, obnovu hesla a MFA recovery | [#195](https://github.com/Thomisso/iVAT/issues/195) |
| [#197](https://github.com/Thomisso/iVAT/issues/197) | Dostupnost web → Auth oddělená od běhu webového procesu | [#195](https://github.com/Thomisso/iVAT/issues/195) |
