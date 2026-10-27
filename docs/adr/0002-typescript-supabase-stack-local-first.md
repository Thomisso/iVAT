# TypeScript end-to-end on Supabase, local-first until MVP

The application is TypeScript throughout: Next.js serves the UI and API, and a separate worker process runs background jobs. Data lives in PostgreSQL, the job queue is pg-boss (on the same Postgres, so no Redis), and original files are kept in S3-compatible storage. Authentication uses Supabase Auth (email/password, Google, TOTP MFA; Apple and Microsoft can be added through configuration). Until the MVP everything runs locally through the Supabase CLI. Production will be Supabase in an EU region, so moving to it is a configuration change.

## Considered Options

- Python (FastAPI). The developer is stronger in Python and SQL, but it was rejected: one language across UI, API and worker suits solo development with AI agents, and OCR libraries are not needed (see ADR-0004).
- .NET. Rejected for the same single-language reason.
- Hyperscaler (AWS/Azure/GCP) or a self-managed VPS. Rejected for the MVP: Supabase bundles Postgres, storage and auth with little operational effort.
