# Money

An amount in Czech format; pass `amount` (a number), optional `currency` (default `Kč`, `""` to hide) and `locale`.

- Formats with `cs-CZ`: space-grouped thousands, decimal comma, always two decimals: `24 200,00 Kč`.
- Negative amounts (Credit Notes) use a true minus sign U+2212 and `danger` colour: `−2 420,00 Kč`.
- Right-align in tables and hide the currency in a column whose header already says it ("Total, CZK").
- Set in `amount` / `amount-lg` (Geist Mono) so columns align.
