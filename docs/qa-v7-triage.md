# QA v7 potvrzená navazující zadání

**Rozhodnutí:** 12. 11. 2026, potvrzená vlastníkem v rozhovoru Q1–Q14 včetně upřesnění Q8a–Q8c.
**Stav:** produktový rozhovor je uzavřený. Zbývající QA práce je evidovaná ve třech samostatných issues; implementace nezačala.

| Zadání | Stav při uzavření triage | Návaznost |
| --- | --- | --- |
| [#276 Ochrana přístupu a tabulka uživatelů](https://github.com/Thomisso/iVAT/issues/276) | `ready-for-agent` | Zbývající QA v7 bod 5; zachovat prázdný počáteční stav Organization z #158 |
| [#277 Oddělené měsíční KH čtvrtletní právnické osoby](https://github.com/Thomisso/iVAT/issues/277) | `needs-triage`: produktové volby uzavřené, zbývá konkrétní daňová ověřovací brána | Prioritní předpoklad pravdivého DPH dashboardu |
| [#278 Firemní dashboard](https://github.com/Thomisso/iVAT/issues/278) | `ready-for-agent`, nativně blokovaný #277 | Zbývající QA v7 bod 6; vyžaduje skutečné dodání #277 |

Issues obsahují samostatná zadání, výchozí místa a akceptační scénáře. Readiness ani tato dokumentace nespouští agenta; dodání kódu zůstává podmíněné implementací, kontrolami a finálním merge podle společného workflow. Zdejší statusy jsou stavem triage, aktuální stav práce určuje tracker.

## Ochrana přístupu a tabulka uživatelů

- **Q1:** nelze odebrat vlastní Membership nebo si snížit roli Administrator na User, ani když přístup zůstává jinou cestou. Změnu provede jiný oprávněný člověk. Zákaz platí v databázi, UI jej vysvětlí.
- **Q2:** před odebráním či degradací posledního scoped Administratora je nutné předat správu jinému člověku. Company započítává také zděděné Organization Administrators. Samotná platformová Role SuperAdmin nenahrazuje scoped správce. Pravidlo chrání existující správu před přechodem do nuly; počáteční Organization bez Membershipů podle #158 zůstává přípustná.
- **Q3:** jedna tabulka s jedním řádkem na Usera a rozbalitelnými konkrétními Memberships. Akce míří na vybrané členství a rozsah; Organization pohled nevymýšlí jednu globální roli člověka.
- **Q5:** povolené odebrání nebo degradace jiné osoby vyžaduje odvolatelné potvrzení s osobou, rozsahem, dotčenými Companies a přeživším přístupem. Zakázaný krok má vysvětlení, ne potvrzovací cestu obcházející zákaz.
- **Q6:** hledání e-mailem a současný výběr Organization/Company; pozvánky v oddělené tabulce s e-mailem, rolí/rozsahem, stavem, platností a stávajícími akcemi. Bez hromadných změn práv.

Databázové ochrany se vyhodnotí atomicky i při souběhu a změně účinného přístupu. Zachovat MFA, audit, zákaz obcházení tenant izolace a přístup SuperAdmina bez umělých Memberships. Podrobná akceptace je v #276.

## Firemní dashboard a aktuální cyklus DPH

- **Q4:** tři oblasti aktuální Company podle QA v1: Vyžaduje pozornost, Právě probíhá a DPH. Přehled napříč Companies, finanční analytika a přestavba platformového monitoringu jsou mimo tuto dodávku.
- **Q7:** pracovní počty jsou za nevyřešenou práci celé Company, bez implicitního filtru současného měsíce. Jeden Document se v jedné kategorii započítá jednou; překrývající se kategorie nelze sečíst do falešného celku. Selhané Source Files mají vlastní jednotku. Zamítnuté doklady nejsou pending, schválené s pouhým advisory upozorněním jsou vedlejší informace.
- **Q8, nahrazuje návrh nejstaršího historického období:** hlavní je aktuální pracovní cyklus DPH. Předchozí skončené a nedokončené období má přednost; po jeho vyřešení se zobrazí právě probíhající měsíc/čtvrtletí. Při dalším kalendářním přechodu se posune tato aktuální dvojice, starší resty zůstanou viditelné zvlášť. Nevytvářet roky a výkazy návštěvou dashboardu ani automaticky nevyřešit prázdné období.
- **Q8a:** předchozí nedokončené období zůstává hlavní i po termínu, s označením Po termínu. Ještě starší resty mají upozornění a odkazy; neovládají hlavní kartu.
- **Q8b, upřesněno Q10:** dokončení dosavadního společného toku znamená aktuální zámek/finalizaci a stažení obou aktuálních požadovaných XML. U oddělených povinností po #277 se sleduje vlastní finalizace a příslušné XML. Platně potvrzená absence povinnosti KH je samostatný stav bez vynuceného XML. Finalizace ani stažení neprokazují podání; používat Zpracováno.
- **Q9:** automatické obnovení přibližně po 30 sekundách na viditelné stránce, po návratu do okna a ručně. Čas posledního úspěchu; při chybě poslední data označit jako neaktuální, ne nahradit nulami. Zachovat bezpečnost při změně Company nebo ztrátě přístupu.

Příklad: nevyřešený říjen → hlavní říjen i po listopadovém termínu; vyřešený říjen → rozpracovaný listopad. U kvartálního přiznání obdobně Q3 → Q4. Termín se počítá od konce správného období podle právních pravidel a českého pracovního kalendáře, ne jen podle čísla dne v měsíci. Frekvence patří příslušnému Reporting Year; leden nesmí odvozovat minulé období jen z nové frekvence.

Každý stav a počet povede na odpovídající práci v Company. Běžný User nedostane administrátorská data. Probíhající Split/Extraction, čekání na platformu/allowance a nedokončený transport nejsou tentýž stav. Serverové počty nepředstírají znalost neodeslaných lokálních Upload Queues. Přesná akceptace a nativní závislost na #277 jsou v #278.

## Měsíční KH a čtvrtletní přiznání

- **Q8c:** samostatně dodat měsíční KH pro právnické osoby se čtvrtletním VAT Return. Má prioritu jako funkční předpoklad dashboardu, nikoli jako pouhá úprava karty.
- **Q10:** u čtvrtletní právnické Company jsou přiznání a KH samostatné povinnosti se svou periodou, stavem, termínem, podklady, snapshotem, finalizací a XML. Lednové KH neuzavře Q1; přiznání nepotvrdí tři měsíční KH. Karty se posouvají samostatně a nevyžadují umělé chronologické pořadí přípravy.
- **Q11:** finalizace lednového KH chrání lednové vykazování včetně nových vložení a přesunů; neuzamkne zbytek kvartálu. Změna vyžaduje výslovné odemčení všech relevantních finalizovaných povinností, se zachováním historie a auditu. Žádné kaskádové automatické odemykání.
- **Q12:** zakázat nové čtvrtletní KH právnické osoby i přes přímé příkazy. Historické soubory zůstanou archivem, ne důkazem měsíčního dokončení. Automaticky je nerozdělovat, nepřeznačovat ani nevymýšlet měsíční zámky a exportní receipts.
- **Q13:** Administrator/SuperAdmin může po posouzení výslovně potvrdit absenci povinnosti KH s auditní stopou. Prázdná databáze takové potvrzení nevytvoří. Nové relevantní podklady zneplatní jeho aktuální platnost a vyžádají nové posouzení; historický záznam zůstane zachovaný. Není to podání ani odpověď na výzvu.
- **Q14:** pokud podklady u běžného přijatého dokladu neurčí KH měsíc jednoznačně, účetní jej potvrdí a vidí jej vedle čtvrtletí přiznání. Import Date není náhrada za měsíc uplatnění. Stejně řešit nejednoznačné legacy doklady před novou měsíční přípravou; historické výkazy neměnit.

### Daňová ověřovací brána

Před `ready-for-agent` u #277 je třeba doložit přípustné přiřazení běžného přijatého plnění do měsíce KH uvnitř potvrzeného kvartálu, vztah k nejdřívějším splněným podmínkám a potřebné ukládané údaje. Dosavadní primární podklady neověřují ani univerzální měsíc přijetí, ani automatické zařazení všech vstupů do posledního měsíce kvartálu. Lidské potvrzení nesmí být neomezená výjimka z daňových pravidel. Ověření je práce s fakty, nikoli další produktová otázka na vlastníka.

Měsíční výstupní a samovyměřovací povinnost se musí odvozovat podle příslušného režimu; rozhodnutí o vstupním nároku ji nesmí přesunout. #277 nerozšiřuje částečný nárok či oddělený Deferred Claim RC/EU z #221 ani režimy z #5. Dodatečné/opravné výkazy #6 zůstávají odložené.

Primární opory: [FS periodicita KH](https://financnisprava.gov.cz/cs/dane/dane/dan-z-pridane-hodnoty/kontrolni-hlaseni-dph/kdy), [FAQ VIII/4 a XV/1–2](https://financnisprava.gov.cz/cs/dane/dane/dan-z-pridane-hodnoty/kontrolni-hlaseni-dph/caste-dotazy-a-odpovedi), [metodika KH](https://financnisprava.gov.cz/assets/cs/prilohy/d-seznam-dani/Metodicka_informace_k_vyplneni_KH_20240101.pdf) a [metodická odpověď FS 118](https://app.fs.gov.cz/dotazy-verejnosti/dotaz/narok-na-odpocet-dane-z-prijate-faktury-%E2%80%93-prislusne-zdanovaci-obdobi-1663). Přesné otázky a zbývající příklady uvádí #277.

Oddělení povinností je záměrná změna dosavadního společného periodového vymezení VAT Report a Period Lock v GLOSSARY/ADR-0007. Součástí budoucí implementace #277 je aktualizace doménových dokumentů a upgrade akceptace; dnešní glossary se nepřepisuje, jako by nová funkce už existovala. Ochrany ADR-0005/0008 a staré archivní bytes zůstávají závazné.

## Ověřený stav předchozích QA dodávek

| Rozsah | Aktuální doklad dokončení |
| --- | --- |
| QA v1 | #73 uzavřeno po [PR #90](https://github.com/Thomisso/iVAT/pull/90), main 29. 10. 2026 |
| QA v2 | #91 uzavřeno po [PR #114](https://github.com/Thomisso/iVAT/pull/114), main 29. 10. 2026 |
| QA v3 | #115 uzavřeno po [PR #131](https://github.com/Thomisso/iVAT/pull/131), main 30. 10. 2026 |
| QA v4 | #133 uzavřeno po [PR #151](https://github.com/Thomisso/iVAT/pull/151), main 30. 10. 2026 |
| QA v5 | [PR #182](https://github.com/Thomisso/iVAT/pull/182) main 31. 10. 2026; samostatná provozní akceptace #169/#180 dokončená podle závěrečných komentářů, parent #159 uzavřený |
| QA v6 | Uzávěrka a přenos zbytku do QA v7 jsou v [QA v6](QA_v6.md) |
| QA v7 body 1, 2, 4, 7, 8 a 10–12 | #222 a implementační issues uzavřené [PR #243](https://github.com/Thomisso/iVAT/pull/243), main 8. 11. 2026; navazující PDF oprava #253 dodaná [PR #265](https://github.com/Thomisso/iVAT/pull/265), main 10. 11. 2026 |

Toto ověření stavu vychází z aktuálních GitHub issue/PR záznamů a čtení zdrojů; nepřidává nové runtime, vizuální nebo produkční testy. Historické ověřovací záznamy se zachovávají v rozsahu, v jakém byly skutečně provedené. Současné procesy používají [CLI pravidla a hranice důkazů](agents/cli-processes.md).

Mimo tuto dodávku zůstávají dříve odložené statistiky protistran, cross-company přehledy a ostatní backlog. Samostatné #158 a #275 z předchozí triage zůstávají připravené k implementaci; neoznačují se tím za dodané a nevznikají jejich duplicity.
