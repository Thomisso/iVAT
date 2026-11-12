# Zbývající rozhodnutí z QA

**Stav k 12. 11. 2026:** probíhá triage a příprava zadání, nikoli implementace. Vlastník výslovně potvrdil tento rozsah i všechna doporučení Q26–Q40 odpovědí „souhlasím se vším“. První rozsahy a vědomé odklady jsou schválené. Navazující Q41–Q49 čekají na odpovědi; readiness je uvedená po jednotlivých issues.

Všechny QA dokumenty jsou zahrnuté v [úplném inventáři](docs-open-items-audit.md). Dodané etapy, potvrzené [Q1–Q14](qa-v7-triage.md) a [Q15–Q25](qa-v7-quality-statistics.md) se neotevírají znovu. Zbývají převážně explicitní odklady, nikoli vady dokončených dodávek.

## Potvrzená rozhodnutí Q26 až Q40

Rozhodnutí vybírají první rozsah nebo vědomé ponechání v backlogu. Potvrzení směru se odlišuje od úplného implementačního zadání; konkrétní zbylé volby uvádí Q41–Q49.

| Rozhodnutí | Zdroj QA | Potvrzený rozsah nebo odklad |
| --- | --- | --- |
| Q26 Přehled napříč Companies | [QA v1 §18](QA_v1.md#18-mimo-aktuální-scope--backlog) | Rozpracovat pracovní přehled pouze Companies s Effective Access: pozornost, probíhající práce a stav DPH; finanční BI odděleně |
| Q27 Více fotografií jednoho dokladu | QA v1 §18 a §9.3 | Rozpracovat ruční seskupení a pořadí před zahájením dávky; originály zachovat, nepředpokládat automatické rozpoznání skupin |
| Q28 Ořez, perspektiva a kvalita | QA v1 §18 | Rozpracovat volitelné úpravy s potvrzeným náhledem a upozorněním na možnou nečitelnost; úpravy v odvozené kopii, bez tichého přepisu originálu a automatické blokace |
| Q29 Resumable upload | QA v1 §18 | Rozpracovat pokračování přerušeného přenosu od potvrzené části souboru na stejném zařízení po síťové chybě/reloadu; neslibovat přenos rozpracované práce mezi zařízeními |
| Q30 Zástupce a poradce | QA v1 §18 | Rozpracovat údaje zastupování v exportu; bez automatického podání a nového typu oprávnění. Odlišit od dnešních údajů podepisující osoby; přesný zákonný/XML kontrakt ověřit před readiness |
| Q31 Kalibrovaná nejistota | QA v1 §18 | Samostatný výzkumný backlog navázaný na skutečnou baseline #280/#281; nyní neměnit schvalování ani zavádět confidence práh. OCR alternativa zůstává #10 |
| Q32 Externí provozní alerty | [QA v2 Out of Scope](QA_v2.md#out-of-scope) | Rozpracovat opt-in e-mail pro SuperAdmina nad skutečnými incidenty, se seskupením a omezením opakování; SMS/webhooky později |
| Q33 Dlouhodobá historie incidentů | QA v2 Out of Scope | Ponechat odloženou; současný Audit Log zachovat. Není automatickým blockerem prvních externích alertů |
| Q34 Dark mode | QA v2 Out of Scope | Ponechat odložený, současný jednotný světlý vzhled zachovat |
| Q35 Billing, dokupování a provozní cenové odhady | QA v2 Out of Scope; [QA v3 Out of Scope](QA_v3.md#out-of-scope) | Ponechat #14 v backlogu bez výběru obchodního modelu či automatického dokupu; neplést s konkrétním benchmarkovým odhadem #280 |
| Q36 Integrace a automatické podání | QA v1 §18; QA v2 Out of Scope | Ponechat ingestion #7, příjem e-mailem #8 a širší ERP/podání odložené; další integraci vybírat podle konkrétního systému/procesu |
| Q37 Širší BI a analytika protistran | QA v1 §18; [QA v7 bod 2](QA_v7.md#2-adresář-dodavatelů-a-odběratelů) | Ponechat žebříčky, trendy a širší finanční analytiku mimo první #282 a pracovní přehled Q26 |
| Q38 Dvě další schopnosti QA v4 | [QA v4 Out of Scope](QA_v4.md#out-of-scope) | Přidávání souborů do již zahájené dávky a obnovu smazané Company ponechat mimo scope; při budoucím výběru dvě samostatná zadání, bez tiché reaktivace |
| Q39 Duplicita ovládání úloh | [QA v6 implementační záznam, Standards](QA_v6_implementation.md#standards) | Evidovat jako nízkoprioritní údržbový námět; existence připomínky není důkaz chyby ani nehotového QA6 |
| Q40 DNS provozní návaznost | [QA v6 bod g](QA_v6.md#g-výpadky-přihlášení-při-chybném-veřejném-dns-překladu-z-produkce) | Uchovat důkazní souhrn a připravit podklad pro podporu, bez odeslání. Nevymýšlet potvrzenou příčinu ani znovu implementovat dodanou interní cestu |

## Zadání a stav po potvrzení

| Issue nebo podklad | Stav | Návaznost |
| --- | --- | --- |
| [#283 Přehled Companies](https://github.com/Thomisso/iVAT/issues/283) | `needs-triage`, nativní blocker #278 | Q41–Q42; stejné definice práce a DPH jako firemní dashboard |
| [#284 Seskupení fotografií](https://github.com/Thomisso/iVAT/issues/284) | `ready-for-agent` | Jeden lidsky určený Document, ordered originály, AI evidence a úplný archiv; bez tichého AI přerozdělení |
| [#285 Úpravy fotografií](https://github.com/Thomisso/iVAT/issues/285) | `needs-triage` | Q43; obecná derivative/provenance dosud neexistuje |
| [#286 Byte-resume](https://github.com/Thomisso/iVAT/issues/286) | `needs-triage` | Q44; současná IndexedDB queue je užší schopnost |
| [#287 Zastupování v exportech](https://github.com/Thomisso/iVAT/issues/287) | `needs-triage` | Q45–Q46; samostatná větev zástupce, nikoli přejmenování oprávněné osoby |
| [#288 E-mailové provozní alerty](https://github.com/Thomisso/iVAT/issues/288) | `needs-triage` | Q47–Q49; vlastní durable epizody/dedupe a úzký worker přístup, bez oslabení MFA |
| [#289 Výzkum nejistoty](https://github.com/Thomisso/iVAT/issues/289) | `needs-triage`, odloženo | Až skutečně dokončená baseline; samotné #280/#281 nejsou naměřený výsledek |
| [#290 Duplicita ovládání](https://github.com/Thomisso/iVAT/issues/290) | `needs-triage`, nízkoprioritní údržba | Není zbývající funkční vada QA6 |
| [#291 Potvrzené odklady](https://github.com/Thomisso/iVAT/issues/291) | `needs-triage`, přehledový backlog | Q33–Q38 a zachovaná dřívější rozhodnutí; není obří implementační ticket |
| [DNS podklad](rosti-dns-support-draft.md) | Připraveno, neodesláno | Q40 splněné přípravou; neprokazuje současnou reprodukci ani příčinu resolveru |

## Navazující rozhodnutí Q41 až Q49

Toto jsou doporučení čekající na odpověď vlastníka. Již potvrzené Q26–Q40 se znovu neotevírají. Fyzický formát podkladů, tabulky, chunk size a jiné technické detaily rozhodne implementace při zachování akceptace.

| Otázka | Doporučení k potvrzení |
| --- | --- |
| Q41 Umístění přehledu Companies | Vždy dostupný samostatný přehled Firmy; zachovat dnešní návrat do zapamatované Company |
| Q42 Výběr a řazení Companies | Výchozí všechny přístupné Companies, hledání názvem a filtr Organization; s pozorností první, ostatní podle názvu; každá má vlastní DPH cyklus z #278, bez společného období |
| Q43 Kdy upravovat fotografii | Pouze v Upload Queue před zahájením dávky; již uložené zdroje zatím needitovat |
| Q44 Doba obnovitelnosti přenosu | Sedm dní od poslední serverem potvrzené části, pak nový celý přenos. Retence se týká dočasných dat, nikoli hotových originálů či libovolného mazání místního draftu |
| Q45 Podporované zastupování | První verze přímé podání a běžné varianty 4a/4b/4c: obecný zmocněnec, poradce/advokát FO a poradenská PO; zvláštní tituly později |
| Q46 Výchozí údaje zástupce | Jeden profil per Company s jednorázovou změnou či vypnutím pro konkrétní export, se současným vzorem oprávnění podacích defaults |
| Q47 Příjemci alertů | Každý SuperAdmin zapíná odběr na vlastní aktuální ověřený e-mail účtu; bez libovolných externích adres, se znovu ověřenou rolí před sendem |
| Q48 Závažnost a první alert | Kritické blokace konkrétní práce po pěti minutách trvání. Přechodná varování, 80% allowance a vyčerpání bez čekající práce zůstávají jen in-app |
| Q49 Připomínky a vyřešení | První alert, maximálně jedna připomínka za 24 hodin a jedna zpráva po vyřešení, jen pokud první alert skutečně odešel; bez acknowledge/umlčení v první verzi |

Běžné typy zastupování ověřené v aktuálních oficiálních popisech [DPHDP3](https://adisspr.mfcr.cz/dpr/adis/idpr_pub/epo2_info/popis_struktury_detail.faces?zkratka=DPHDP3) a [DPHKH1](https://adisspr.mfcr.cz/dpr/adis/idpr_pub/epo2_info/popis_struktury_detail.faces?zkratka=DPHKH1) z 11. 8. 2026. Q45 vybírá podporovaný produktový rozsah; uživatel neurčuje zákonná pravidla. XSD anotace obsahují podmíněné povinnosti, které samotná validace schématem plně nevynucuje.

## Zachovaná rozhodnutí a hranice

- Rozšířené daně #5/#221 zůstávají backlogem; úzký #275 je již vybraný rozsah. #3 a #6 vlastník výslovně odložil. Zpracování všech QA není automatické schválení všech nových režimů, korekcí a dalších výkazů.
- BYOK, výběr providera a zveřejnění modelů/credentials běžným Company Users či Administrators nejsou chybějící implementací. Platí platformové vlastnictví z QA v2 a ADR-0011. Veřejná registrace zůstává odložená; #158 je SuperAdmin provisioning.
- Period Locks, neměnné Versions, MFA, tenant izolace, historie exportů a rozlišení stažení od podání zůstávají pravidly. Scope exclusions v QA v3/v4 nejsou požadavky tyto ochrany obejít.
- Oficiální PDF a source highlights už byly dodané. Historické otevřené detaily QA3 a cloud/SMTP gates QA5 nejsou aktuálními nedodanými funkcemi.
- Stávající samostatné backlog issues #1, #2, #4, #9 a #11 zůstávají evidované; tento průchod nevytváří jejich duplicity. Širší vize SRS nad konkrétní QA není přidaným závazkem.

## Faktické a ověřovací návaznosti

[#277](https://github.com/Thomisso/iVAT/issues/277) dál čeká na právní oporu konkrétního měsíce běžného vstupu v měsíčním KH kvartální právnické osoby. [Doplňující rešerše a šest rozlišovacích příkladů](https://github.com/Thomisso/iVAT/issues/277#issuecomment-6836184444) zpřesňují bránu; uživatel nemá určovat právní fakta. Rozsudek NSS 7 Afs 317/2024-23 podporuje požadavek důkazu konkrétního měsíce, ne volbu univerzálního algoritmu. Stav zůstává `needs-triage`.

Ostatní meze důkazů — klientské/visual chování, externí OAuth, doručitelnost, skutečné finanční náklady a neobjasněná DNS příčina — zůstávají v [inventáři](docs-open-items-audit.md#konkrétní-nedodělek-kvality-a-mezery-v-důkazech). Nejde automaticky o nové vady a nejsou přeznačené na passing. Tento záznam nepřináší nové runtime důkazy, odeslanou externí zprávu ani produkční změnu.
