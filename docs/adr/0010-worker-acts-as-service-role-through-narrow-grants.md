# The worker acts as service_role, limited to the processing transitions it is granted

Background jobs run without a signed-in user, so the worker cannot act through an `AppClient` with RLS the way commands do. It connects with the Supabase secret key as `service_role`, which RLS does not restrict. The database still limits it to what processing needs. It can read the tables it works on. Its only direct writes are the `status` columns of `source_file` and `document`. It records a Split or an AI Extraction Version only through `public.record_split` and `public.record_ai_extraction`. These security-definer functions are executable by `service_role` alone, and they make every job idempotent. Extraction Versions refuse update and delete even for `service_role`.

Job handlers live in `src/application/processing.ts` and take a `SystemClient`. Only they do, and only the worker process creates one. Jobs carry ids only. Whether to call an AI provider is decided from the database at run time: the Company must have an enabled assignment to a usable platform-owned AI Configuration and remaining allowance (ADR-0011). Retried or repeated jobs therefore converge on one result. Access and allowance are checked when a job starts, so disabling access or exhausting the allowance stops every job that has not started yet. A call already sent to the provider still completes.

## Considered Options

- Running jobs as the user who started them (storing a session or minting a JWT). Rejected: sessions expire before long or retried jobs finish, and minting tokens would put a signing secret in the worker anyway.
- A direct Postgres connection as a dedicated role. Rejected for now: the worker also reads Source Files from Supabase Storage, which needs the Storage API.

Operational email reconciliation is another narrow background handler. The worker receives only private incident candidates and current authorized recipients through service-role-only RPCs, then atomically claims and finishes durable delivery receipts. It receives no grants to private episode/preference/outbox tables or the unrestricted platform inventory. Public platform reads and personal opt-in mutations continue to require the human SuperAdmin MFA session.


Source upload validation uses a narrow server-only capability, like the existing
claim-scoped Auth administration capabilities. A native User command first
obtains a database-issued claim bound to its immutable manifest item and current
attempt. The validator may read that claim, inspect the actual chunk content,
store immutable attempt-owned originals/derivatives and record factual hashes,
format, page count and Storage object identities through service-only RPCs. Its
adapter exposes only validation of a claim, never an unrestricted client or a
supplied-user-id publication method. It does not create a `SystemClient` or mint
User claims. Final publication still executes as the native User and rechecks
current MFA, access, creator, scope, generation, deadline and platform limits.
Authenticated callers cannot fabricate a validation receipt. Retirement and
publication arbitrate the object's monotonic ownership under the shared locks;
background cleanup cannot collect a retained published original.
