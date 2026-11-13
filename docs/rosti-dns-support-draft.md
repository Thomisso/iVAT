# Podklad pro šetření historické DNS odpovědi u Roští

**Stav:** připravený, neodeslaný návrh podle potvrzeného Q40 ze dne 12. 11. 2026. Vychází z [QA v6 bod g](QA_v6.md#g-výpadky-přihlášení-při-chybném-veřejném-dns-překladu-z-produkce). Popisuje pozorování 31. 10. 2026; nejde o současnou reprodukci ani potvrzený výsledek šetření resolveru. Aplikační interní transport byl mezitím dodaný v PR #198.

## Návrh zprávy

**Předmět:** Prověření rozdílné DNS odpovědi pro api.ivat.cz dne 31. 10. 2026

Dobrý den,

prosíme o prověření historické DNS odpovědi resolveru používaného naším stackem na Roští. Dne 31. 10. 2026 kolem 14:16:23 UTC (15:16:23 SEČ), opakovaně také v 15:17:29 a 15:17:33 SEČ, selhávalo spojení webového kontejneru na veřejný Auth endpoint pro `api.ivat.cz`.

Při tehdejší diagnostice jsme zaznamenali:

- Resolver Roští `10.3.0.1`, dosažený přes Docker DNS `127.0.0.11`, vracel pro `api.ivat.cz` IPv4 `185.8.237.22`. Endpoint na této adrese předkládal self-signed certifikát WEDOS Global s `CN=invalid`; klient hlásil `DEPTH_ZERO_SELF_SIGNED_CERT`.
- Veřejné resolvery `1.1.1.1` a `8.8.8.8` vracely přes `lb.rosti.cz` IPv4 `185.58.41.93`. Diagnostický požadavek ze stejného kontejneru při použití této adresy vrátil `/auth/v1/settings` HTTP 200 s platným ověřením TLS.
- Všechny čtyři autoritativní nameservery WEDOS při kontrole vracely pro `app.ivat.cz` a `api.ivat.cz` CNAME na `lb.rosti.cz`, TTL 300. Obě domény byly přiřazené běžícímu stacku; `redirect_to_first` byl vypnutý.
- Interní cesta na Auth opakovaně vracela HTTP 200. V kontrolovaném intervalu nebyl v Auth logu odpovídající požadavek z neúspěšného veřejného spojení.

Serverovou komunikaci aplikace jsme následně převedli na interní gateway při zachování veřejné identity odkazů a cookies. Tato aplikační náprava ale nevysvětluje tehdejší rozdílnou DNS odpověď.

Lze prosím z dostupných historických údajů zjistit, proč resolver vracel uvedenou odlišnou IPv4? Zajímá nás případná příčina, rozsah a preventivní opatření. Pokud již údaje pro dané období nejsou dostupné, prosíme o výslovné uvedení této hranice šetření.

Děkujeme.

## Použití podkladu

Případné doplnění identifikátoru služby patří do neveřejného požadavku podle oprávněného účtu. Podklad neobsahuje hesla, tokeny, cookies, soukromé raw logy ani přílohy. Jeho příprava není odeslání; v této triage nebyla podpora kontaktovaná, produkční diagnostika ani konfigurace se neměnila.
