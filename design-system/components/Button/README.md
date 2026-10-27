# Button

One verb-first action; pass `variant`, `size`, an optional `icon` name and the label as children.

- `primary` (accent fill): at most one per view, for what the page is for: **Approve**, **Upload**, **Finalize Q3 2026**.
- `secondary` (default): everything else.
- `ghost`: toolbar and in-row actions where a border would add noise.
- `danger`: destructive and irreversible (**Unlock period**, **Delete Source File**). Text-coloured, not filled; confirm in the page before acting.
- `ai`: an action that asks the AI to do work (**Extract again**, **Explain this VAT Regime**). Marker-tinted so the user knows the next step is the AI's, not a final decision.
- `size="sm"` (28px) inside tables, toolbars and the review panel; `md` (32px) elsewhere.
- Labels are sentence case and name the result: "Approve document", not "OK" or "Submit".
