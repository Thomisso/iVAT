# TextField

A labelled input with an optional hint or error; pass `label`, `hint`, `error`, `mono` and any input attributes.

- The label sits above the input in `label` style; never use the placeholder as the label.
- `mono` for identifiers and amounts: IČO, VAT ID, variable symbol, invoice number.
- The hint says what is accepted; the error says what is wrong and how to fix it, in the app's own words: "IČO must have 8 digits." "VAT ID must be CZ followed by 8 to 10 digits."
- An error replaces the hint and turns the border `danger`.
