# AI credentials are central or BYOK per Organization; AI processing is opt-in per Company

AI provider keys exist at two levels:

- **Platform keys** are managed by the SuperAdmin, who can enable them per Organization.
- **Organization keys (BYOK)** take precedence when they are set.

Keys are stored encrypted (Supabase Vault). They are never shown back; the UI displays only the last four characters. Each Company must explicitly enable AI processing, and it is off by default. Enabling it records which provider and region will receive Documents in the audit log. Entering a BYOK key shows a warning that responsibility for the data processing agreement with that provider moves to the Organization. Each Extraction Version records the provider and model that produced it. AI usage (requests and tokens) is metered per Organization so billing can be added later.
