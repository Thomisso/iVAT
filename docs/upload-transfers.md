# Source File transfer lifecycle

The private transfer route is
`/companies/{companyId}/source-files/{sourceFileId}/transfer`. Every request uses
the current native Auth session and live Company access, Membership and MFA
rules. A transfer or attempt UUID is a concurrency identity, never a credential.

The immutable identity contains the Company, Upload Batch, Source File UUID,
original file name, byte size and SHA256. It must match the started manifest and
the identity pinned on the first reconciliation. Restart never adds a manifest
item or reopens a finished Upload Batch.

`POST` reconciles this identity and returns `attemptId`, `confirmedBytes`,
`byteSize` and `complete`. Continuation includes `expectedAttemptId`; `PUT` sends
it as `Upload-Attempt-Id`, alongside the existing identity and offset headers.
Completion is `POST` with `complete: true` and the expected attempt. Confirmed
bytes are durable server progress; transport progress remains an estimate.

Incomplete attempts expire at exactly 168 elapsed hours after creation or the
last newly confirmed portion. The server clock determines admission,
confirmation and publication. Identical duplicate portions, reconciliation,
failed writes and attempted completion do not extend this window. Using elapsed
hours also preserves the deadline when a caller selects a daylight-saving
database timezone.

An expired or cancelled attempt returns HTTP 410 with `upload_expired` or
`upload_cancelled` and its attempt ID. An explicit `POST` with `restart: true`
and that expected ID creates a zero-progress attempt for the same immutable
item, under current limits. A replay returns its current replacement, including
its progress or completed result; it does not reset it. A retired generation
cannot append, publish or retry dispatch through a replacement's completion.
`upload_attempt_changed` is HTTP 409, current authorization refusal is HTTP 403,
and unavailable transport remains a separate retryable failure. The upload form
offers full restart and current-attempt reconciliation as explicit actions.

`POST` with `cancel: true` retires only the named current attempt. Cancelling a
completed item preserves its original. Client request abort and network loss
remain resumable interruptions; they do not invoke cancellation. Finishing a
Batch retires its incomplete attempts. Authorized Batch deletion and
export-authorized Company soft deletion retain their existing processing,
Period Lock and retention rules while recording temporary cleanup scopes.

A database-issued claim authorizes a narrow server-only validator to inspect
actual chunks, verify hashes/format/pages and store immutable attempt-owned
originals and derivatives. Its private receipt binds actual stored object IDs
and observed content; authenticated callers cannot assert these facts. Native
User publication consumes that receipt. Publication repeats the expected-attempt, deadline,
identity, access and current-limit checks while holding Company, Batch and
Transfer locks in that order. Ordinary Source File inserts cannot publish a
transfer-owned item. A completed current attempt remains reconcilable after
cleanup, Batch finish and lower limits; its durable Split request identity is
reused for dispatch. Completed full-file uploads remain reconcilable without
creating an empty transport attempt.

The worker runs bounded temporary cleanup on startup and every 30 seconds.
Worker-only RPCs retire invalid/expired attempts and enumerate actual objects,
including unconfirmed ones. The worker cannot write transport tables directly.
Removal uses the Storage API and only the
`source-upload-chunks` bucket. Cleanup tombstones survive Batch deletion and
empty or failed sweeps, so later provider-side writes remain discoverable.
Each pass visits up to 100 scopes and up to 500 objects per scope; later passes
continue remaining work. Tombstones are retained indefinitely: timeouts and
empty listings cannot prove that every previously admitted write has finished.

Pre-lifecycle attempts keep their existing four-segment object layout
`Company/Source/offset/hash`. New attempts use five segments,
`Company/Source/attempt/offset/hash`. Legacy cleanup matches exactly four
segments and cannot delete a replacement's five-segment objects. New transfer originals and derivatives use exact attempt-owned paths in
`source-files`. Unpublished ownership becomes permanently retired on expiry,
cancel, finish or deletion, so their tombstones collect late writes safely.
Published ownership protects retained evidence; replacement attempts use
different paths. Legacy canonical unpublished names are also registered, and
manifest identity reservations survive cascades. Existing published legacy paths,
Photo Group bases and immutable historical archives are preserved. Cleanup
reports unexpected provider failures after durable retry/fairness bookkeeping.

CLI application and authenticated HTTP checks establish authority, durable
offsets, actual bytes, hashes and terminal processing. They do not establish
native IndexedDB retention or eviction, picker behavior, hydration, clicks,
focus or visual layout. Same-device continuation does not promise cross-device
or evicted-file recovery.


Ordinary full-file Batch uploads use the same factual validator before their
native Source File insertion. Their existing canonical paths and UUIDs remain
unchanged. A matching private validated receipt is required for every reserved
manifest identity, even before transfer reconciliation. A common insertion guard
also applies this rule to definer-based manual attachment; a reserved UUID cannot
escape its Batch by omitting or changing that Batch. Genuine historical
count-only Batches retain their creator/count semantics and obtain content proof
without inventing a frozen manifest. Unreserved unbatched uploads are unchanged.
Legacy admission is retired under the Company/Batch locks before temporary
canonical cleanup, preventing publication from racing an already selected delete.
