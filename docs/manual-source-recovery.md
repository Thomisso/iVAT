# Manual recovery before Documents exist

A Source File with no Documents can enter manual review, be defined as real Document boundaries, or be excluded with a short reason. PDF boundaries are positive, ascending, disjoint inclusive page ranges within the immutable upload's validated page count. An image defines one Document spanning its one page. Definition preserves the original bytes and creates `needs_review` Documents without Extraction Versions or AI jobs. Their first structured save uses the ordinary User Version command and requires a valid Tax Point Date.

Once Documents exist, corrections, exclusion and reprocessing act on those concrete Documents. Repeating an already accepted manual definition returns the active Document identities without resetting their data, status or history. The accepted boundary definition and actual User/time remain with the Source and in its Audit Trail. The review viewer uses an existing normalized image preview when needed; original reads and archives preserve the uploaded bytes.

## Requests and authorization

User commands take an `AppClient`; the database enforces Company access and transitions. Worker-only Split recording, status changes and technical issue recording require the current `split_request_id`. Takeover, manual definition, exclusion, reversal and explicit retry invalidate earlier requests. Platform remediation receipts also carry that identity, including compensation after a lost queue acknowledgement. A stale success or failure cannot create Documents, change a human state or park a newer retry.

Source transitions and Source-to-Document writers lock Company before Source and then any existing Documents. Multiple-Company remediation takes Company locks in sorted order. This matches the Document transition and revision-trigger ordering established by ticket176; no generic deadlock retry is used.

Reversal enters `needs_review`, so old queued jobs cannot automatically restart AI. An explicit retry is a separate action. Manual processing and exclusion do not consume AI Processing Allowance. Only ordinary successful AI Extraction Versions consume it.

## Readiness and locks

Sources without Documents have separate readiness identities, names, statuses and reasons. They never increase Document counts or create a fictitious Document. Import Date determines where unfinished Source work is visible; it creates no Tax Point Date or accounting assignment. Deliberate Source exclusion is resolved work. The readiness RPC aggregates the whole set independently of PostgREST's row limit.

New report snapshots save `result.sourceFilesReadinessSource`. Saving and finalization compare it under the Company lock, alongside the existing Document and Company snapshots. Unresolved Sources block finalization. Resolving a Source after generation makes that earlier draft stale.

A Source mutation is refused when that exact Source belongs to a locked report's Source readiness snapshot. This protects exclusion reversal, retry, manual definition and original deletion. A Company having another locked period does not make unrelated or newly arrived unassigned Sources immutable. Existing Document Period Locks remain authoritative after definition, including the narrow first User Version preservation rule and refusal of approval or later edits in a locked period.

Legacy snapshots without Source entries are treated as an empty saved Source set. An old unlocked draft that omitted current Source work must be regenerated before finalization. Existing locked snapshots and XML are preserved. Missing historical Source membership creates no invented accounting date or blanket Source lock.

## Further Source associations

Workbook row definition is the separate ticket178. It can reuse Company/Source ownership locking, request invalidation, snapshot membership guards, batch reopening and reasoned exclusion. This ticket accepts only PDF/image page definitions; workbook ranges require validation against actual sheet contents.

A later attachment command (ticket175) must check the Source snapshot lock as well as the Document's ordinary Period Lock before associating a Source. Attaching an existing Source must not bypass the Source guard merely because its row would stay unchanged. Retain Company-first locking and explicit AI authorization.

## Verification

The application/worker tests exercise real local Auth and RLS, preserved originals and immutable User history, stale Split success and failure, duplicate jobs, fresh retries and remediation compensation. Deterministic database barriers coordinate actual application commands for generation/finalization races; assertions observe public results and saved state. Legacy draft metadata is prepared only in fixtures. The completeness case uses 1,001 actual stored originals and creates no Documents. Browser coverage completes PDF and image recovery without AI configuration, including overlap refusal, valid Tax Point Date, approval, Source exclusion/reversal and a rendered HEIC preview.
