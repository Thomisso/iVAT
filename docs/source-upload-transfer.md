> Historical #315 baseline. This document records the initial four-segment, pre-attempt protocol. For the current attempt IDs, trusted validation receipts, publication and dual-bucket cleanup contract, see [Source File transfer lifecycle](upload-transfers.md).

# Source File byte transfer

Children #315–#317 of #286 implement byte continuation and same-device recovery for an existing frozen Upload Batch item. See [the lifecycle contract](upload-transfers.md) for attempt identity, expiry, trusted validation and cleanup.
The Upload Queue's UUID and whole-file SHA256 remain the Source File identity.
The server also pins its initial filename and byte size. A continuation cannot add
an item to a started Batch or substitute a different manifest/hash/size/name.

The authenticated application route is
`/companies/{companyId}/source-files/{sourceFileId}/transfer`:

- `POST` JSON `{batchId, fileName, byteSize, sha256}` reconciles current durable
  progress. Its value is `{attemptId, confirmedBytes, byteSize, complete}`; continuation supplies the saved `expectedAttemptId`. The offset is
  contiguous and comes from confirmed private Storage objects, never client
  progress. Responses have `Cache-Control: no-store`.
- `PUT` sends at most 1 MiB of raw bytes at `Upload-Offset`. Identity headers are
  `Upload-Batch-Id`, URI-encoded `Upload-File-Name`, `Upload-Byte-Size`, and
  `Upload-Sha256`, plus `Upload-Attempt-Id`. The server computes the portion hash. An identical confirmed
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
`{companyId}/{sourceFileId}/{attemptId}/{offset}/{portionSha256}` (pre-lifecycle attempts retain their four-segment layout). They cannot be overwritten.
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

Local drafts retain immutable metadata separately from optional File bytes. Restoration
rehashes retained bytes, resets estimates, and reconciles with the current native session.
Unavailable or quota-limited IndexedDB does not prevent memory upload or finishing a
server-completed Batch. Started drafts retain the expected attempt UUID; restoration
and ordinary retries never adopt a replacement automatically. Explicit current-attempt
reconciliation and full restart remain separate User actions.

An owned pending Batch can be selected from history or its workspace for recovery.
`getUploadBatchRecovery` calls the owner/Company/MFA-protected database query, preserving
the full ordered manifest and Photo Groups without depending on PostgREST row caps.
It supplies known pinned metadata; files not yet reconciled have unknown name/size until
identical bytes are selected. Legacy count-only Batches cannot reconstruct unknown
identities or the original selection order. A Batch UUID is never authorization.

Reselection compares actual SHA256 and size, retaining the original pinned name,
Source UUID, Batch, group/order and attempt. Different bytes cannot reach append.
Recovery uses the same account and device; eviction or missing local files requires
reselection, and local files are not transferred between devices by this feature.
Completed Source File originals remain separate retained evidence.

Focused evidence uses application commands and authenticated HTTP against real
isolated Auth, Postgres, Storage and pg-boss, plus genuine worker handlers with
fake external providers. These establish bytes, SHA256, authority, refusals,
queue convergence and durable worker results. Browser hydration, interaction,
IndexedDB behavior and visual presentation remain unverified by CLI/HTTP checks.
