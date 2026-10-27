# Sidebar

The app's main navigation with the Company switcher; pass `company` (`name`, `ico`) and `items` (`group` headings, or `label`, `icon`, `href`, `count`, `ai`, `current`).

- Replaces the current top header's inline Company links: one Company is open at a time and the switcher lists the rest.
- Groups follow the work: **Documents** (Inbox, Received, Issued), **VAT** (Reporting Periods, VAT Reports), **Company** (Settings, Members).
- `count` on Inbox shows what is waiting; `ai` tints the count marker ochre when the AI has proposals waiting for review.
- Width `sidebar` (232px); at phone width it becomes a sheet behind a menu button.
