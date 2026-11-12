# Zbývající rozhodnutí z QA

**Stav k 12. 11. 2026:** probíhá triage a příprava zadání, nikoli implementace. Vlastník tento rozsah výslovně potvrdil. Níže uvedená doporučení Q26–Q40 čekají na jeho odpovědi; nejsou schválenými funkcemi ani issues připravenými pro agenta.

Všechny QA dokumenty jsou zahrnuté v [úplném inventáři](docs-open-items-audit.md). Dodané etapy, potvrzené [Q1–Q14](qa-v7-triage.md) a [Q15–Q25](qa-v7-quality-statistics.md) se neotevírají znovu. Zbývají převážně explicitní odklady, nikoli vady dokončených dodávek.

## Celá aktuální sada rozhodnutí

Každá otázka vybírá první rozsah nebo vědomé ponechání v backlogu. Podrobnosti závislé na tomto výběru se vyřeší až po odpovědi. Souhlas s prvním rozsahem sám nepředstavuje hotovou implementační specifikaci.

| Otázka | Zdroj QA | Doporučení k potvrzení |
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

## Zachovaná rozhodnutí a hranice

- Rozšířené daně #5/#221 zůstávají backlogem; úzký #275 je již vybraný rozsah. #3 a #6 vlastník výslovně odložil. Zpracování všech QA není automatické schválení všech nových režimů, korekcí a dalších výkazů.
- BYOK, výběr providera a zveřejnění modelů/credentials běžným Company Users či Administrators nejsou chybějící implementací. Platí platformové vlastnictví z QA v2 a ADR-0011. Veřejná registrace zůstává odložená; #158 je SuperAdmin provisioning.
- Period Locks, neměnné Versions, MFA, tenant izolace, historie exportů a rozlišení stažení od podání zůstávají pravidly. Scope exclusions v QA v3/v4 nejsou požadavky tyto ochrany obejít.
- Oficiální PDF a source highlights už byly dodané. Historické otevřené detaily QA3 a cloud/SMTP gates QA5 nejsou aktuálními nedodanými funkcemi.
- Stávající samostatné backlog issues #1, #2, #4, #9 a #11 zůstávají evidované; tento průchod nevytváří jejich duplicity. Širší vize SRS nad konkrétní QA není přidaným závazkem.

## Faktické a ověřovací návaznosti

[#277](https://github.com/Thomisso/iVAT/issues/277) dál čeká na právní oporu konkrétního měsíce běžného vstupu v měsíčním KH kvartální právnické osoby. [Doplňující rešerše a šest rozlišovacích příkladů](https://github.com/Thomisso/iVAT/issues/277#issuecomment-6836184444) zpřesňují bránu; uživatel nemá určovat právní fakta. Rozsudek NSS 7 Afs 317/2024-23 podporuje požadavek důkazu konkrétního měsíce, ne volbu univerzálního algoritmu. Stav zůstává `needs-triage`.

Ostatní meze důkazů — klientské/visual chování, externí OAuth, doručitelnost, skutečné finanční náklady a neobjasněná DNS příčina — zůstávají v [inventáři](docs-open-items-audit.md#konkrétní-nedodělek-kvality-a-mezery-v-důkazech). Nejde automaticky o nové vady a nejsou přeznačené na passing. Tento záznam nepřináší nové runtime důkazy, externí zprávu ani produkční změnu.
