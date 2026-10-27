# Document data is stored as immutable Extraction Versions

A Document's structured data is never updated in place. Every AI run produces a new Extraction Version, and every user correction produces another one, recording its author and time. The current data is the latest version. This keeps what AI proposed separate from what a human changed, satisfies the audit requirements, and allows reprocessing without losing earlier results. Other auditable actions go to an append-only `audit_event` log.

What the audit log may contain is set by ADR-0009.
