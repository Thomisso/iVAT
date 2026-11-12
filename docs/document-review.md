# Společná specifikace revize dokladů

**Stav:** dodáno do `main` v [PR #243](https://github.com/Thomisso/iVAT/pull/243) dne 8. 11. 2026; [#222](https://github.com/Thomisso/iVAT/issues/222), integrační #242 a implementační tickety #223–#241 jsou uzavřené. Navazující oprava PDF evidence [#253 / PR #265](https://github.com/Thomisso/iVAT/pull/265) byla sloučena 10. 11. 2026. Produktová rozhodnutí Q1–Q42 níže jsou schválený podklad této dodávky, nikoli nedokončený rozhovor.

**Navazující rozsah:** [QA v7 triage](qa-v7-triage.md), poměrný odpočet [#275](https://github.com/Thomisso/iVAT/issues/275) a oddělené měsíční KH [#277](https://github.com/Thomisso/iVAT/issues/277) jsou samostatná dosud nedodaná zadání. Tento stav potvrzuje merge kódu; nepřidává tvrzení o produkčním nasazení ani o novém klientském či vizuálním ověření.

**Ověření staré lhůty:** bránu při tehdejší implementaci řešily #224 a #238; rozsah závěrů a inference zůstává v [původním rozboru](research/claim-deadline.md) a [navazujícím rozboru hranice](research/claim-deadline-new-yearend.md). Níže uvedené podmínky zachovávají historický kontrakt, nevytvářejí znovu otevřený produktový úkol.
**Zdroj:** [QA v7](QA_v7.md), výchozí bod 7 a související požadavky.
**Zahájeno:** 6. 11. 2026.
**Schváleno:** 6. 11. 2026 výslovným závěrečným potvrzením uživatele.
**GitHub specifikace:** [#222 — Revize dokladů, adresář, částečné uplatnění a automatické schvalování](https://github.com/Thomisso/iVAT/issues/222), publikováno se štítkem `ready-for-agent`.

## Potvrzený záměr

- Hlavním pracovním scénářem je účetní, která postupně kontroluje větší počet dokladů, porovnává údaje s předlohou, opravuje je a rozhoduje o schválení.
- Společná specifikace zahrnuje funkční body QA 1, 2, 4, 7 a 8 a související technické body 10–12. Správa uživatelů a dashboard zůstávají samostatně.
- Prioritou je desktop a notebook se současně viditelnou předlohou a údaji. Mobil může používat kompromisní rozložení.

## Rozsah a návaznost na QA

| QA v7 | Součást společné specifikace |
| --- | --- |
| 1 | Polohy vytěžených údajů, žluté zvýraznění PDF a obrázků, odkazy na buňky/řádky Excelu a volitelný Inspect. |
| 2 | Adresář protistran pro jednu Company, párování, správa a odkazy na doklady; pokročilé statistiky jsou odloženy. |
| 4 | Ručně vybrané částky samostatných plnění po sazbách a neuplatněný zbytek; omezený daňový rozsah níže. |
| 7 | Split view, formulář, akce, fronta, bezpečné uložení a schválení, historie a klávesové ovládání. |
| 8 | Firemní opt-in automatické schválení podle deterministických podmínek, bez confidence prahu. |
| 10 | Společná příprava verzí pro AI, ruční založení a opravu. |
| 11 | Společné rozhodování o selhání Split/Extraction se zachováním současných provozních pravidel. |
| 12 | Společné načítání aktuálních a historických podkladů revize a správných nálezů. |

Správa uživatelů z bodu 5 a dashboard z bodu 6 nejsou součástí. Samostatné položkové vytěžování zůstává v [#11](https://github.com/Thomisso/iVAT/issues/11). Rozšířené daňové scénáře a oddělená období při samovyměření jsou v [#221](https://github.com/Thomisso/iVAT/issues/221), s vazbami na #5 a #2. Existující backlog [#12](https://github.com/Thomisso/iVAT/issues/12) popisuje starší návrh confidence prahu; tato specifikace tento práh nezavádí a před ticketizací se musí jeho rozsah sladit s tímto rozhodnutím.

## Potvrzená rozhodnutí

### Opravy a schválení

- Hlavní akce „Schválit“ zpracuje i aktuálně rozepsané opravy, zkontroluje je a schválí právě výslednou verzi. Samostatně zůstane dostupné „Uložit rozpracované“.
- Při neúspěšné kontrole zůstanou rozepsané hodnoty zachované a doklad se neschválí. Pokračování na další doklad nastane až po úspěšném schválení.
- Uložení oprav a schválení výsledné verze tvoří jeden celek: buď uspějí obě změny, nebo se neprovede ani jedna. Při neúspěchu lze zachované rozepsané hodnoty uložit samostatně jako rozpracované.
- Nové upozornění zjištěné při kontrole rozepsaných oprav schválení pozastaví a vyžádá výslovné schválení s upozorněním. Již zobrazené nálezy se znovu nepotvrzují při každém kliknutí.
- Ukládání zůstává výslovné. Při přechodu jinam s neuloženými změnami nabídne aplikace uložit, zahodit nebo zůstat; psaní samo nevytváří verze. Ochrana zahrnuje přechod mezi doklady, do historie i opakování AI. U opuštění stránky přes funkce prohlížeče se použije dostupné systémové upozornění.
- Při souběžné změně jiným uživatelem, schválení nebo zamčení období se operace zastaví a zachová rozepsané hodnoty. Uživatel uvidí aktuální stav a může jej porovnat s rozepsanými údaji; cizí změny se automaticky nepřepisují.
- Opakování stejného úspěšného požadavku nevytvoří další verzi ani další schválení.
- Schválení beze změn znovu potvrdí existující aktuální verzi; nevytvoří prázdnou uživatelskou opravu. Neúplný koncept dál vyžaduje platné DUZP podle ADR-0015. Nelze-li uložit ani koncept, formulář jasně odliší neuložené hodnoty od úspěšně uložených.

### Rozložení

- Na desktopu bude předloha vlevo a formulář vpravo, s nastavitelným poměrem šířek a samostatným posouváním panelů.
- Hlavní akce zůstávají dostupné v pevné liště: nejvýraznější „Schválit“, přímo dostupné „Zamítnout“ a vedlejší „Uložit rozpracované“.
- Historie, opakování AI a méně časté akce nebudou zabírat hlavní pracovní plochu.
- Pořadí formuláře: Klíčové údaje dokladu → Částky a uplatnění → Protistrana → Platba. Částky mají přednost před protistranou.
- Klíčové údaje zahrnují číslo, směr, režim DPH, DUZP a období. Vlastní firma je stručně shrnutá s možností rozbalení, méně časté údaje jsou rozbalovací. Chyby se zobrazí u polí i v klikacím souhrnu.
- Na notebooku přibližně 1366 px širokém musí být předloha, formulář a hlavní akce současně použitelné. Na mobilu se může mezi předlohou a údaji přepínat bez ztráty rozepsaných hodnot; hlavní akce nesmějí překrývat obsah.
- Zachovají se české vstupy dat a částek včetně desetinné čárky a mezer. Popisky zůstávají viditelné, povinnosti a chyby jsou srozumitelné i bez barev. Odkaz ze souhrnu odhalí sbalenou sekci a zaměří konkrétní pole.

### Navigace a klávesové zkratky

- Zachová se filtrovaná fronta a předchozí/další doklad. Bez otevřené fronty se automaticky nevybírají jiné doklady firmy.
- Tab přechází mezi poli, Ctrl/Cmd+S ukládá rozpracované a Ctrl/Cmd+Enter schvaluje se stejnými kontrolami jako tlačítko. Samotný Enter v běžném poli doklad neschválí.
- Vedle ikony notifikací bude ikona klávesových zkratek. Kliknutí otevře přehled dostupných akcí a jejich ovládání. Přehled musí odpovídat aktuálnímu kontextu a oprávněním; konkrétní podoba otevřeného přehledu se dopracuje při návrhu UI.
- Ikona patří do společného rámce sekce firmy na všech jejích stránkách, skutečně vedle zvonku: na desktopu do spodního bloku postranního panelu, na mobilu do horní lišty. Nenahrazuje ani nepřesouvá notifikace.
- Přehled se otevírá jako pojmenovaný přístupný dialog ovladatelný klávesnicí, s uzavřením přes Escape a návratem fokusu na spouštěcí tlačítko. Modalita má přednost před zkratkami formuláře; při otevřeném dialogu či psaní české diakritiky se nesmí nechtěně schválit doklad.

### Předloha a zvýrazňování

- Propojení polí s předlohou pokryje PDF, obrázky i Excel. U Excelu se použijí odkazy na řádky či buňky.
- Pole a odpovídající místo v předloze budou propojena obousměrně. Údaj bez dostupné polohy bude použitelný i bez zvýraznění.
- Přiblížení je standardně vypnuté. Lupa „Inspect“ zapíná režim se zvětšeným výřezem; běžný výběr pole pouze zvýrazní odpovídající místo v předloze. Režim se vypíná lupou nebo Escape.
- Přiblížení nepřeskládá formulář ani nemění rozepsané hodnoty.
- Ručně opravené pole zachová odkaz na původní místo v předloze, se zřetelným označením „Ručně upraveno“. Odkaz nedokládá, že původní AI přečetla novou hodnotu. Historie zachová původní vytěžení.
- Starší doklady bez poloh zůstávají použitelné; nové polohy získají až výslovně vyžádaným opakováním AI.
- Chybějící poloha sama o sobě je pouze informace o nedostupném zvýraznění, ne účetní upozornění. Nezablokuje ruční ani automatické schválení; u daného pole není dostupný Inspect.

### Adresář protistran

- Adresář bude oddělený pro každou Company.
- Jeden záznam protistrany může vystupovat jako dodavatel i odběratel.
- Doklad uchová vlastní údaje. Samotné propojení s adresářem ani pozdější změna adresáře je nepřepisují; převzetí údajů z adresáře do dokladu je výslovná oprava.
- Rozdíl mezi údaji dokladu a propojeného adresářového záznamu se zobrazí jako upozornění. Protože automatické schvalování vyžaduje nulová upozornění, takový rozdíl ponechá doklad k ruční revizi.
- Automatické propojení vyžaduje jednoznačnou shodu normalizovaného DIČ nebo IČO. Rozporné identifikátory, více kandidátů nebo chybějící identifikace vyžadují ruční výběr. Podobné jméno smí nabídnout kandidáta, ne samo automaticky propojit záznam.
- Při úspěšném schválení může vzniknout záznam dosud neznámé protistrany. Automatické vytvoření vyžaduje platné jednoznačné IČO nebo DIČ. Bez identifikátoru uživatel výslovně potvrdí vytvoření nebo vybere existující záznam. Neúspěšné schválení nezanechá nový adresářový záznam.
- Nepoužitý záznam lze smazat. Záznam s navázanými doklady lze pouze archivovat. Úpravy jsou možné, ale nepřepíší údaje dokladů. Archivovaná protistrana zůstává dostupná na starých dokladech a běžně se nenabízí pro nové.
- První verze adresáře zahrnuje hledání podle názvu, IČO a DIČ, filtr dodavatel/odběratel, detail s navázanými doklady a ruční založení, úpravu a archivaci. Pokročilé statistiky a finanční přehledy zůstávají budoucím rozšířením.
- Všichni uživatelé s přístupem k dané firmě mají stejná oprávnění k celé správě jejího adresáře: založení, úpravy, smazání nepoužitého záznamu, archivaci i obnovení. Administrator ani SuperAdmin nemají navíc výjimku z kontroly vazeb na doklady.
- Identifikátory se kontrolují i proti archivovaným záznamům. Stejnou identitu nelze v téže firmě znovu založit; při archivované shodě lze záznam obnovit. Podobná jména bez identifikátorů automatickou shodu ani sloučení nevytvářejí; automatické slučování není součástí první verze.
- Shoda jednoho identifikátoru nepřebije rozpor druhého. Současné založení stejné identity dvěma uživateli nesmí vytvořit dvě protistrany; pokud se během operace změní kandidát či jeho údaje, znovu se posoudí shoda a případné nové upozornění.
- Kontrola smazání zahrnuje také vazby zachované v historii. Změny adresáře se auditují. Rozdílové upozornění v aktuálním pohledu se počítá vůči dnešním údajům; nemění uloženou historickou verzi, stav schválení ani uložený výkaz. Normalizace běžných mezer a formátu identifikátorů nesmí vytvářet falešný rozdíl; podstatný rozdíl se nesmí normalizací skrýt.

### Částečné uplatnění

- První verze pokrývá výběr části plnění z běžného tuzemského přijatého dokladu, zadávaný částkami po sazbách; nezavádí vytěžování ani výběr jednotlivých položek faktury. Nepokrývá poměrný odpočet podle § 75, krácený odpočet podle § 76, částečný nárok při samovyměření ani částečné dobropisy. Rozšíření je na výslovnou žádost uživatele evidováno v [backlog issue #221](https://github.com/Thomisso/iVAT/issues/221), se souvisejícími existujícími issues #5 a #2.
- Původní úplné částky dokladu zůstávají zachované. Část k uplatnění určuje výhradně člověk při ručním zásahu; AI ani součtový rozdíl ji nesmějí automaticky vytvořit.
- Po ručním zapnutí částečného uplatnění se zobrazuje „Neuplatněná část“: původní částka minus uplatňovaná část, po sazbách zvlášť pro základ a DPH a s celkovým součtem. Před zapnutím tato sekce není vyplněná. Označení nepředstavuje posouzení nákladu pro daň z příjmů.
- Neuplatněná část neslouží k vyrovnávání nesouladů vytěžených dat. Nesoulad celkových částek a rozpisu se dál samostatně hlásí podle tolerance a nesmí se přesunout do vypočteného zbytku. Při nesouladu nad toleranci se zobrazí „Nelze vypočítat“ spolu s konkrétním nálezem.
- Zachovává se současná závažnost součtových kontrol: nesoulad rozpisu se základem nebo DPH blokuje schválení; nesoulad celkové částky včetně DPH je upozornění. Oba typy zastaví výpočet neuplatněného zbytku. Upozornění ponechá rozhodnutí o ručním schválení člověku, ale neumožní automatické schválení.
- Jeden doklad nadále patří právě do jednoho období. Neuplatněný zbytek se automaticky nepřesouvá jinam. Změna schváleného výběru vyžaduje návrat k revizi a nové schválení mimo Period Lock.
- Ruční zapnutí částečného uplatnění předvyplní celé původní částky, které účetní následně sníží. Zadává se základ a DPH v měně dokladu, od nuly do původní částky. Případný přepočet používá stejný kurz jako celý doklad.
- Nulové uplatnění je možné s výslovným potvrzením: doklad zůstává zaevidovaný bez nároku na odpočet.
- Změna původních částek, sazeb, měny nebo režimu vyžaduje nové ruční potvrzení výběru. Dosavadní výběr zůstává pro porovnání, ale automaticky se nepřepočítává ani nepotvrzuje. Totéž platí po novém AI vytěžení: dřívější ruční výběr zabrání automatickému schválení, aby se bez potvrzení neobnovilo plné uplatnění.
- Uložená podoba dokladu zachová tehdejší část k uplatnění a propojení s protistranou. Historie a uložené výkazy používají tehdejší údaje, nikoli dnešní hodnoty adresáře.
- Při změně režimu, směru či typu mimo podporovaný rozsah nelze starý výběr potichu použít. Před schválením je třeba jej výslovně vyřešit. Vypnutí výběru a návrat k celým částkám je rovněž vědomé ruční rozhodnutí, ne vedlejší účinek AI.
- Kontroly celého dokladu používají původní Rate Breakdown a totals. Kontroly výběru samostatně ověřují úplnost, sazby, částky a rozsah. Celý doklad rozhoduje o hranicích pro identifikaci a zařazení do KH; výběr rozhoduje o uplatňovaném základu a DPH. Výstupy XML, PDF a přehledy musí používat stejný výpočet.
- Příklad pro 21% sazbu: celý doklad 12 000 + 2 520 = 14 520 Kč, vybraná samostatná plnění 6 000 + 1 260 Kč, zbytek 6 000 + 1 260 Kč. Přiznání použije vybrané částky; KH zůstane v B.2 podle celé hodnoty dokladu a uvede vybrané částky s `pomer = N`. Tím se nezavádí poměrný odpočet podle § 75. Viz primární podklady níže.
- Při nulovém výběru zůstane doklad vyřešený a zaevidovaný, ale nevytváří fiktivní nárok ani nulový řádek KH. Peněžní operace používají přesné desetinné částky a sdílená pravidla zaokrouhlení; měnový rozdíl se nesmí zaměnit za neuplatněný zbytek.

### Lhůty uplatnění

- Oprava pravidel odloženého uplatnění pro podporované případy je součástí této společné specifikace, nikoli pouze budoucího rozšíření #221.
- Obecná tříletá lhůta stávajícího ADR-0012 se nepřevezme do nové funkce. Pravidla rozliší přechodná ustanovení, vznik nároku, první přípustné období a skutečné uplatnění.
- U běžného přijatého dokladu se eviduje „Nejdřívější období uplatnění“, odděleně od výchozího období podle DUZP. Zvolené období nesmí být dřívější. Pokud DUZP, vystavení a Import Date spadají do téhož Reporting Period, smí systém toto období použít i pro automatiku při splnění ostatních podmínek; jde o výslovně přijaté produktové pravidlo, nikoli tvrzení, že upload prokazuje přesný den původního doručení.
- Jinak první přípustné období potvrdí účetní. AI ani pozdější upload nesmějí domyslet dřívější doručení; chybějící potvrzení představuje nezjištěnou způsobilost, brání schválení a vede k ruční revizi. Hodnota a její původ (uživatelské potvrzení nebo pravidlo stejného období) jsou součástí uložených podkladů.
- U ručního dokladu bez Source File se Import Date nevymýšlí. Účetní potvrdí časové podmínky ručně. Kalendářní data a období se vyhodnocují pro český daňový kontext, konzistentně i na hranici dne a roku.
- Pro běžný nárok vzniklý od 1. 1. 2025 je obecnou hranicí konec druhého následujícího kalendářního roku; pro dřívější nárok se použijí původní pravidla. Rozhoduje vznik nároku, ne datum uploadu nebo opravy. V podporovaném běžném scénáři vychází vznik z příslušného DUZP; nesmí se bez ověření rozšířit na zálohy, zvláštní korekce či jiné režimy.
- U staré tříleté lhůty začíná běh prvním dnem měsíce následujícího po období vzniku nároku. Základním koncem je třetí výročí tohoto dne, ne automaticky DUZP plus tři roky ani poslední den předchozího měsíce. Ověřený příklad NSS: běh od 1. 7. 2011 do 1. 7. 2014. Hraniční kalendářní otázka svátků a víkendů má samostatnou ověřovací bránu níže.
- Revize zobrazuje konkrétní datum „Nárok je nutné uplatnit podáním nejpozději …“. Kontrola k dnešnímu dni se opakuje při přípravě a exportu nového výkazu; výsledek uvede rozhodné datum. Po uplynutí příslušné lhůty neprojde nové uplatnění v připravovaném výkazu.
- Nestačí vybrat libovolné období uvnitř posledního roku: u nároku z roku 2025 uvádí GFŘ pro běžné přiznání nejpozději listopad 2027, u čtvrtletního plátce 3. čtvrtletí 2027, při hranici podání 31. 12. 2027. Plánované budoucí podání ani dodatečné přiznání tato verze nepředstírá.
- iVAT přiznání nepodává. Export ani finalizace nepotvrzují skutečné včasné podání. Archivní výkaz zůstává zachovaný a stáhnutelný i po dnešním uplynutí lhůty; aplikace neví, zda byl podán včas, a nepřehodnocuje jej zpětně jako neplatný.
- Deferred Claim je v této verzi dostupný pouze pro podporované běžné tuzemské přijaté doklady. U reverse charge a EU není společný odklad povolen ani přes přímý příkaz: nesmí posunout povinnost výstupní daně. Výjimka samovyměření z obecné lhůty se nesmí zaměnit za neomezený nárok nebo za podporu oddělených období.
- Oddělená období výstupní povinnosti a vstupního odpočtu, včetně odkladu celého odpočtu, pokračují v #221. Existující odložené případy samovyměření vyžadují ruční vyřešení před novou přípravou výkazu; zamčené výkazy se automaticky nepřepisují a rozpor se nezakrývá tichým vynecháním dokladu.

### Zamítnutí

- „Zamítnout“ otevře krátký dialog s povinným důvodem. Zamítnutí vyřadí doklad z dalšího zpracování a výkazů, ale zachová doklad a historii; nejde o smazání.
- Po úspěšném zamítnutí pokračuje uživatel ve frontě. Obnovení vrátí doklad do ruční revize a samo nespustí AI.
- Případné rozepsané změny se nejprve vyřeší ochranou neuložených změn.

### Automatické schválení

- Výslovně zapnutá firemní volba umožní schválení vyhovujícího dokladu bez otevření člověkem; ve výchozím stavu bude vypnutá.
- Historie rozliší lidské a automatické schválení.
- Automatické schválení vyžaduje současně nulové chyby, nulová upozornění, žádnou nalezenou duplicitu, podporované zařazení do výkazů a dostupné nezamčené období. Neúspěšné potřebné ověření vede k ruční revizi. AI confidence není kritériem této verze.
- Automatika se zkouší pouze při dokončení nového AI vytěžení, včetně výslovně vyžádaného opakování. Zapnutí volby neprochází zpětně čekající doklady. Ruční oprava, částečné uplatnění ani nové ověření účtu ji nespouštějí.
- Nastavení smí změnit Administrator nebo SuperAdmin; změna se zaznamená do auditu.
- Nové upozornění či duplicita zjištěné později automaticky neodvolávají schválení ani nemění hotové výkazy. Nový nález se zobrazí a případný návrat k revizi provede člověk. Změna nastavení rovněž zpětně nemění dřívější rozhodnutí.
- Automatika se rozhoduje nad aktuální verzí, generací AI požadavku, firemním nastavením, nálezy, identitou protistrany, duplicitami a obdobím. Souběžná ruční změna, zamčení nebo zastaralý worker nesmějí být obejity dříve připraveným výsledkem.
- Není-li doklad způsobilý nebo automatické schválení selže, úspěšně vytěžená verze se zachová k revizi. Nevyvolá se nové AI vytěžení ani další spotřeba allowance pouze kvůli neúspěšnému schválení. Automatika nevytvoří osiřelou novou protistranu.
- Tato přijatá výjimka mění dosavadní požadavek lidského potvrzení každého dokladu; zaznamenává ji ADR-0019.

### Historie a uzamčené stavy

- Historická verze je čistě pro prohlížení, bez schvalování, zamítání či změny období z tohoto pohledu. Účetní akce vyžadují návrat na aktuální verzi.
- Schválený doklad lze upravit až po návratu k revizi. Period Lock zachovává účetní údaje a schválení; historické verze se nikdy nepřepisují.
- Inspect lze používat i při prohlížení. Nové ověření platebního účtu zůstává dostupné na aktuálním dokladu podle ADR-0018, včetně schváleného či zamčeného dokladu; nemění účetní údaje ani schválení.

## Technické hranice

### Zápis a načítání

- PostgreSQL dál vynucuje přístup k Company, správné stavy, nejnovější verzi, Period Locks a účetní invarianty. UI ani obecný service-role přístup je nenahrazují. Nový příkaz pro ruční uložení a schválení zahrne verzi, výběr, potřebné propojení či vznik protistrany, schválení a příslušný audit v jednom atomickém výsledku.
- Externí kontroly a příprava nálezů proběhnou před závěrečným zápisem. Potvrzení upozornění se váže na konkrétní připravená data a skutečně zobrazené nálezy; klient nemůže tvrzením „potvrzeno“ obejít nové nálezy či změnu verze, adresáře nebo období. Změna během potvrzování vyvolá nové posouzení.
- Idempotentní opakování vrací skutečný výsledek stejné operace. Jiný požadavek se zastaralým základem zůstává konfliktem; retry nesmí opakovat již provedené účetní změny.
- Verze zachovává úplné částky, výběr k uplatnění, jeho potvrzení, tehdejší vazbu a zaznamenané údaje protistrany i podklady období. Živé Bank Account Checks zůstávají samostatnými datovanými pozorováními podle ADR-0018.
- QA 10: jeden modul připravuje normalizaci, přepočet ČNB, deterministickou validaci a registry pro AI i ruční cesty. Zachová neúplný koncept, odstranění AI confidence při ručním zápisu, určení směru pouze při AI a samostatné účtování úspěšné AI spotřeby. Nezavádí obecný framework.
- QA 11: společný modul určuje technický retry, čekání na zásah platformy a konečné selhání pro Split i Extraction. Zachová request identity, rezervace a spotřebu allowance, navazující úlohy po Splitu, omezená oprávnění workeru a diagnostiku. Chyba při uložení diagnostiky nepřekryje původní chybu; neúspěšné automatické schválení se nevydává za selhání úspěšné Extraction.
- QA 12: jeden načítací modul vybírá aktuální či zaznamenanou verzi a nálezy, dostupné účetní akce, podklady adresáře a platná datovaná ověření. Stránka vykresluje a překládá. Pozdní ověření starší verze nenahradí nálezy aktuálních údajů.

### Kontrakt poloh a prohlížeč předlohy

- AI kontrakt vrací vedle hodnot volitelnou evidenci jejich polohy. Server ji váže na skutečný Source File, rozsah konkrétního Document a Extraction Version; poskytovatel ani klient nesmějí volit cizí zdroj.
- PDF/obrázek používá stránku a normalizovaný obdélník vůči téže orientované stránce či obrazovému podkladu, který vidí uživatel. Stránka relativní k AI výřezu se jednoznačně převádí na stránku původního souboru. Excel používá skutečný list a absolutní řádky/buňky, ne obrazové souřadnice.
- Reference na pole musí zůstat správná i po normalizaci a vynechání prázdných řádků sazeb. Neplatná či nepodložená poloha se nepoužije; nesmí rozbít platná finanční data nebo blokovat schválení jen kvůli chybějícímu zvýraznění.
- Prohlížeč musí udržet zvýraznění při změně zoomu, velikosti panelu a stránky; nesmí kreslit pevný overlay přes nezávisle posouvaný PDF iframe. PDF je třeba vykreslit způsobem, který poskytuje souřadnice jednotlivých stránek. Excel musí zobrazit adresovatelné skutečné řádky/buňky; originální soubor zůstává nezměněný.
- Ruční oprava uchová původní místo jako referenci se správným původem hodnoty. Nová AI verze dostane vlastní evidenci; historie používá evidenci své verze. U ručního dokladu bez předlohy je přehledný stav s existující možností přiložení originálu podle ADR-0015, nikoli vymyšlená evidence.

## Přechod stávajících dat

- Starší Extraction Versions zůstanou čitelné beze změn. Nepřítomnost nových metadat se nesmí vydávat za neplatnou původní verzi; při novém schvalování či přípravě se však použijí aktuální pravidla a chybějící potřebné skutečnosti se dořeší.
- Dosavadní plné částky zůstanou plnými částkami. Migrace sama nezapne Partial Claim, nevytvoří neuplatněný zbytek ani potvrzení prvního období. Pravidlo stejného období smí využít jen skutečně existující podklady.
- Nová firemní automatika je pro všechny stávající Company vypnutá. Nasazení neschvaluje čekající doklady, nehromadně nespojuje adresář a nespouští placené AI pro doplnění poloh.
- Staré vazby a výkazy se nesmějí rekonstruovat z dnešního adresáře jako údajně historické. U staré verze se chybějící vazba přizná; podklady nových uložených výkazů obsahují skutečně použitý výběr, verze a časové posouzení.
- Nově zjištěná překážka zneplatní použitelnost rozpracovaného výkazu k nové finalizaci podle stávajících pravidel aktuálnosti. Nezmění automaticky Approved na NeedsReview a nepřepíše uložený zamčený výkaz.

## Rozhraní testování

Při převodu do GitHub specifikace uživatel výslovně potvrdil následující plán:

- Hlavní rozhraní tvoří existující aplikační příkazy a dotazy se skutečnou lokální databází, Auth a RLS. Výsledek se ověřuje přes veřejné odpovědi, uložené verze, audit a reporty, nikoli přes volání interních pomocných funkcí.
- Navazují cílené deterministické testy Rules Engine pro částky, sazby, klasifikaci, časové hranice a shodu výstupů. Rozhodné datum se řídí v testu; testy nesmějí záviset na aktuálním měsíci.
- Omezená sada úplných prohlížečových scénářů ověří rozložení, Inspect, vazbu na předlohu, rozepsané hodnoty, frontu, dialogy a klávesové zkratky.
- Využijí se existující vzory testů revize a ručních dokladů, bankovních upozornění a historie, workeru a allowance, výpočtu DPH a přístupnosti notifikačního dialogu. Nevznikne testovací rozhraní pro každou vnitřní funkci.

## Akceptační scénáře

| ID | Scénář a očekávaný výsledek |
| --- | --- |
| A01 | Na desktopu 1366 px lze současně porovnávat předlohu a údaje, měnit poměr panelů, posouvat je samostatně a dosáhnout na hlavní akce. Na mobilu přepnutí pohledu neztratí hodnoty. |
| A02 | Pořadí sekcí je klíčové údaje, částky, protistrana, platba; česká data a částky fungují. Souhrn chyby odhalí a zaměří správné pole. |
| A03 | Rozepsaná oprava a Schválit vytvoří právě výslednou uloženou podobu a schválení. Odmítnutí zápisu, nový zámek nebo konflikt neprovedou část této změny a nevymažou formulář. |
| A04 | Nově zjištěný warning pozastaví schválení; potvrzení starého seznamu nálezů neoprávní pozdější odlišný seznam. Již viděný nezměněný warning nevyvolává opakovaně další dialog. |
| A05 | Dvojklik, ztracená odpověď a retry nezaloží další verzi, protistranu ani schválení; jiná karta se zastaralou verzí dostane skutečný konflikt. |
| A06 | Odchod se změnami nabízí uložit/zahodit/zůstat. Neplatný DUZP zabrání uložení konceptu a nepředstírá úspěšné uložení. |
| A07 | Schválení a odůvodněné zamítnutí pokračují ve filtrované frontě; bez fronty se nevybírají cizí doklady. Obnovení zamítnutého dokladu nespustí AI. |
| A08 | Ikona shortcuts je vedle zvonku v desktopovém i mobilním rámci firmy. Dialog má správný fokus, Escape a kontext akcí. Ctrl/Cmd+S a Ctrl/Cmd+Enter respektují stav a modalitu; Enter v poli neschválí. |
| A09 | PDF s více Documents mapuje správnou původní stránku a pole. Zvýraznění zůstává na místě po zoomu a resize; Inspect je výchozí vypnutý a lze jej zavřít. |
| A10 | Obrázek včetně normalizovaného HEIC a Excel s více listy zobrazí místo na skutečně použitém podkladu či buňce. Chybějící/neplatná poloha neblokuje účetní práci. |
| A11 | Ruční oprava zachová odkaz na původní místo s označením původu; historická AI verze stále ukazuje původní hodnotu a její evidenci. Nové AI nepřepíše historii. |
| A12 | Adresáře dvou Company jsou izolované. Stejná protistrana může být dodavatelem i odběratelem. Všichni oprávnění uživatelé firmy mají stejné CRUD/archivační možnosti. |
| A13 | Jednoznačné ID propojí záznam, rozporná ID vyžádají ruční řešení. Podobné jméno se samo nespojí. Změna adresáře neaktualizuje údaje dokladu a podstatný rozdíl vyvolá warning. |
| A14 | Souběžné založení stejné identity nevytvoří duplicitu. Archivovaná shoda vede na obnovení, ne nový záznam. Historicky použitý záznam nejde smazat; nepoužitý ano. |
| A15 | Nová protistrana vznikne spolu s úspěšným schválením; bez ID je třeba lidské potvrzení. Neúspěšná operace nezanechá osiřelý záznam. |
| A16 | Před ručním zapnutím výběru nejsou vyplněné neuplatněné částky. Po zapnutí se předvyplní celé částky; AI nikdy nevytvoří vlastní výběr ani neabsorbuje součtový rozdíl. |
| A17 | Celý doklad 12 000 + 2 520 Kč, výběr 6 000 + 1 260 Kč: správný zbytek, přiznání s vybranými částkami, KH B.2 podle celého dokladu a `pomer=N`; XML a PDF souhlasí. |
| A18 | Nesoulad původních totals s rozpisem zůstane error/warning podle pravidel; zbytek ukáže Nelze vypočítat. Výběr mimo rozsah, neúplný výběr či nepodporovaný režim se nepropašují do reportu. |
| A19 | Smíšené sazby a cizí měna zachovají původní částky a společný kurz; nulový výběr vyžádá potvrzení a nevytvoří fiktivní nárok ani řádek KH. |
| A20 | Změna částek/sazeb/měny/režimu a nové AI po ručním výběru vyžadují opětovné potvrzení; automatika neobnoví plné uplatnění. Historický výkaz zachová starý výběr. |
| A21 | Běžný přijatý doklad s DUZP, vystavením a importem v jednom období může využít přijaté pravidlo automatiky. Lednový DUZP a březnový import nedokládají lednové držení; první období musí potvrdit účetní. |
| A22 | Rozliší se vznik nároku před rokem 2025 a od roku 2025; kontrola nepoužije DUZP plus tři roky. Ověřený základní starý interval zahrnuje 1. 7. 2014 a končí před 2. 7. 2014. |
| A23 | Nárok z roku 2025 má obecnou hranici podání 31. 12. 2027; běžný nový výkaz nepřipustí automaticky prosinec/Q4 2027. Nový export znovu kontroluje dnešní datum, ale archivní XML zůstane stáhnutelné. |
| A24 | Deferred Claim funguje jen pro podporovaný domestic. Přímý pokus posunout společné období RC/EU je odmítnut; starý odložený případ nelze tiše použít k nové přípravě a zamčené výkazy se nezmění. |
| A25 | Automatika je po migraci vypnutá; zapíná ji jen Administrator/SuperAdmin s auditem. Zapnutí neprojde backlog a ruční uložení ani nové ověření účtu ji nespustí. |
| A26 | Automatiku zastaví každý error, warning, aktuálně nalezená duplicita, nepodporované mapování, chybějící potřebné ověření či nezpůsobilé období; chybějící samotná poloha nikoli. |
| A27 | Souběžné AI dokončení, vznik protistrany, změna nastavení, ruční zásah a zámek nemohou obejít čerstvou kontrolu. Známá duplicita nesmí projít jen kvůli stáří kandidáta či opožděnému workeru. |
| A28 | Selhání automatického schválení zachová úspěšnou Extraction k revizi a neúčtuje ji znovu. Pozdější warning či duplicita neodvolá schválení ani nepřepíše výkazy. |
| A29 | Historický pohled nemá účetní mutace. Approved vyžaduje návrat k revizi; Period Lock zablokuje mutace i přes RPC. Povolený Bank Account Check nezmění stav, verze ani výkaz. |
| A30 | Ruční doklad bez originálu a ruční převzetí po selhání AI používají stejné validační a schvalovací podmínky, nevyrábějí Import Date ani polohy a nespotřebují AI allowance. |
| A31 | QA 10 zachová rozdíly tří vstupních cest a shodné výsledky společných pravidel. QA 11 rozlišuje retry/platformní zásah/konečné selhání a zachová request generace, diagnostiku i allowance. |
| A32 | QA 12 načte správnou aktuální/historickou verzi, její nálezy a odpovídající Bank Account Checks; opožděný výsledek jiné verze nepřebije aktuální údaje. Staré verze a uložené výkazy jsou nadále čitelné. |
| A33 | Výsledná implementační větev obsahuje commit všech sedmi dokumentů vyjmenovaných níže, včetně schválené specifikace, aktualizovaného QA, slovníku a souvisejících ADR. Kontrola diffu nevynechá nové nesledované dokumenty ani nepřidá nesouvisející změny pracovní kopie. |

## Součást dodávky: commit současných dokumentů

Na výslovný požadavek uživatele je součástí této specifikace také commit dokumentů, které byly změněné nebo nově vytvořené při zadání převodu do GitHub specifikace. Kontrolovaný seznam obsahuje těchto sedm dokumentů:

- `GLOSSARY.md`
- `docs/QA_v7.md`
- `docs/adr/0003-ai-extracts-rules-engine-computes.md`
- `docs/adr/0012-reporting-period-follows-tax-point-date.md`
- `docs/adr/0019-optional-company-automatic-approval.md`
- `docs/adr/0020-claim-eligibility-is-distinct-from-tax-point-period.md`
- `docs/document-review.md`

Commit musí zahrnout schválený obsah i nové dokumenty a být součástí výsledné implementační větve/PR. Před zahájením implementace se tyto existující změny přenesou do příslušné vlastní pracovní větve/worktree a zkontrolují proti tomuto seznamu; nesmějí se ztratit při založení čistého worktree. Nesouvisející současné či pozdější změny lidské pracovní kopie se automaticky nestagují. Tento požadavek rozšiřuje rozsah budoucí dodávky, neoznačuje commit za již provedený.

## Podmínky implementace

- Produktové volby Q1–Q42 a celý ucelený dokument uživatel výslovně potvrdil; návrhový rozhovor je uzavřen. Následuje ticketizace podle této specifikace. Schválení specifikace samo nespouští implementaci ani release.
- Před ticketem, který zavede kalendářní blokaci starých nároků, je nutné doložit primárním zdrojem nebo odborně potvrzeným výkladem, zda se právě konec staré lhůty § 73 odst. 3 při svátku/víkendu posouvá. Ověřený základní interval s pracovním dnem tuto otázku neřeší. Žádný automaticky domyšlený posun se nesmí označit za ověřený algoritmus. Tento dílčí ověřovací krok není další produktová volba ani požadavek, aby pravidlo určil uživatel.
- Následná ticketizace vychází z této jedné specifikace, uvede závislosti a přiřadí odpovídající A01–A33. Základ tvoří převzetí a commit výše uvedených dokumentů, QA 10 a datové invarianty; navazují adresář a atomické příkazy, částky a období, kontrakt evidence a viewer, automatika, složení revize a společná akceptace. QA 11 zachová samostatně ověřitelné provozní chování.
- Při implementaci platí vlastní worktrees a databáze, shared tracker a [multi-ticket workflow](agents/implementation-workflow.md). Pracovní tickety mají cílené testy; plné DB sady běží až společně. Výsledný diff musí projít nezávislým Standards/Spec review, sdílenými kontrolami a relevantním Next runtime/E2E ověřením. Tento dokument netvrdí, že tyto implementační kontroly již proběhly.

## Dosavadní podklady ze současného řešení

- Uložení oprav a schválení jsou samostatné akce. Schválení pracuje s uloženou verzí, neodesílá rozepsaná pole.
- Ve filtrované frontě schválení a zamítnutí již pokračují na další dostupný doklad.
- Aktuální split view používá předlohu vlevo a formulář vpravo. PDF je zobrazeno v prohlížečovém iframe; vazba polí na polohu v předloze zatím chybí.
- Úpravy vytvářejí neměnné Extraction Versions. Existující schvalování a Period Locks stanovují ADR-0003, ADR-0005, ADR-0007 a ADR-0015; opakovaná ověření platebního účtu ADR-0018.

Tyto podklady popisují výchozí stav, nikoli automaticky schválené chování nového návrhu.

## Primární podklady a přijaté odchylky od dosavadních ADR

- Výběr některých plnění z faktury, poměrný odpočet podle § 75 a krácený odpočet podle § 76 nejsou zaměnitelné režimy. Liší se vykázáním základu a DPH i příznakem poměru v KH. Limit pro B.2/B.3 vychází z celé hodnoty dokladu, ne z nižšího uplatněného nároku. Viz [FAQ Finanční správy, části III a VIII](https://financnisprava.gov.cz/cs/dane/dane/dan-z-pridane-hodnoty/kontrolni-hlaseni-dph/caste-dotazy-a-odpovedi) a [metodika KH](https://financnisprava.gov.cz/assets/cs/prilohy/d-seznam-dani/Metodicka_informace_k_vyplneni_KH_20240101.pdf).
- U samovyměření je nutné oddělit povinnost přiznat daň od rozsahu nároku na odpočet. Snížení jediného společného rozpisu by mohlo chybně snížit i výstupní daň. Viz [pokyny k přiznání DPH, vzor 22](https://financnisprava.gov.cz/assets/tiskopisy/5412_22.pdf).
- Informace GFŘ ke změnám od roku 2025 rozlišuje obecnou hranici podání, přechod od starého pravidla, první období a zvláštní částečný nárok. Viz [informace GFŘ č. j. 94497/25, strany 3–4](https://financnisprava.gov.cz/assets/cs/prilohy/d-seznam-dani/94497_Novela_2025_Informace_zmeny_naroku_odpocet_dane.pdf). Základní konec staré lhůty dokládá [NSS 10 Afs 189/2021-40, body 12 a 19](https://vyhledavac.nssoud.cz/DokumentOriginal/Html/709715); nedokládá vyřešení sváteční hranice.
- Běžný domácí režim a reverse charge mají rozdílné podmínky prvního období. Viz [metodická odpověď FS č. 118 ze 16. 12. 2025](https://app.fs.gov.cz/dotazy-verejnosti/dotaz/narok-na-odpocet-dane-z-prijate-faktury-%E2%80%93-prislusne-zdanovaci-obdobi-1663) a [aktuální znění § 72–73 v e-Sbírce](https://e-sbirka.gov.cz/sb/2004/235?odkazId=41536805). Použití obecné lhůty na plný nárok vybraných samostatných plnění je inference z rozlišení jednotlivého plnění a metodického příkladu FS, nikoli tvrzení, že každá nižší částka faktury je takovým případem.
- Příznak `pomer` má samostatný význam v [oficiálním kontraktu EPO DPHKH1](https://adisspr.mfcr.cz/dpr/adis/idpr_pub/epo2_info/popis_struktury_detail.faces?zkratka=DPHKH1); nesmí se automaticky odvodit jen z rozdílu částek.

Výjimku z lidského schválení podle ADR-0003 zaznamenává ADR-0019. Přijatou opravu obecných lhůt a vymezení Deferred Claim oproti ADR-0012 zaznamenává ADR-0020. Ostatní ochrany ADR-0005, ADR-0007, ADR-0008, ADR-0015 a ADR-0018 platí dál. Jednotlivé přijaté volby nejsou důkazem dodané implementace.
