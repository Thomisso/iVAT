# StatusBadge

The state of a Document or Source File, as a word and an icon; pass `status`.

- Statuses follow the glossary: `uploaded`, `splitting`, `extracting`, `proposed` (AI proposed, not reviewed), `needs-review`, `duplicate` (Duplicate Warning), `manual` (Manual Classification Required), `failed`, `approved` (Approved Document), `locked` (Period Lock).
- Marker ochre (`ai`) means the AI is working or waiting for a human. Orange (`warning`) means a human must look. Green (`success`) means a human confirmed it. Ink means locked.
- Always one badge per row. Never colour alone: the icon and the word go together.
