# QA v6: vytěžování, revize dokladů a správa přístupů

**Datum zápisu:** 31. 10. 2026
**Stav:** `grill-with-docs`, `to-spec` i `to-tickets` dokončeny pro Bugs / Improvements a–g. Uživatel potvrdil společné porozumění v Q22, testovací hranice specifikace i rozdělení ticketů. Specifikace [#185](https://github.com/Thomisso/iVAT/issues/185) má 12 podřízených issues #186–#197 s označením `ready-for-agent` a ověřenými nativními závislostmi. Sekce Features nebyla součástí tohoto rozpracování.
**Rozsah:** 8 funkcí a 7 chyb nebo zlepšení. Identifikátory zachovávají původní číslování a označení nálezů.
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

- PDF náhled přiznání zpracovat podle reálných PDF formulářů.
- V náhledu zobrazit také miniaturu s možností kliknutím stáhnout PDF.
- Miniatura má již obsahovat vyplněné údaje první stránky, zejména údaje firmy.

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
