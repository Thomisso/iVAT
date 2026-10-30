# Nasazení pilotu iVAT na Roští — 30. 10. 2026

Záznam skutečného nasazení a kontrol provedených během této relace. Opakovatelný
postup sestavení, nasazení a obnovy je v [provozním návodu](../deployment.md).
Hesla, API klíče, JWT klíče, SSH privátní klíč ani záložní archivy do Git nepatří.

## Rozhodnutí a rozsah pilotu

Pilot je určený pro tři Companies / tři Users. Kvůli nákladům běží aplikace,
Worker, databáze i úložiště v jednom Stacku. Samostatný databázový server ani
Redis jsme nezřizovali; pg-boss používá stejný PostgreSQL.

Jde o dohodnutou pilotní výjimku z původní varianty spravovaného Supabase v
[ADR-0002](../adr/0002-typescript-supabase-stack-local-first.md). Roští spravuje
hostitelskou infrastrukturu a veřejné HTTPS. My spravujeme kontejnery Supabase,
aplikační image, migrace, zálohy a obnovu. Pro pilot bylo odsouhlaseno globální
zpracování AI u OpenAI bez požadavku na umístění AI v EU.

## Identifikace nasazení

| Položka | Hodnota při nasazení |
| --- | --- |
| Poskytovatel | Roští, služba Stack |
| Název / ID Stacku | `ivat` / `931` |
| ID společnosti v Roští | `7895` |
| Profil | Medium, 4 GiB RAM, 25 GB disku, 2 vCPU |
| Architektura image | `linux/amd64` |
| SSH | `root@ssh.rosti.cz`, port `25968`; preferovat `rosticli stacks ssh --target rosti` |
| Adresář na Stacku | `/srv/stack` |
| Aplikace | <https://app.ivat.cz> |
| Veřejné Supabase API | <https://api.ivat.cz> |
| Výchozí doména Roští | `ivat-931.rostiapp.cz` |
| Registrátor a DNS | WEDOS, ponechaný NSSET a DNSSEC |
| CLI použité při nasazení | `rosticli` 1.9.3 |
| Větev implementace | `deploy/rosti-pilot` |
| Výchozí commit aplikace | `846c11f` |
| První nasazení | `3cac92d` — kontejnery, migrace, zálohy, ověřovací workflow |
| Poslední nasazená změna | `baa1226` — přesměrování veřejného HTTP na HTTPS |

Dokumentační commity přidané později nemění běžící release. Jeho identifikace je
na hostu v `deploy/release-commit.txt` a `deploy/release-images.txt`.

Při nasazení byl pracovní checkout `/private/tmp/ivat-deploy`; hlavní checkout
a jeho lokální databáze nebyly měněny. Pro další práci použít uloženou Git větev
a nový izolovaný worktree, nikoliv spoléhat na existenci dočasného adresáře.
V této relaci nebyla větev publikována ani sloučena do `main`.

## Co běží

| Služba | Image / verze | Úloha |
| --- | --- | --- |
| `web` | `app:latest`, Next.js 16.4.3, Node.js 22 | Produkční standalone web, interní port 3000 |
| `worker` | stejný `app:latest` | Samostatný proces `tsx worker/index.ts`, fronta pg-boss, heartbeat |
| `migrate` | stejný `app:latest` | Jednorázově aplikuje a kontroluje migrace před startem aplikace |
| `db` | `app-deploy-db:latest`, základ `supabase/postgres:17.6.1.136` | PostgreSQL 17 včetně Vault |
| `auth` | `supabase/gotrue:v2.197.0` | Přihlášení a TOTP MFA |
| `rest` | `postgrest/postgrest:v14.18` | Datové API nad PostgreSQL a RLS |
| `storage` | `supabase/storage-api:v1.81.0` | Soukromé Source Files a podepsané URL |
| `gateway` | `app-deploy-gateway:latest`, základ Kong 3.9.3 | Směrování Auth / REST / Storage, ověřování API klíčů |
| `proxy` | `app-deploy-proxy:latest`, základ Nginx 1.28 Alpine | Směrování podle domény, jediný zveřejněný port `80:80` |
| `backup` | `app:latest`, profil `operator` | Jednorázový GNU tar pro konzistentní zálohu a obnovu |

Roští navíc provozuje vlastní `system-mgm-1` pro správu a SSH. Není součástí
našeho Compose. Výchozí kontejner `stack-welcome-1` byl po nahrazení odstraněn,
aby po restartu nesoutěžil s naším proxy o port 80.

Databáze, Auth, REST, Storage ani administrační port Kong nejsou samostatně
zveřejněné. Web používá veřejnou adresu API i kvůli generování použitelných
podepsaných URL; Worker může používat interní `http://gateway:8000`.

Perzistentní data jsou bind mounty pod `/srv/stack/deploy/runtime/`:

- `db/` → `/var/lib/postgresql/data`;
- `db-keys/` → celý `/etc/postgresql-custom`, včetně databázových šifrovacích klíčů;
- `storage/` → `/var/lib/storage`, včetně rozšířených atributů souborů.

Studio, Realtime, Edge Functions, Analytics, pooler a transformace obrázků se
nenasazovaly. Původ vendovaných souborů a úpravy popisuje
[deploy/UPSTREAM.md](../../deploy/UPSTREAM.md).

## Jak proběhlo nasazení

1. V izolovaném worktree jsme připravili čtyři vlastní Docker image, Compose,
   migrační runner, skripty záloh a obnovy. Lokální testovací instance používala
   vlastní data a klíče, oddělené od produkce.
2. Ověřili jsme lokální produkční build, self-hosted Supabase a aplikační testy.
   Pro server byly všechny čtyři image sestavené pro `linux/amd64`.
3. Přes přihlášené oficiální CLI jsme vytvořili Stack `ivat`, profil Medium,
   a nastavili cílové prostředí `rosti` v gitignored `.rostistate`.
4. `deploy/scripts/init.mjs` vygeneroval nové produkční klíče do soukromého
   `.env.rosti`. `rosticli stacks push-env --target rosti` je přenesl do `.env`
   na Stacku. Existující instalace se tímto inicializátorem znovu neinicializuje.
5. Automatické rozpoznání více image v CLI 1.9.3 vynechalo hlavní image v kořeni
   repozitáře a nerozpoznalo náš frontend `proxy`. Nepoužili jsme částečný build.
   Všechny image jsme sestavili přes Compose a přenesli přes
   `docker save | gzip | rosticli stacks ssh ... docker load`.
6. Přes SSH jsme přenesli `docker-compose.rosti.yml`, `deploy/scripts/` a
   `deploy/restore.yml`. Kanonický `/srv/stack/docker-compose.yml` byl
   synchronizován; konfigurace vracená API Roští se shodovala s naším souborem.
7. Spustili jsme Compose s `.env`, bez vzdáleného buildu. Aplikovalo se všech
   **63 migrací**. Samostatný ledger je `ivat_deploy.migration`; opakovaný běh
   migrací prošel beze změny dat. `migrate` má po úspěchu stav `Exited (0)`.
8. Přes explicitní administrační skript jsme vytvořili SuperAdmina. Operátor
   následně v aplikaci zapnul TOTP MFA a vytvořil platformní OpenAI konfiguraci.
9. Po zprovoznění certifikátů jsme ověřili veřejnou aplikaci i API, provedli
   zálohu finálního nastavení a její soukromou kopii mimo Stack.

Na serveru byly ponechané značky `app:pilot-3cac92d`,
`app-deploy-db:pilot-3cac92d`, `app-deploy-gateway:pilot-3cac92d`,
`app-deploy-proxy:pilot-3cac92d` a novější `app-deploy-proxy:pilot-baa1226`.
Compose používá `latest`; před jeho dalším přepsáním je nutné uchovat aktuální
image a jejich inventář podle provozního návodu.

## DNS, HTTPS a incident při prvním spuštění

Ve WEDOS jsme nastavili následující záznamy. DNS zóna zůstala u WEDOS:

| Název | Typ | Cíl | TTL |
| --- | --- | --- | --- |
| `app` | CNAME | `lb.rosti.cz.` | 300 |
| `api` | CNAME | `lb.rosti.cz.` | 300 |

Obě plné domény jsou v záložce Proxy Stacku. Přesměrování všech domén na první
je **vypnuté**, protože aplikace a API mají rozdílné směrování. Vlastní Certbot
ani veřejný port 443 na Stacku nejsou potřeba: HTTPS ukončuje load balancer
Roští, který do našeho Nginxu předává HTTP na port 80. Náš Nginx přesměruje
veřejné HTTP na HTTPS se zachováním cesty a parametrů.

Při prvním spuštění se vlastní certifikáty nezobrazily okamžitě:

- Nejpozději v **15:58 SEČ / 14:58 UTC** byly CNAME a výsledná IPv4
  `185.58.41.93` ověřené přes veřejné resolvery 1.1.1.1 a 8.8.8.8. Přesný čas
  původního uložení DNS ani pořadí prvního přidání do Proxy nejsou zaznamenané.
- Přibližně v **16:04 SEČ / 15:04 UTC** jsme jednou znovu uložili Proxy přes API,
  po potvrzení správného veřejného DNS. Samotné uložení problém hned nevyřešilo.
- Do vydání/načtení vlastních certifikátů server předkládal prošlý self-signed
  certifikát `CN=default.rostiapp.cz`. Syntetický požadavek na
  `/.well-known/acme-challenge/ivat-deployment-probe` vracel na vnějším proxy
  `502`; nešlo ale o skutečný token ACME žádosti a samo to neurčilo příčinu.
- Bot podpory uvedl IPv4 `185.8.237.22`. Přímé dotazy ověřily, že tato adresa
  patřila `ivat.cz` a `www.ivat.cz`, nikoli našim dvěma subdoménám. Apex a `www`
  nebyly při tomto nasazení nastavené jako vstup do iVAT.
- Lidská podpora vysvětlila dvě DNS kontroly (load balancer a Let's Encrypt)
  a prodlužování intervalů opakovaných pokusů po selhání. Přesnou příčinu
  konkrétního předchozího pokusu jsme z jejich logů neobdrželi.
- V **16:41 SEČ / 15:41 UTC** jsme úspěšně ověřili platné certifikáty Let's
  Encrypt pro obě domény a následně veřejné přihlášení a upload. Další změna
  našich DNS ani vlastní instalace certifikátů nebyla potřeba.

Poučení: po ověření správného DNS konfiguraci ponechat stabilní. Při delším
zdržení požádat podporu o poslední chybu konkrétní žádosti a čas dalšího pokusu,
případně jeho ruční spuštění. Samotný neplatný výchozí certifikát ani syntetická
ACME odpověď nedokazují výpadek poskytovatele.

Výchozí `https://ivat-931.rostiapp.cz/healthz` má platné HTTPS a vrací `200 ok`.
Jeho `/` a `/login` vracejí `404`, protože tuto doménu náš Nginx nepřiřazuje
aplikačnímu serveru. To je očekávané směrování, nezávislé na platnosti TLS.

Oficiální podklady: [domény a automatické HTTPS](https://docs.rosti.cz/cs/stacks/quickstart/#nastaveni-domen),
[REST API](https://admin.rosti.cz/api-n/docs),
[kontakt podpory](https://rosti.cz/kontakt).

## Přihlášení a AI po nastavení operátorem

- Veřejná registrace je vypnutá. Users zakládá operátor pomocí
  `deploy/scripts/provision-user.mjs`; `--superadmin` je pouze pro správce platformy.
- SuperAdmin má ověřené TOTP MFA. Heslo bylo předané přes soukromý lokální
  soubor, nikoli chat nebo Git.
- SMTP a Google OAuth se pro pilot nezprovozňovaly. Používá se e-mail a heslo;
  odesílání pozvánek a obnova hesla e-mailem nejsou nastavené.
- `AI_PROVIDER=platform`; existuje výchozí AI Configuration pro `openai`,
  Split i Extraction používají `gpt-6.1-terra`. Model podporuje potřebné obrazové
  vstupy a strukturované výstupy podle [OpenAI Docs](https://developers.openai.com/api/docs/models/gpt-6.1-terra).
- Konfigurace je přiřazená jedné Company, AI je povolené a její AI Processing
  Allowance je **500 úspěšných Extractions celkem**, bez měsíčního resetu.
  Neznamená to předplacený kredit ani peněžní limit u OpenAI.
- Operátor vložil API klíč přímo do aplikace. Při následné read-only kontrole
  jsme ověřili pouze existenci uloženého záznamu; klíč jsme nenačítali ani
  nezobrazovali. Je uložený přes Supabase Vault.

Počet tří Companies / Users je plán pilotu, nikoli tvrzení, že už byly založeny
všechny tři. Při kontrole po nastavení byla jedna Company a žádný Source File
ani Document; reálné zpracování přes OpenAI tak ještě nebylo potvrzené.

## Provedené kontroly a hranice ověření

| Kontrola | Výsledek |
| --- | --- |
| Typecheck, lint, produkční build | Prošly |
| Produkční image pro server | Sestavení `linux/amd64` prošlo |
| Integrace proti self-hosted Supabase | 64 testů: processing, Source Files, AI Configurations; skriptované AI adaptéry |
| Migrace | 63 aplikovaných, opakovaný běh úspěšný |
| Stav služeb | Osm dlouhodobých služeb healthy; migrace Exited (0) |
| Web v reálném prohlížeči | Přihlašovací stránka na `https://app.ivat.cz/login` funguje |
| Veřejné API | HTTPS, CORS z aplikační domény, přihlášení heslem a požadavek na MFA ověřené |
| Storage přes veřejné API | Upload 50 MiB, podepsaná URL a stažení ověřené po bajtech; dočasný bucket i soubor odstraněné |
| Metadata Storage | Na skutečném hostu se zachoval MIME typ; souborový systém podporuje potřebné xattrs |
| XML v produkční image | Validace EPO XML přes skutečné přibalené schéma prošla |
| Obnova | Lokálně nacvičená obnova testovací zálohy včetně Vault a Storage metadata |
| Poslední produkční záloha | Vytvořená, zkopírovaná mimo server, `gzip -t` prošel |

Před zapojením pilotních Users ještě potvrdit: první skutečný Source File přes
web → Split → Extraction → Document ve stavu „Ke kontrole“, následnou kontrolu
dat a odpovídající export. Ověřit také velký upload přes webový formulář na
pomalém spojení; výše uvedený 50MiB test byl Storage API, nikoli tento scénář.

## Zálohy a soukromé provozní soubory

Denní cold backup je v hostitelském crontabu v **03:15 UTC**. Zastaví služby,
pořídí konzistentní archiv PostgreSQL, databázových klíčů, Storage včetně xattrs,
`.env` a Compose a služby znovu spustí. Je to krátké servisní okno.
`backup-daily.sh` po úspěšné záloze odstraňuje archivy starší než sedm dní.

| Umístění | Obsah |
| --- | --- |
| `/srv/stack/.env` | Produkční prostředí; nepřepisovat neúplným souborem |
| `/srv/stack/deploy/backups/` | Lokální archivy a `.images.json` inventáře |
| `/srv/stack/deploy/backups/daily.log` | Výstup naplánovaných záloh |
| `~/.config/ivat/production/` na počítači operátora | Soukromé kopie mimo server, adresář 0700, soubory 0600 |
| `environment.env` v tomto soukromém adresáři | Obnovovací kopie původního produkčního prostředí |
| `initial-login.txt` v tomto soukromém adresáři | Původně předané přihlašovací údaje; nejde o evidenci případných pozdějších změn hesla |

Vytvořené a lokálně zkopírované archivy:

- `ivat-20261030T140756Z.tar.gz` — počáteční instalace;
- `ivat-20261030T155043Z.tar.gz` — nastavení po aktivaci MFA a OpenAI konfigurace.

U obou existuje `.images.json` a prošla kontrola gzip integrity. Ta nenahrazuje
nácvik obnovy konkrétního produkčního archivu. Archivy obsahují také klíčový
materiál, chrání je práva souborů; formát archivu sám o sobě není šifrovaný.
Automatický přenos mimo server, samostatné šifrování archivů a upozornění na
selhání nebyly při nasazení nakonfigurované. První off-server kopie jsou ruční.

Po znovuvytvoření `mgm` ověřit zachování crontabu a běžícího `crond`. Při obnově
jsou nutné odpovídající image, data i celá složka `db-keys`; samotný inventář
image jejich binární obsah neobsahuje. Postup obnovy do prázdného samostatného
Stacku a kontrolu po obnově popisuje [provozní návod](../deployment.md#backups-and-recovery).

## Co dělat příště

Pro další release pokračovat podle [provozního návodu](../deployment.md):
samostatný worktree, testovací prostředí s vlastními klíči, záloha, sestavení
pro AMD64, přenos všech změněných image a konfigurace, migrace, health check
a veřejné funkční ověření. Neprovádět produkční `db:reset` ani mazání runtime dat.

`.github/workflows/deployment-check.yml` je připravený v implementační větvi,
ale jeho běh na GitHubu ani automatické nasazování nebyly v této relaci
zprovozněné. První release proběhl ručně z počítače operátora přes CLI a SSH.
Případné CI/CD zapojovat až s kontrolou všech čtyř image a build-time veřejných
proměnných; dosavadní omezení automatického rozpoznávání CLI je popsáno výše.
