# DataTable

A dense, scannable table of Documents or Source Files; pass `columns` (`key`, `header`, `align`, `mono`, `muted`, `render`), `rows` (each with `id`), `selectedId` and `caption`.

- Compact rows (36px) by default; headers in `surface-sunken`, `label` style.
- Amounts right-aligned in `Money` without the currency; put the currency in the header.
- Identifiers (document number, VAT ID) `mono`; dates `muted`, Czech format `14. 10. 2026`.
- One StatusBadge column, last before the amounts, so the eye runs down a single column of states.
- The selected row (open in the side panel) gets `accent-soft` and an accent edge.
- Wide tables scroll inside the wrapper, never the page.
