# QA v1: redesign hlavního pracovního toku

**Stav:** potvrzená produktová specifikace  
**Datum rozhodnutí:** 28. října 2026  
**Původ:** ruční QA současného MVP a navazující produktové grilování

## 1. Cíl

Tato etapa není souborem izolovaných kosmetických oprav. Jde o ucelený redesign hlavní cesty účetní v rámci jedné firmy:

1. založení a základní nastavení firmy;
2. pořízení nebo nahrání zdrojových souborů;
3. sledování Split/Extract zpracování;
4. kontrola a schválení vzniklých dokladů;
5. příprava zdaňovacího období;
6. vytvoření přiznání k DPH a kontrolního hlášení;
7. vytvoření pracovních a finálních exportů.

Primárním uživatelem je účetní nebo jiný odpovědný pracovník, který tuto cestu opakuje pro jednu či více firem. Aplikace se neoptimalizuje podle potřeb platformního administrátora ani jako pasivní archiv dokladů.

## 2. Původní QA nálezy

Původní ruční QA identifikovalo tyto problémy:

- Nastavení firmy neobsahuje údaje potřebné pro EPO export. Hodnoty jako finanční úřad, identita fyzické osoby, oprávněná osoba a kontakt se musí opakovaně zadávat až při exportu; telefon chybí úplně.
- Hláška o dokončení dávky neříká, kolik dokladů vzniklo, co uspělo, co selhalo ani kam pokračovat.
- Automatické určení směru neumí bezpečně rozpoznat běžnou přijatou účtenku, na které není uveden odběratel.
- Hlavní navigace, uživatelská nabídka a nastavení míchají pracovní a administrační odkazy bez srozumitelné hierarchie.
- Výchozí stránka je přetížená kombinací dokladů, uploadu, zdrojových souborů a nastavení AI. Pohledy Přijaté/Vydané jsou pouze varianty stejné nepřehledné tabulky.
- Chybí skutečný pracovní dashboard.
- Zpracování souborů nemá srozumitelný průběh ani předání do kontroly.
- Vizuální podoba je fádní, generická a nepůsobí jako promyšlený profesionální produkt.

## 3. Produktové principy

### 3.1 Práce před administrací

Primární navigace kopíruje pracovní postup. Administrace, bezpečnost, AI konfigurace a platformní nástroje nesmějí přebírat běžnou pracovní plochu.

### 3.2 Aktivní firma je pracovní kontext

Uživatel vždy pracuje v jedné zvolené firmě. Přepnutí firmy změní celý pracovní prostor. Dashboard napříč firmami není součástí této etapy.

Po přihlášení se otevře poslední používaná firma. Uživatel s jedinou firmou do ní vstoupí přímo. Pokud má více firem a žádná poslední není známá, aplikace nabídne jejich volbu; nesmí svévolně vybrat první řádek databáze.

### 3.3 Stav musí vést k akci

Počty, badge, notifikace a grafické prvky musí vysvětlovat, co se děje a jaký je další krok. Dekorativní grafy bez návazné akce do pracovního dashboardu nepatří.

### 3.4 AI návrh není účetní fakt

AI zpracování může být vizuálně výrazné, ale nesmí předstírat známé procento průběhu, přesnost nebo vazbu pole na místo v dokumentu, pokud tato data backend neposkytuje. Účetní rozhodnutí zůstává lidské.

### 3.5 Snapshot a živá data jsou různé věci

Živá připravenost období, uložený návrh reportu a konkrétní exportní artefakt musí být v UI i datovém modelu výslovně oddělené.

## 4. Informační architektura

### 4.1 Hlavní firemní navigace

1. **Přehled**
2. **Nahrání**
3. **Doklady**
4. **DPH**
5. **Nastavení**

Pohledy Přijaté a Vydané nejsou samostatné hlavní sekce. Jsou uloženými pohledy nebo filtry uvnitř Dokladů.

### 4.2 Administrativní úrovně

- **Firma:** profil, exportní údaje, periodicita, zpracování a přístupy.
- **Organizace:** uživatelé organizace, AI konfigurace, využití a audit.
- **Můj účet:** zabezpečení, jazyk a odhlášení.
- **Platforma:** pouze SuperAdmin.

Uživatelská nabídka nesmí být směsí všech dostupných administračních odkazů. Musí obsahovat především účet, jazyk, zabezpečení a odhlášení; ostatní funkce patří do strukturovaného Nastavení.

### 4.3 Terminologie uživatelů

Ve všech uživatelsky viditelných textech se „Členové“ přejmenují na **Uživatelé**:

- Uživatelé;
- Pozvat uživatele;
- Odebrat přístup;
- Běžný uživatel jako název role.

Interní doménový objekt `Membership` se nepřejmenovává. Nadále vyjadřuje vztah identity `User` k organizaci nebo firmě a nese roli.

Obrazovka firmy musí ukázat všechny osoby s efektivním přístupem, včetně administrátorů organizace. Přímá přiřazení a zděděný přístup musí být rozlišitelné. Čekající pozvánky budou samostatná část.

## 5. Přehled firmy

Přehled je operační centrum firmy, nikoliv přejmenovaná tabulka všech dokladů. Obsahuje tři zóny:

### 5.1 Vyžaduje pozornost

- doklady ke kontrole;
- technicky selhané zdrojové soubory a doklady;
- doklady s validačními nálezy;
- neúplné nastavení firmy;
- DPH období s blokery nebo zastaralým návrhem.

### 5.2 Právě probíhá

- aktivní uploady;
- Split/Extract zpracování;
- dávky čekající na nastavení AI.

### 5.3 DPH období

- nejstarší období, které stále vyžaduje dokončení;
- stav uloženého návrhu a jeho aktuálnost;
- počet blockerů;
- finalizace a zámek.

Každý údaj je odkazem na konkrétní filtrovanou pracovní plochu. Nejstarší nedokončené období má přednost před slepým otevřením aktuálního kalendářního měsíce nebo kvartálu.

## 6. Onboarding a připravenost firmy

### 6.1 Wizard

Nová firma vzniká přes přerušitelný wizard:

1. identita firmy a ARES;
2. strukturovaná adresa a typ osoby;
3. periodicita DPH;
4. finanční úřad a oprávněná osoba;
5. kontaktní e-mail a telefon;
6. AI provider a souhlas se zpracováním;
7. pozvání dalších uživatelů.

Každý dokončený krok rovnou ukládá platné nastavení. Wizard proto není druhým zdrojem rozpracovaných dat. Lze jej kdykoliv opustit a pokračovat přes checklist na Přehledu nebo přes Nastavení.

Na konci wizard ukáže, co je dokončeno, co bylo přeskočeno a které funkce tím zůstávají omezené.

### 6.2 Povinné a odložitelné údaje

Identita daňového subjektu musí být kompletní před vytvořením snapshotu DPH reportu:

- typ osoby;
- DIČ;
- obchodní název právnické osoby nebo jméno a příjmení fyzické osoby;
- strukturovaná česká adresa.

Tyto hodnoty nelze změnit pouze v exportním dialogu.

Následující podací výchozí hodnoty lze ve wizardu přeskočit a doplnit později v Nastavení nebo pro konkrétní export:

- finanční úřad;
- oprávněná osoba právnické osoby;
- kontaktní e-mail;
- telefon.

Telefon a e-mail jsou nepovinné a jejich absence sama neblokuje export. Finanční úřad a podmíněné údaje oprávněné osoby musí být doplněné v okamžiku vytvoření konkrétního XML.

Pokud uživatel vyplní relevantní kroky wizardu, běžný export už nic z toho znovu nevyžaduje. Zobrazí jen rekapitulaci, dnešní datum vyhotovení a možnost „Upravit pro tento export“.

### 6.3 AI ve wizardu

Wizard nabídne tři výsledky:

- platformní provider povolený organizaci SuperAdminem;
- vlastní podporovaný provider a klíč;
- AI zatím nepovolit.

Přeskočení vlastního klíče nevylučuje použití platformního providera. Uživatel ale musí před prvním odesláním dat výslovně potvrdit konkrétního providera a region. Pokud je dostupných více providerů, žádný se nesmí zvolit potichu.

Doklady lze nahrát i před zapnutím AI. Dávka se označí „Čeká na nastavení AI“, vysvětlí důvod a nabídne administrátorovi přímou akci. Po dokončení konfigurace se zpracování automaticky rozběhne.

## 7. Nastavení firmy

Nastavení nebude jeden dlouhý formulář. Bude rozdělené na:

1. **Profil firmy:** typ osoby, IČO, DIČ, název/jména, strukturovaná adresa a periodicita.
2. **Export a finanční úřad:** FÚ, výchozí oprávněná osoba, kontakt a stav exportní připravenosti.
3. **Zpracování dokladů:** AI provider, klíč, region, souhlas a související volby.
4. **Uživatelé a přístupy.**
5. **Nebezpečná zóna:** export všech dat a odstranění firmy.

Každá část se ukládá samostatně a obsahuje vlastní validační stav.

## 8. Firemní identita a EPO data

### 8.1 Strukturovaná adresa

Adresa firmy se ukládá minimálně jako:

- název ulice nebo části obce;
- číslo popisné;
- volitelné číslo orientační včetně písmene;
- obec;
- PSČ.

ARES předvyplňuje přímo strukturovaná pole. EPO serializer nesmí zpětně hádat čísla z jednoho textového řetězce.

Registrovaná adresa se nesmí tiše zkracovat podle technických limitů EPO. Pokud některá její část překročí limit schématu, nastavení nabídne samostatnou exportní podobu adresy, vysvětlí důvod a vyžádá potvrzení uživatele.

Současná databáze obsahuje pouze dummy data a může být resetována. Není potřeba parsovat ani migrovat stávající textové adresy.

### 8.2 Výchozí exportní údaje

- finanční úřad je firemní výchozí hodnota s možností změny pro konkrétní export;
- jméno a příjmení fyzické osoby patří do identity firmy a snapshotu;
- výchozí oprávněná osoba právnické osoby je podací údaj a může se pro konkrétní export změnit;
- e-mail je nepovinný kontakt firmy;
- telefon je nepovinný kontakt firmy a mapuje se do `c_telef`;
- datum vyhotovení je údaj konkrétního exportu a standardně se předvyplní aktuálním datem.

Kontakt přihlášeného uživatele lze výslovně nabídnout jako počáteční hodnotu, nikdy jej ale nelze tiše vložit do EPO výstupu. V této etapě se podporuje pouze přímé podání, nikoliv podání prostřednictvím zástupce nebo daňového poradce.

## 9. Nahrání a zpracování

### 9.1 Samostatná pracovní plocha

Sekce Nahrání obsahuje:

- drop zone a výběr souborů;
- právě nahrávané položky;
- průběh Split/Extract;
- počet vzniklých dokladů;
- úspěchy, varování a chyby;
- akce retry na konkrétní položce;
- historii dávek.

Hláška „Zpracování dávky skončilo pro 1 zdrojový soubor“ se nahradí konkrétním výsledkem dávky. Globální oznámení musí být stručné, odkazující a označitelné jako přečtené.

Po dokončení dávky zůstane uživatel v Nahrání a dostane výraznou akci, například „Zkontrolovat 8 dokladů“. Výsledek oddělí doklady připravené ke kontrole, technická selhání a stále probíhající položky. Jeden Source File může vytvořit více Documents a UI tuto hranici nesmí skrývat.

### 9.2 Pravdivá vizualizace AI

Zpracování může použít výraznou animaci dokumentu nebo účtenky a skutečné fáze:

`Nahráno → Rozpoznávání dokladů → Čtení údajů pomocí AI → Kontrola výsledku`

Nesmí ukazovat vymyšlené procento, confidence nebo zvýrazňovat konkrétní hodnotu jako právě čtenou, pokud backend tuto informaci nemá. Omezený pohyb se respektuje.

### 9.3 Mobilní pořízení

Mobil je primárně určen k rychlému pořízení a nahrání dokladů. Ostatní funkce zůstávají nouzově dostupné, ale export XML ani rozsáhlé review nejsou hlavním mobilním cílem.

Na mobilu bude samostatná primární akce **Vyfotit doklad** se zadním fotoaparátem. Pro tuto etapu platí:

- jedna fotografie je jeden Source File;
- před odesláním se zobrazí náhled;
- uživatel může fotografii odstranit nebo pořídit znovu;
- HEIC/HEIF je podporovaný mobilní vstup;
- původní soubor se zachová pro audit;
- pro náhled a AI může vzniknout normalizovaná JPEG derivace;
- krátké síťové selhání se jednou automaticky zopakuje;
- chyba a ruční retry jsou na konkrétní fotografii;
- rozpracovaná dávka se neztratí při běžné navigaci.

### 9.4 Recovery akce

- selhaný Split lze opakovat v Nahrání;
- selhanou Extraction lze opakovat v Nahrání i na detailu dokladu;
- oprava rozdělení stran je výjimečný nástroj na detailu zdrojového souboru;
- uzamčené období vždy vysvětlí, proč recovery nebo editace není možná.

Oprava rozdělení není povinný mezikrok každé kontroly.

## 10. Doklady a review

### 10.1 Pracovní fronta

Výchozím pohledem sekce Doklady je **Ke kontrole**, nikoliv Všechny. Uložené pohledy minimálně:

- Ke kontrole;
- S chybou;
- Přijaté;
- Vydané;
- Schválené;
- Všechny.

Přijaté a Vydané používají stejný datový model a liší se filtrem. Pokud pohled určuje směr, UI nenabízí redundantní filtr Směr.

### 10.2 Souvislá kontrola

Review obrazovka zachová originál vedle dat na desktopu a nabídne:

- pozici ve frontě, například „3 z 12“;
- předchozí a další doklad;
- automatický přechod na další položku po schválení nebo zamítnutí;
- návrat do původního filtrovaného seznamu se zachovaným stavem;
- jasný odkaz na Source File a nástroje opravy rozdělení.

Na mobilu bude detail použitelný jako nouzová platforma, nikoliv optimalizovaný pro dlouhé účetní review.

### 10.3 Automatické určení směru účtenky

Stávající shoda identity firmy se supplier/customer zůstává primárním pravidlem. Bezpečný fallback se použije pouze pro účtenku nebo zjednodušený daňový doklad:

- dodavatel je identifikovaný jako jiný subjekt;
- naše firma nevystupuje jako dodavatel;
- naše firma není současně identifikovaná na druhé straně.

Pak lze předvyplnit směr **přijatý**. Pokud nelze identifikovat vůbec žádnou stranu, směr zůstane neurčený a vyžádá si kontrolu. Automatický návrh nikdy neznamená automatické schválení dokladu.

### 10.4 Confidence a source evidence

První verze nepředstírá confidence ani přesné field-level zvýraznění. Reální provideři dnes takový spolehlivý kontrakt neposkytují a extraction payload neobsahuje source regions.

Review proto používá originál vedle formuláře, validační nálezy a lidské potvrzení. Rozšíření o source evidence a confidence patří do backlogu.

## 11. DPH období

### 11.1 Přehled období

Vstupem do DPH je seznam platných zdaňovacích období podle historie periodicity firmy. Období má viditelný stav, například:

- Vyžaduje pozornost;
- Připraveno k výpočtu;
- Návrh je aktuální;
- Je potřeba přepočítat;
- Finalizováno.

Neexistují dva textové inputy pro stejné období. Detail má jeden validní selector a navigaci předchozí/další období.

### 11.2 Živá připravenost a uložený snapshot

Detail období současně zobrazuje:

- aktuální připravenost podle živých dokladů;
- naposledy uložený návrh;
- aktuálnost návrhu vůči živým datům;
- stav finalizace a zámku.

Pouhé otevření stránky nesmí uložený návrh přepsat. Změna relevantního dokladu označí návrh jako zastaralý a před finalizací vyžaduje přepočet.

### 11.3 Blokery a upozornění

Finalizaci blokuje zejména:

- relevantní doklad čekající na kontrolu;
- technicky selhaný doklad;
- chybějící směr, datum, kurz nebo výpočetní údaj;
- zastaralý návrh;
- neúplná povinná identita firmy;
- chybějící údaj nutný pro vytvoření požadovaného výstupu.

Pouhé upozornění, například možná duplicita nebo informační nález registru, finalizaci neblokuje. Zamítnuté doklady jsou vědomě vyřešené, ale zůstávají viditelné v souhrnu finalizace.

### 11.4 Samostatné obrazovky

V rámci vybraného období existují samostatné routy/obrazovky:

1. **Zpracování:** živá připravenost, doklady, blokery a vytvoření/přepočet návrhu.
2. **Přiznání k DPH:** řádky, částky, drill-down, PDF a DPHDP3 XML.
3. **Kontrolní hlášení:** sekce, zdrojové doklady a DPHKH1 XML.
4. **Exporty:** společná historie artefaktů období.

Přiznání a KH nejsou globální položky hlavního sidebaru; vždy patří konkrétní firmě a období. Zpřístupní se po vytvoření návrhu.

Aktuální kontrolní Excel patří na obrazovku Zpracování a výslovně uvádí, že vznikl z živých dat. PDF a XML patří uloženému snapshotu a vždy zobrazují jeho verzi/čas.

## 12. Finalizace a exporty

### 12.1 Význam finalizace

Finalizace zamyká doklady a vypočtený snapshot období. Neznamená tvrzení, že iVAT soubor skutečně podal finanční správě.

Finalizace i odemknutí jsou viditelné v historii s uživatelem, časem a důvodem. Odemknutí vyžaduje potvrzení a krátké zdůvodnění. Starší exportní artefakty ani auditní stopa se nemažou.

Pouze Administrator může finalizovat a odemknout. Finální XML mohou stáhnout všichni uživatelé firmy s přístupem.

### 12.2 Pracovní a finální XML

XML lze vytvořit i před finalizací, ale musí být jednoznačně označené jako pracovní:

- výrazné upozornění před stažením;
- název souboru s prefixem, například `DRAFT_DPHDP3_2026-10.xml`;
- stav „Pracovní export“ v historii.

Po finalizaci lze vytvořit novou neměnnou verzi se stavem „Finální export“. Do samotného XML se nevkládá neplatný vodoznak; pracovní i finální soubor musí projít příslušným EPO XSD.

### 12.3 Exportní artefakt

Každý úspěšný XML export je append-only záznam a uchovává minimálně:

- vazbu na konkrétní VAT Report snapshot;
- DPHDP3 nebo DPHKH1;
- pracovní nebo finální stav;
- úplné resolved exportní údaje;
- autora a čas;
- skutečné bytes souboru;
- SHA-256;
- verzi EPO schématu a serializeru.

Pouhý hash nestačí k reprodukci po budoucí změně serializeru nebo XSD.

Přiznání a KH mají vlastní explicitní exportní akce; dropdown formátu se nepoužije. Společná historie exportů zůstane dostupná na úrovni období.

### 12.4 Export všech dat firmy

ZIP označený jako export všech dat musí obsahovat také:

- uložené VAT Reports;
- historii finalizací/odemknutí;
- exportní metadata;
- skutečné exportní artefakty.

## 13. Vizuální a responzivní návrh

### 13.1 Charakter

Výsledkem má být moderní, přehledný a vizuálně kvalitní profesionální pracovní nástroj. Nemá být ani fádní admin šablona, ani dekorativní marketingový dashboard.

Požadavky:

- výrazná, ale účelná vizualizace nahrávání a AI zpracování;
- jasná hierarchie, kvalitní typografie a dobře čitelné finanční údaje;
- kompaktní tabulky na desktopu;
- grafické prvky pro stav, průběh a prioritu;
- barva nikdy není jediným nositelem významu;
- omezené používání generických karet a panelů;
- žádné falešné metriky nebo dekorativní grafy bez akce.

Stávající metafora „AI zvýrazňuje markerem, člověk potvrzuje inkoustem“ je výchozí inspirace, nikoliv závazné omezení. Vizuální průzkum může současné tokeny nebo styl opustit, pokud najde soudržnější řešení.

Redesign zahrnuje vlastní jednoduchý wordmark/logo, favicon a konzistentní identitu. Současný žlutý obdélník ani výchozí favicon nejsou značka, kterou je nutné zachovat.

### 13.2 Prototypovací gate

Před plošným přepisem rout se ověří soudržný vizuální směr alespoň na:

- firemním Přehledu;
- mobilním Nahrání a AI zpracování;
- desktopové frontě a review dokladu;
- zpracování DPH období;
- samostatném Přiznání nebo KH.

Teprve z potvrzeného systému se odvodí zbytek aplikace.

### 13.3 Responzivita a přístupnost

Desktop je hlavní platforma účetního zpracování. Mobil je primárně určen k pořízení a nahrání dokladů, ale ostatní funkce se nesmějí uměle blokovat podle zařízení.

Každý stav používá text i ikonu. Ovládání musí fungovat klávesnicí, mít viditelný focus, dostatečný kontrast a smysluplné landmarky/nadpisy. Mobilní navigace musí pracovat s focusem a Escape; aplikace doplní skip link. Animace respektují `prefers-reduced-motion`.

Široká desktopová tabulka se na mobilu nesmí pouze zmenšit. Klíčové mobilní workflow používá prioritizované sloupce nebo kartu/detail a zachová přístup k méně důležitým údajům.

## 14. Lokalizace

Všechny nové obrazovky, stavy, chyby a notifikace vzniknou současně česky a anglicky. Primární návrh textů je český.

- pracovní UI a kontrolní Excel respektují zvolený jazyk;
- technická struktura EPO XML se řídí schématem;
- budoucí věrná PDF podoba českého přiznání bude vždy česky;
- daňové datumové a číselné formáty zůstávají české i v anglickém UI, jejich význam ale musí být vysvětlen anglicky;
- dlouhé české texty jsou součástí responzivní kontroly.

## 15. Greenfield datový přechod

Aplikace zatím nemá skutečné uživatele ani produkční historii. Současná databáze obsahuje pouze dummy data.

Proto platí:

- není nutná kompatibilita starých rout;
- není nutná podpora V1 VAT Report snapshotů;
- není nutný backfill starých textových adres;
- nové schéma může vzniknout přímo v cílové podobě;
- vývojová a testovací data se mohou vytvořit znovu;
- nový design může přímo nahradit starý bez feature flagu.

Reset se při implementaci provádí pouze v izolovaném worktree a jeho vlastním Supabase stacku. Hlavní checkout a databáze používané člověkem se neresetují.

SuperAdmin se nebude zachovávat přenosem dummy databáze. Vznikne reprodukovatelný localhost-only bootstrap příkaz, který bezpečně vytvoří nebo povýší zadaný účet. Osobní e-mail, heslo ani service key se necommitují. MFA se po resetu dokončí znovu v UI.

## 16. Akceptační scénáře

### 16.1 Nová firma

1. Administrator založí firmu přes wizard a ARES.
2. Povinná identita a strukturovaná adresa jsou validní.
3. Volitelné podací a kontaktní údaje lze přeskočit.
4. Přehled ukáže přesný checklist zbývajících kroků.
5. Dokončený wizard způsobí, že běžný export už neopakuje stejné vstupy.

### 16.2 AI konfigurace

1. Wizard nabídne platformní providery povolené SuperAdminem a BYOK.
2. Bez výslovného souhlasu s konkrétním providerem/regionem se žádná data neodešlou.
3. Upload před konfigurací AI uloží originál a jasně čeká na nastavení.
4. Po povolení AI se čekající práce automaticky rozběhne.

### 16.3 Mobilní pořízení

1. Uživatel na telefonu zvolí Vyfotit doklad.
2. Uvidí náhled, může snímek odstranit nebo zopakovat.
3. JPEG/PNG i HEIC/HEIF jsou přijatelné; originál zůstane zachovaný.
4. Chyba sítě je vidět u konkrétní fotografie a lze ji zopakovat.
5. Po uploadu je dávka dohledatelná a ukazuje skutečné fáze zpracování.

### 16.4 Dávka a kontrola

1. Jedna dávka může obsahovat více Source Files a vytvořit více Documents.
2. Částečný úspěch ukáže samostatně doklady ke kontrole a selhání.
3. CTA otevře frontu vytvořených dokladů.
4. Review zachová pořadí a po rozhodnutí nabídne další doklad.
5. Retry je dostupné přímo u selhané položky.

### 16.5 Směr účtenky

1. Firma identifikovaná jako supplier znamená vydaný doklad.
2. Firma identifikovaná jako customer znamená přijatý doklad.
3. Účtenka s identifikovaným cizím dodavatelem a bez identity firmy může bezpečně navrhnout přijatý směr.
4. Doklad bez identifikovatelné strany zůstane neurčený a nelze jej bez lidské kontroly schválit.

### 16.6 DPH a export

1. Přehled období ukáže nejstarší nedokončené období.
2. Live readiness a uložený snapshot jsou viditelně oddělené.
3. Změna dokladu označí návrh jako zastaralý.
4. Blocker zabrání finalizaci, warning nikoliv.
5. Přiznání a KH se otevřou na samostatných obrazovkách.
6. Pracovní XML má výrazný draft stav a `DRAFT_` filename.
7. Finalizace vyžaduje Administratora a aktuální návrh.
8. Finální XML je nový neměnný artefakt, nikoliv přejmenování pracovního souboru.
9. Odemknutí vyžaduje důvod a zachová historii i staré exporty.

### 16.7 Role a přístupy

1. Běžný uživatel vidí pracovní části a může stáhnout dostupné exporty.
2. Administrator spravuje firmu, uživatele, finalizaci a odemknutí.
3. Organization Administrator je viditelný jako zděděný přístup ve všech firmách.
4. SuperAdmin nástroje zůstávají oddělené a vyžadují MFA.

## 17. Quality gates

Přepnutí na nový design vyžaduje:

- stejné lokalizační klíče a bezchybný render v češtině i angličtině;
- admin i běžnou uživatelskou roli;
- desktopové a mobilní scénáře;
- axe bez serious/critical nálezů na hlavní matici obrazovek;
- keyboard-only průchod, skip link a správu focusu v menu;
- reflow bez page-level horizontálního overflow při 320 CSS px a vysokém zoomu;
- stavy empty/loading/processing/error/locked;
- vizuální regresi kritických shell/list/detail/DPH/settings obrazovek;
- business E2E `upload → review → DPH → draft XML → finalizace → finální XML`;
- `npm run test:serial`, `npm run typecheck`, `npm run lint`, `npm run build` a relevantní runtime/E2E kontroly na integrační větvi.

## 18. Mimo aktuální scope / backlog

- dashboard napříč firmami;
- skládání více fotografií do jednoho vícestránkového dokladu;
- automatický ořez, korekce perspektivy a hodnocení kvality fotografie;
- plně resumable/chunkovaný upload;
- věrná PDF podoba oficiálního formuláře přiznání;
- podání přes zástupce nebo daňového poradce;
- source evidence a field-level zvýrazňování v PDF/image/Excel;
- výzkumný spike na providery nebo API, které umějí vracet pravděpodobnosti či kalibrovanou nejistotu, včetně přístupů typu Decision API;
- workflow založené na confidence, dokud není prokázáno, že skóre koreluje se správností účetního údaje;
- nové daňové režimy, účetní integrace, BI analytika a automatické podání finanční správě.

## 19. Návrh rozdělení implementace

Níže je návrh ticketů. GitHub Issues se podle něj založí až po samostatné kontrole této specifikace.

### T1 — Vizuální prototyp a cílový design systém

**Výstup:** reprezentativní desktop/mobile obrazovky, navigační shell, motion principy, wordmark/logo, favicon a cílové tokeny/primitives.  
**Acceptance:** prototyp pokrývá Přehled, Nahrání, frontu/review a jednu DPH výstupní obrazovku; doloží responsive a reduced-motion variantu.  
**Focused checks:** kontrast, keyboard/focus návrh, dlouhá česká copy, 360/720/1024/1440 px.

### T2 — Greenfield datový základ a lokální bootstrap

**Závisí na:** T1 pro pojmenování veřejných stavů.  
**Výstup:** cílové Company/export/report schéma, strukturovaná adresa, exportní artefakty, reset dummy dat, opravený seed kontrakt a localhost-only SuperAdmin bootstrap.  
**Acceptance:** čistý reset vytvoří funkční schéma; SuperAdmin lze reprodukovatelně vytvořit a následně enrollovat MFA; generated DB types jsou aktuální.  
**Focused tests:** companies, ARES, VAT reports, EPO XML, company deletion/export, MFA/platform authorization.

### T3 — App shell, navigace, wizard a Nastavení

**Závisí na:** T1, T2.  
**Výstup:** nová IA, poslední firma, přepínač firmy, onboarding wizard, checklist, strukturované Nastavení a Uživatelé/přístupy.  
**Acceptance:** admin i běžný uživatel vidí správné sekce; zděděné přístupy a invitations jsou srozumitelné; wizard lze přerušit a obnovit.  
**Focused tests:** auth/signup, companies, memberships, organization/platform AI, navigation component tests.

### T4 — Nahrání, mobilní pořízení a stav dávky

**Závisí na:** T1–T3.  
**Výstup:** nová plocha Nahrání, pravdivé fáze, batch výsledky, čekání na AI, kamera, preview/retake, HEIC derivace a retry.  
**Acceptance:** částečný úspěch i selhání vedou ke konkrétní akci; originál zůstane zachovaný; mobilní flow funguje bez horizontálního overflow.  
**Focused tests:** source files, upload batches, processing, upload policy, mobile browser journey.

### T5 — Doklady, pracovní fronta a souvislé review

**Závisí na:** T1, T3, kontraktu T4.  
**Výstup:** uložené pohledy, akční fronta, next/previous review, návrat do filtrů, retry v kontextu a bezpečný receipt-direction fallback.  
**Acceptance:** fronta se po každém rozhodnutí aktualizuje; směr se nikdy nedohaduje bez identifikovatelné strany; locked period vysvětluje omezení.  
**Focused tests:** documents, direction detection, review, validation, duplicate warnings, split correction.

### T6 — DPH období, live readiness a finalizace

**Závisí na:** T2, T3, T5.  
**Výstup:** přehled období, read-only readiness, stavy snapshotu, freshness, blocker policy, oddělené obrazovky a historie lock/unlock.  
**Acceptance:** zastaralý návrh nelze finalizovat; warnings neblokují; rejected documents zůstávají viditelné; admin/user permissions odpovídají specifikaci.  
**Focused tests:** VAT rules, VAT reports, reporting periods, period lock, role permissions.

### T7 — Přiznání, KH a verzované exporty

**Závisí na:** T2, T6.  
**Výstup:** samostatné Přiznání a KH, explicitní exportní karty, pracovní/finální XML, immutable artifacts, exportní historie a úplný archiv firmy.  
**Acceptance:** draft a final nelze zaměnit v UI ani filename; oba projdou XSD; uložené bytes/hash/details přesně odpovídají staženému souboru.  
**Focused tests:** EPO export details/XML, PDF preview, reporting-period Excel, company data export, artifact authorization.

### T8 — Integrační průchod, lokalizace a přístupnost

**Závisí na:** T1–T7.  
**Výstup:** sjednocená copy, cs/en parity, a11y automatizace, visual regression a durable E2E journeys.  
**Acceptance:** splněny všechny Quality gates v sekci 17; kombinovaný diff projde review proti celé specifikaci.  
**Focused checks:** rozšířený Playwright matrix, axe, visual snapshots a plný integrační test budget.

## 20. Multi-ticket workflow

Implementace použije integrační větev a samostatný worktree pro každý ticket. Každý worktree používá vlastní Supabase stack a spouští pouze zaměřené testy, typecheck a lint. Před merge ticketu proběhne nezávislé review proti ticketu i `CODING_STANDARDS.md`.

Po sloučení všech ticketů se ticketové Supabase stacky zastaví a na integrační větvi proběhne plný test budget podle `docs/agents/implementation-workflow.md`. Teprve poté se draft integračního PR označí jako připravený.
