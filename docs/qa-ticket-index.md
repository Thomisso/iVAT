# QA: zadání, implementační tickety a návaznosti

**Navazující evidence k 13. 11. 2026.** Tento rozcestník doplňuje [původní audit dokumentů](docs-open-items-audit.md) a potvrzená rozhodnutí Q1–Q49. Auditní počty z 12. listopadu zůstávají historickým záznamem. Následná ticketizace rozdělila 13 specifikací do 31 implementačních dětí a založila čtyři samostatné návaznosti; kontrola přiřadila všech 320 User Stories. Pozdější konkrétní nálezy mají vlastní issues níže.

Tabulka vyjadřuje rozsah a závislosti, nikoli dodání. Aktuální převzetí, review a integraci zaznamenává [Agent implementation Project](https://github.com/users/Thomisso/projects/1). Implementační issues se uzavírají až skutečným dodáním přes odpovídající PR; připravené zadání ani začlenění do integrační větve nejsou merge do `main` nebo produkční nasazení.

## Specifikace a jejich děti

| Specifikace | Implementační tickety | Důležitá návaznost |
| --- | --- | --- |
| [#158 Správa Organizations](https://github.com/Thomisso/iVAT/issues/158) | [#292](https://github.com/Thomisso/iVAT/issues/292) | SuperAdmin provisioning; veřejná registrace zůstává odložená |
| [#275 Poměrný odpočet](https://github.com/Thomisso/iVAT/issues/275) | [#293 CZK](https://github.com/Thomisso/iVAT/issues/293), [#294 FX](https://github.com/Thomisso/iVAT/issues/294), [#295 opětovné potvrzení](https://github.com/Thomisso/iVAT/issues/295) | FX a životní cyklus navazují na základní ručně potvrzený poměr |
| [#276 Správa přístupů](https://github.com/Thomisso/iVAT/issues/276) | [#296 ochrany](https://github.com/Thomisso/iVAT/issues/296), [#297 tabulky](https://github.com/Thomisso/iVAT/issues/297) | Současný tenant/Role/MFA kontrakt zůstává autoritou |
| [#278 Firemní dashboard](https://github.com/Thomisso/iVAT/issues/278) | [#298](https://github.com/Thomisso/iVAT/issues/298), [#299](https://github.com/Thomisso/iVAT/issues/299), [#300](https://github.com/Thomisso/iVAT/issues/300) | Skutečná právní brána [#277](https://github.com/Thomisso/iVAT/issues/277) zůstává otevřená |
| [#280 Evaluátor](https://github.com/Thomisso/iVAT/issues/280) | [#301 skóre](https://github.com/Thomisso/iVAT/issues/301), [#302 provenience](https://github.com/Thomisso/iVAT/issues/302), [#303 preflight a limity](https://github.com/Thomisso/iVAT/issues/303) | Offline nástroj a řízené adaptéry neprokazují skutečnou přesnost ani placenou baseline |
| [#281 Soukromá referenční sada](https://github.com/Thomisso/iVAT/issues/281) | [#304 lidská reference](https://github.com/Thomisso/iVAT/issues/304), [#305 freeze a plán](https://github.com/Thomisso/iVAT/issues/305) | Vyžaduje skutečné lidsky ověřené soukromé podklady; plán navazuje na dodaný evaluátor |
| [#282 Statistiky Counterparty](https://github.com/Thomisso/iVAT/issues/282) | [#306 originální měny](https://github.com/Thomisso/iVAT/issues/306), [#307 uložené CZK](https://github.com/Thomisso/iVAT/issues/307) | Navazující konkrétní ověřovací opravy jsou #337 a #338 |
| [#283 Přehled Companies](https://github.com/Thomisso/iVAT/issues/283) | [#308](https://github.com/Thomisso/iVAT/issues/308), [#309](https://github.com/Thomisso/iVAT/issues/309) | Vyžaduje skutečné dodání #278; kód v jiné integrační větvi tuto bránu nenahrazuje |
| [#284 Skupiny fotografií](https://github.com/Thomisso/iVAT/issues/284) | [#310 JPEG/PNG](https://github.com/Thomisso/iVAT/issues/310), [#311 HEIC/HEIF](https://github.com/Thomisso/iVAT/issues/311), [#312 obnova skupiny](https://github.com/Thomisso/iVAT/issues/312) | Smíšené formáty a obnova staví na neměnném manifestu základní skupiny |
| [#285 Úpravy fotografií](https://github.com/Thomisso/iVAT/issues/285) | [#313](https://github.com/Thomisso/iVAT/issues/313), [#314](https://github.com/Thomisso/iVAT/issues/314) | Vyžaduje skutečné dodání #284; nejde o příslib úprav již zahájené dávky |
| [#286 Byte-resume](https://github.com/Thomisso/iVAT/issues/286) | [#315 protokol](https://github.com/Thomisso/iVAT/issues/315), [#316 obnova draftu](https://github.com/Thomisso/iVAT/issues/316), [#317 sedmidenní životní cyklus](https://github.com/Thomisso/iVAT/issues/317) | Obnovitelnost dočasných bytes a retence hotových originálů mají odlišná pravidla |
| [#287 Zastupování](https://github.com/Thomisso/iVAT/issues/287) | [#318 obecný zmocněnec](https://github.com/Thomisso/iVAT/issues/318), [#319 poradce FO](https://github.com/Thomisso/iVAT/issues/319), [#320 PO a podepisující osoba](https://github.com/Thomisso/iVAT/issues/320) | Default, override a vypnutí pro export; žádné automatické podání |
| [#288 Provozní alerty](https://github.com/Thomisso/iVAT/issues/288) | [#321 první alert](https://github.com/Thomisso/iVAT/issues/321), [#322 připomínka a recovery](https://github.com/Thomisso/iVAT/issues/322) | #322 navazuje také na opravu transakčního vyhodnocení #333 |

## Samostatné návaznosti a pozdější konkrétní nálezy

| Issue | Účel a hranice |
| --- | --- |
| [#323 Skutečná baseline](https://github.com/Thomisso/iVAT/issues/323) | Až po lidské referenci a konkrétním schváleném plánu provider/model/opakování/call-token-cost limitů; řízené testy ji nenahrazují |
| [#324 Payload kontrakt](https://github.com/Thomisso/iVAT/issues/324) | Samostatné dokumentační [PR #336](https://github.com/Thomisso/iVAT/pull/336); součástí je uživatelem potvrzené upřesnění #335 |
| [#325 Provozní důkazy](https://github.com/Thomisso/iVAT/issues/325) | Evidence konkrétních mezer OAuth, doručitelnosti, nákladů, DNS a podporovaných ověřovacích hranic; nepředstírat nové důkazy |
| [#326 Širší vize](https://github.com/Thomisso/iVAT/issues/326) | Dohledatelný registr odkladů; nevytváří schválení všech vizí ze SRS ani neotevírá wontfix #12/#13 |
| [#328 Validace vysokých částek](https://github.com/Thomisso/iVAT/issues/328) | Samostatný nález starší validace přes Number; neplést s úzkým poměrným odpočtem nebo povolením plošně přepsat peněžní výpočty |
| [#329 Klasifikace specifikací](https://github.com/Thomisso/iVAT/issues/329), [#331 kapacita trackeru](https://github.com/Thomisso/iVAT/issues/331) | Infrastrukturní opravy mají vlastní [PR #330](https://github.com/Thomisso/iVAT/pull/330) a [PR #332](https://github.com/Thomisso/iVAT/pull/332); nenahrazují aplikační handoff |
| [#333 Transakční vyhodnocení alertů](https://github.com/Thomisso/iVAT/issues/333) | Konkrétní doplněk #288, scoped vyhodnocení při COMMIT; předpoklad #322 |
| [#334 Oddělení trackeru a docs PR](https://github.com/Thomisso/iVAT/issues/334) | Samostatný handoff #324/#336 a aplikační integrace musí mít vlastní přesnou revizi a důkazy |
| [#335 Same-period pravidlo](https://github.com/Thomisso/iVAT/issues/335) | Potvrzená triage: určení nejdřívějšího období je nezávislé na automatickém schvalování a samo doklad neschválí. Implementační dokumentace patří do #324 |
| [#337 Cleanup a CI rozpočet](https://github.com/Thomisso/iVAT/issues/337) | Obnova skutečného PostgREST cap po native timeoutu a rozpočet odpovídající inventáři; neprohlašuje celý pomalý scénář za vyřešený |
| [#338 Výkon statistik](https://github.com/Thomisso/iVAT/issues/338) | Zbývající konkrétní timeout úplné populace 1 001 dokladů; zachovat úplné částky, stránkování a oprávnění, nikoli zmenšit akceptační scénář |

Právní [rešerše #277](https://github.com/Thomisso/iVAT/blob/64c71ec2faac640c34bdb0815e5214cd8cd1ffc3/docs/research/kh-month-quarterly.md) rozšiřuje primární podklady, ale neurčuje dosud neprokázaný měsíc běžného vstupu do KH uvnitř kvartálu. Původní odklady #3/#6 a přehled #291 zůstávají zachované. Žádná nová produktová volba se tímto rozcestníkem nepředkládá.

Schválené testovací hranice jsou celé aplikační operace a autentizované HTTP nad izolovanou skutečnou databází/Storage, u peněz skutečné Report/XML/PDF/XLSX a u uploadu skutečné bytes/archiv. Evaluátor se ověřuje přes CLI, alerty přes worker/outbox, AI a e-mail řízenými adaptéry. HTTP nedokazuje hydrataci, interakce, IndexedDB v prohlížeči ani vizuální správnost. Chybějící klientský důkaz zůstává přiznaný; nevyžaduje ani nepovoluje browser automation.
