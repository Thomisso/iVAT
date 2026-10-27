# Notice

A one-line message inside a page or form; pass `tone` (`info`, `warning`, `danger`, `success`), an optional bold `title` and the text.

- Replaces the bare red `form-error` paragraph: `danger` for form and upload errors, with the error text from `messages/*.json` unchanged.
- `warning` for Duplicate Warning and Period Lock explanations: say what happened and what the user can do.
- Never stack more than two; never use one for something a field error can say in place.
