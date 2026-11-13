> Historical #315 baseline. This document records the initial four-segment, pre-attempt protocol. For the current attempt IDs, trusted validation receipts, publication and dual-bucket cleanup contract, see [Source File transfer lifecycle](upload-transfers.md).

# Source File byte transfer

Child #315 of #286 adds byte continuation to an existing frozen Upload Batch item.
The Upload Queue's UUID and whole-file SHA256 remain the Source File identity.
The server also pins its initial filename and byte size. A continuation cannot add
an item to a started Batch or substitute a different manifest/hash/size/name.

The authenticated application route is
`/companies/{companyId}/source-files/{sourceFileId}/transfer`:

- `POST` JSON `{batchId, fileName, byteSize, sha256}` reconciles current durable
  progress. Its value is `{confirmedBytes, byteSize, complete}`. The offset is
  contiguous and comes from confirmed private Storage objects, never client
  progress. Responses have `Cache-Control: no-store`.
- `PUT` sends at most 1 MiB of raw bytes at `Upload-Offset`. Identity headers are
  `Upload-Batch-Id`, URI-encoded `Upload-File-Name`, `Upload-Byte-Size`, and
  `Upload-Sha256`. The server computes the portion hash. An identical confirmed
  portion is idempotent; conflicting bytes, overlaps and gaps are refused.
- `POST` with the same JSON and `complete: true` reads all confirmed portions,
  checks their size and hashes, checks the whole original SHA256, and runs the
  existing complete-file validation for actual format, pages and dynamic limits.
  Only then can an immutable Source File and AI work exist.

Each call uses the current Auth identity and Company authority. A transfer belongs
only to the User who created its Batch; even another authorized Company member
cannot inherit it. There are no reusable transport bearer credentials. Identity
metadata stays in the request body/headers rather than access-log query strings.
The local draft key includes both User and Company. Old Company-only draft keys
are not imported because their account owner cannot be established.

Partial portions live in the private `source-upload-chunks` bucket under
`{companyId}/{sourceFileId}/{offset}/{portionSha256}`. They cannot be overwritten.
`source_upload_transfer` and `source_upload_chunk` are tenant-scoped, owner-only,
RLS-protected transport metadata. Only the confirmation RPC advances the offset,
after the object exists at the expected size. `last_progress_at` advances only
for a newly confirmed portion, not reconciliation or duplicate confirmation.
Partial transport data never appears in Source File/Document queries or job input.

Completion dispatch uses the Source File's existing `split_request_id` as the
pg-boss job UUID. Concurrent sends and a lost enqueue response therefore converge
on one durable, retryable job. Failure between original recording and dispatch is
recoverable by repeating completion. A completed original remains reconcilable
and retained when limits subsequently change or its Batch finishes.

The client reconciles before each retry and slices only the remaining bytes. Its
transfer bar is an estimate, capped below 100% until completion; separately shown
confirmed bytes come only from server responses. Session/MFA redirects request
sign-in with the same account before retry. Network faults remain retryable;
content/access refusals are distinct.

This slice does not establish cross-device continuation or recovery of evicted
local File bytes. Reload/local-file recovery is child #316. Seven-day expiry,
restart, cancellation and temporary-object cleanup are child #317; the private
prefixes and `last_progress_at` support that lifecycle work. #315 does not claim
those siblings or parent #286 complete. Completed Source File originals are a
separate immutable bucket and must never be included in partial-byte cleanup.

Focused evidence uses application commands and authenticated HTTP against real
isolated Auth, Postgres, Storage and pg-boss, plus genuine worker handlers with
fake external providers. These establish bytes, SHA256, authority, refusals,
queue convergence and durable worker results. Browser hydration, interaction,
IndexedDB behavior and visual presentation remain unverified by CLI/HTTP checks.
