# QA triage přesnosti vytěžení a statistik protistran

**Rozhodnutí:** 12. 11. 2026, potvrzená vlastníkem v Q15–Q25. Navazuje na [audit celé dokumentace](docs-open-items-audit.md) a [předchozí Q1–Q14](qa-v7-triage.md).

První rozsah řeší skutečnou accuracy baseline a souhrn na detailu jedné Counterparty. Produktové volby jsou uzavřené. Nástroj, soukromá referenční sada a samotný výsledek živého měření jsou tři různé výstupy; žádný z nich zatím není dodaný touto triage.

| Zadání | Stav při uzavření triage | Co se dodává |
| --- | --- | --- |
| [#280 Evaluátor kritické přesnosti](https://github.com/Thomisso/iVAT/issues/280) | `ready-for-agent` | Opakovatelné skórování, porovnání providerů a preflight, ověřitelné synteticky bez placených volání |
| [#281 Soukromý reálný golden set a plán běhu](https://github.com/Thomisso/iVAT/issues/281) | `ready-for-human` | Výběr/anonymizace vzorků, lidská reference, freeze a konkrétní plán prvního měření |
| [#282 Statistiky na detailu Counterparty](https://github.com/Thomisso/iVAT/issues/282) | `ready-for-agent` | Aktuální schválené doklady, původní částky, DUZP a pravdivé CZK/měnové souhrny |

Vývoj #280 a lidská příprava #281 mohou postupovat souběžně; nejsou navzájem blokované. Živý běh vyžaduje ověřený nástroj, hotovou zmrazenou sadu a samostatně schválený konkrétní plán modelů, opakování a nákladů. Statistiky #282 jsou nezávislé na #277/#278 i budoucím párování dobropisů #2 a poměrném odpočtu #275. Readiness sama práci nespouští; skutečný stav určuje tracker.

## Přesnost a referenční sada

- **Q15:** nejprve zjistit reálnou baseline. Odděleně měřit přesný Split, správnost jednotlivých polí a podíl Documents bez důležité účetní opravy. Procentní regresní/release práh se určí až podle výsledků; měření samo nemění produkční modely.
- **Q16:** začít přibližně 30 reálnými anonymizovanými Source Files: textová PDF, skeny a fotografie, faktury/účtenky/Credit Notes, vícestránkové doklady a několik zdrojů s více Documents. Zahrnout různé layouty, sazby a cizí měny. První podporovaný datasetový formát je PDF/PNG/JPEG; konkrétní pokrytí se uvede při freeze.
- **Q17:** hranice a očekávané hodnoty ověří člověk podle skutečně testovaných bytes. AI smí připravit návrh, ale výstup testovaného modelu neurčuje vlastní referenci. Nejistota se označí; reference se potichu nepřizpůsobuje výsledku.
- **Q20:** kritická sada zahrnuje typ/číslo dokladu, identifikátory a správné strany, vystavení/DUZP, měnu, sazby, původní net/VAT/gross se znaménky a uvedenou referenci Credit Note. Chybný Direction či Proposed VAT Regime se vykáže zvlášť a zároveň znamená Document vyžadující opravu. Názvy, adresy a platební údaje mají nadále vlastní field skóre; bezchybná kritická sada neznamená bezchybné každé pole. Geometrické IoU je budoucí samostatné měření.
- **Q21:** umožnit porovnání Anthropic/OpenAI na totožné zmrazené sadě. Uložit přesné modely, prompt, revizi, konfiguraci a původ jednotlivých volání. Konkrétní modely, opakování a rozpočet se rozhodnou nad připraveným plánem; nejde o souhlas s placeným během již nyní.
- **Q22:** originály, anonymizované kopie, mapa, lidské expected JSON a raw výsledky zůstávají soukromě mimo Git. Ve veřejném repozitáři jen nástroj, syntetické regrese a bezpečné agregované souhrny. Samotná anonymizace není oprávnění dataset zveřejnit.

U finančních polí je správná přesná původní podepsaná hodnota; produkční kontrolní tolerance ±0,02 není tolerance accuracy. Povolena je kanonizace ekvivalentního formátu a pořadí sazeb, nikoli fuzzy opravy čísel/identit/dat. Chybějící, navíc domyšlené, null a nerozhodnuté referenční hodnoty se odliší, aby prázdná pole nenafukovala výsledek. Direction se odvodí skutečnou deterministickou cestou s konzistentní anonymizovanou Company.

Existující [evaluátor](../src/evaluation/extraction-evaluation.ts) izolovaně vytěžuje rozsahy z referenčního Splitu. Jeho Extraction skóre proto není end-to-end úspěšnost celého produkčního toku po AI Splitu. [Golden set](../evaluation/golden-set/README.md) obsahuje jen dvě ilustrativní blank cases; #32 se neznovuotevírá jako neexistující harness.

Nástroj má zachovat i částečné výsledky, selhání a jejich jmenovatele. Preflight provede nula AI volání a ukáže call/retry/token rozsah i dostupný cenový odhad. Živý běh vynucuje technické limity a ukládá skutečně dostupné tokeny/latence; odhad ceny není skutečná fakturovaná cena ani tvrdý finanční strop bez odpovídajících údajů. Soukromý report nesmí uniknout do veřejných CI logů.

## Statistiky protistrany

- **Q18:** první dodávka je na detailu jedné Counterparty v aktivní Company. Žádná nová globální analytická sekce, žebříčky ani cross-company BI.
- **Q19:** pouze aktuální Approved Documents s aktuální explicitní vazbou na stabilní id Counterparty, každé Document id jednou. Staré Versions/vazby, koncepty, rejected a processing se nezapočítávají. Zánik dnešní způsobilosti DPH nároku nevymaže obchodní historii.
- **Q23:** oddělit incoming/outgoing podle Direction Document. Zobrazit jedinečné počty a původní net/VAT/gross s podepsanými Credit Notes. Partial Claim ani §75 původní hodnotu nesnižují. Bez platebního ledgeru se neodvozuje uhrazenost, pohledávky či cash flow.
- **Q24:** filtrovat podle DUZP; výchozí aktuální kalendářní rok, volitelně jiný rok nebo vlastní od/do včetně hranic. Chybějící DUZP se přizná, nenahradí uploadem, vystavením ani obdobím odpočtu.
- **Q25:** hlavní souhrn CZK používá platný uložený přepočet celých původních částek, bez nového přeceňování. Vedle rozpis původních měn. Chybějící/neplatný přepočet znamená viditelně neúplný CZK součet a přesný seznam vynechaných Documents, nikoli nulu; původní měna a počet zůstávají započtené.

Dnešní historický `counterparty_documents` dotaz může najít Document i pod starou vazbou. Nesmí se stát finanční populací; souhrny i drill-down potřebují aktuální vazbu, shodný filtr a úplný výsledek nad všemi stránkami, včetně reálného databázového row limitu. Součet prvních 50 záznamů není celkový součet. Přístup zůstává omezený na Effective Access k dané Company a vynucený databází.

Příklad z #282: přijatá CZK faktura 1 210, dobropis −121 a EUR faktura 121 s uloženým kurzem 25 přispějí **4 114 CZK**. Čtvrtý přijatý doklad 48,40 EUR bez CZK přepočtu zůstane v počtu čtyř a původním EUR souhrnu, ale hlavní CZK součet bude označený jako dostupný jen ze tří. Vydané částky jsou oddělené.

Úplná implementační akceptace a výchozí místa jsou v jednotlivých issues. Ostatní explicitní odklady z [inventáře](docs-open-items-audit.md) zůstávají odložené; tato volba neuzavírá celý roadmap backlog ani daňovou faktickou bránu #277.
