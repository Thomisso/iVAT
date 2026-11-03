# QA v6 Bugs / Improvements — ověření implementace

Ověřeno lokálně 3. 11. 2026.

Rozsah: schválená specifikace [#185](https://github.com/Thomisso/iVAT/issues/185), všech 12 ticketů #186–#197. Integrační PR: [#198](https://github.com/Thomisso/iVAT/pull/198). Features 1–8 nejsou součástí. Produkční release, změny produkčních dat ani konfigurace nebyly provedeny; sloučení PR a pozdější release jsou samostatné kroky.

## Výsledné chování

- DIČ u běžných tuzemských dokladů používá hranici 10 000 Kč včetně DPH i při schválení a tvorbě reportů. EU a reverse charge požadavky zůstávají zachované.
- Payment Account rozpoznává ekvivalentní český IBAN/domácí zápis a nulové předčíslí. Rozporné nebo neověřitelné údaje mají vlastní neblokující výsledek. Datované Bank Account Checks lze zopakovat i na schváleném dokladu v zamčeném období bez změny neměnné Extraction Version, schválení či VAT Report.
- Aktivní selhání zpracování odpovídají aktuálnímu požadavku a stavu účetní práce. Ruční převzetí, opakování a uzavření konkrétního exportního pokusu zachovávají historii, audit a podmínky pro smazání Company. Uzavřený neúspěšný export se nestává dokončeným archivem.
- Company, Organization a Platform sdílejí správu konkrétních Memberships a Invitations podle oprávněného rozsahu. Platform používá společný Settings rámec a menu; Security vrací uživatele do stále oprávněného původního kontextu.
- Serverový Supabase transport používá interní gateway při zachování veřejné identity cookies a odkazů. Výpadek závislosti nevyvolává veřejný fallback ani smazání session. `/health/live` a `/health/auth` oddělují běh webu od dostupnosti Auth.

## Kontroly

Kód po sloučení všech ticketů a závěrečných oprav: `abc3efd86761e2d13a5dfe572db77518e189164d`, výchozí `main`: `6c4ad14e192cda15d4c88569195c851da33c2d09`.

| Kontrola | Výsledek |
| --- | --- |
| Nová lokální databáze, migrace 901 → 902 → 903 → 904 → 905 → 906 | Prošlo; generované databázové typy přesně odpovídají |
| `npm run typecheck` | Prošlo |
| `npm run lint` | Prošlo |
| `npm run build` | Prošlo |
| `npm run test:serial` | 1 022 prošlo, 6 externích kontraktních testů přeskočeno; 410,6 s na `5ff8ac8`; následovaly pouze opravy E2E testů a jednoho CSS pravidla |
| Produkční Playwright sada | 88 prošlo, 5 transportních scénářů přeskočeno a ověřeno samostatně; 335,4 s |
| Samostatné real-Auth transportní scénáře | Všech 5 prošlo (29,4 s); skutečný lokální Auth/SDK, řízené síťové poruchy |
| Next MCP + skutečný browser/React | Prošlo; kompilace bez issues, config/session errors prázdné, skutečný login/správa/návrat a mobilní aktivní menu ověřeny |
| Release policy / transport / preflight testy | 20 prošlo, 1 opt-in runtime test přeskočen; žádný release příkaz nebyl spuštěn |
| CI policy testy | 5 prošlo |

Samostatné transportní scénáře se spouštějí bez jiného Next serveru ve stejné pracovní kopii:

```sh
AUTH_TRANSPORT_E2E=1 SUPABASE_SLOT="${SUPABASE_SLOT:?}" npx playwright test e2e/internal-auth-transport.spec.ts e2e/internal-recovery-transport.spec.ts e2e/auth-availability.spec.ts
```

Jejich vlastní web používá port 3103. Lokální stack se pro tento běh inicializuje s `SUPABASE_E2E_REDIRECT_URL=http://127.0.0.1:3103/**`, aby skutečné nativní e-mailové návraty mířily na testovaný web. Běžná produkční akceptace tyto scénáře záměrně přeskočí; uvedený samostatný běh je ověřil.

První společný běh odhalil tři existující scénáře závislé na aktuálním měsíci: nepřiřazené doklady importované v listopadu se správně nepočítaly do října. Fixture nyní výslovně nastavuje říjnový Import Date. Všechna původní očekávání zůstala zachovaná a všech šest cílených testů prošlo. Produkční pravidlo přiřazení období se neměnilo.

Úplný první browser běh také odhalil staré selektory původní správy uživatelů, předpoklad prázdné platformy a přetečení české karty exportu o 3 px při 720px viewportu. Selektory nyní ověřují skutečné canonical/scoped cíle; scénáře záměrně udržují i jiný aktivní problém a kontrolují správný počet bez jeho skrytí. Jediná následná produkční úprava povoluje zalomení stávajícího řádku akcí (`flex-wrap: wrap`). Původní přísné kontroly šířky, rolí, auditu a historie zůstaly zachované. Cílené regresní testy a nezávislá kontrola oprav prošly.

## Standards

Nezávislá kontrola celého diffu našla jeden závažný nález v testu exportu: privilegovaný SQL dotaz ověřoval úspěšnou obnovu. Oprava používá existující aplikační dotazy pod skutečnou browserovou Auth/MFA session. Před potvrzením zdravého dashboardu ověřuje neúspěšný export, nepřítomnost konkrétní aktivní úlohy a audit se skutečným aktérem, job id a retry count. Kontrolované vynechání kliknutí prokázalo, že tato kontrola správně selže. Opakovaná kontrola oprav nenašla žádný zbývající závažný nález. Volitelná připomínka k duplicitě dvou bloků ovládání úloh zůstala doporučením pro budoucí údržbu.

## Spec

Nezávislá kontrola celé specifikace i závěrečných oprav nenašla chybějící požadavky, nepovolené rozšíření rozsahu ani konkrétní nesprávné chování. Kontrola zahrnovala výsledné pořadí SQL migrací, historické a zamčené doklady, pozdější pokusy workeru, scoped Memberships, návraty/MFA a interní transport se zachováním veřejné identity.

Výsledek review: **Standards — 0 zbývajících závažných nálezů, 1 volitelné doporučení k duplicitě ovládání; Spec — 0 nálezů.**

## Hranice důkazů

Ověření proběhlo lokálně na izolované Supabase databázi. Aplikační testy používají skutečné databázové oprávnění; Auth scénáře skutečný lokální Auth a SDK s řízeným HTTP/TLS selháním. Běžná akceptace používá falešného AI poskytovatele a místní Postman ARES simulaci. Regrese účtů jsou syntetické, bez soukromých produkčních originálů. Kontrola dostupnosti Auth dokládá spojení s read-only settings endpointem, sama nedokládá celý login ani doručení e-mailu; tyto postupy mají samostatné scénáře. Nebylo provedeno nové produkční ověření ani externí přihlášení přes poskytovatele OAuth.
