# Document review acceptance (#222 / #242)

This inventory maps A01–A33 to observable acceptance sources in the combined implementation. A file's presence is not a passing execution result. Final shared checks and independent Standards/Spec review must identify their actual resulting revision. Browser case references below are source references; they do not claim a browser was run during #242.

The new acceptance uses real local Auth/RLS and existing public application commands/queries. `tests/document-review-composition.test.ts` joins evidence, human eligibility, Partial Claim, directory selection, warning acknowledgement, atomic replay, filtered queue continuation and saved report/history in one Company User journey. It does not establish visual layout, focus, Inspect rendering or browser navigation.

| ID | Acceptance sources and distinct observable boundary |
| --- | --- |
| A01 | `e2e/review-workspace.spec.ts`: laptop comparison desk, resize/independent scrolling/mobile retained values. |
| A02 | `e2e/review-workspace.spec.ts`, `e2e/czech-dates.spec.ts`, `e2e/partial-claim.spec.ts`: form order, Czech date/decimal entry, visible error focus. |
| A03 | `tests/document-approval.test.ts`, `e2e/atomic-document-approval.spec.ts`, workspace pending/refusal cases: atomic current correction/approval, lock/conflict refusal and retained input. |
| A04 | `tests/document-approval.test.ts`, `tests/document-counterparty-links.test.ts`, `tests/document-review-composition.test.ts`: changed warning/value/context consent, no partial save while paused. |
| A05 | Approval/counterparty-link suites and composition: same-request replay, double submission, stale different request, one Version/directory identity/decision. |
| A06 | Workspace departure/history cases; approval/manual suites: save/discard/stay and invalid Tax Point Date refusal. First recovery Version saved by the departure coordinator remains a distinct unexecuted navigation check. |
| A07 | `e2e/documents-queue.spec.ts`, workspace rejection/restore cases; composition checks actual filtered remaining Document and no invented direct-entry queue through public queries. |
| A08 | `e2e/review-shortcuts.spec.ts`: bell adjacency, contextual guide/focus/Escape, Control/Meta, composition, modality, pending/history/lock guards. |
| A09 | `tests/source-evidence.test.ts`, `e2e/source-evidence.spec.ts`: original PDF page mapping, normalized highlights, Inspect/zoom/resize/history and before-first-Extraction source access. |
| A10 | `tests/source-formats.test.ts`, `tests/workbooks.test.ts`, `e2e/source-formats.spec.ts`: png/jpeg, persisted normalized HEIC/HEIF, real xls/xlsx worksheet/absolute cells/header, invalid locations informational. |
| A11 | Source-evidence/source-formats suites and composition: manual provenance with original locations, new AI's own evidence, unchanged historical values and original bytes. |
| A12 | `tests/counterparties.test.ts`: both directory roles, every effective Company Role, real isolation/audit and paging. |
| A13 | `tests/document-counterparty-links.test.ts`: normalized unique identity, conflicting identifiers/manual decision, name-only non-match and live directory differences without historical rewrite. |
| A14 | Counterparty/link suites and `e2e/counterparty-lifecycle.spec.ts`: concurrent identities, archived restoration, current/historical reference deletion guards. |
| A15 | Counterparty-link suite: creation belongs to successful approval, fresh Party/Direction no-ID consent, refusal rolls back entry/link/audit. |
| A16 | `tests/partial-claims.test.ts`, `e2e/partial-claim.spec.ts`: explicit activation, full amount seed, no AI/discrepancy-authored choice. |
| A17 | `tests/partial-claim-report.test.ts`, partial-claims suite and composition: literal 12000/2520 full and 6000/1260 selected, B.2 whole-value threshold, XML/PDF `pomer=N`. |
| A18 | Partial-claims/report suites: independent original arithmetic and selection validation, no false remainder, direct authenticated refusals. |
| A19 | Partial-claims/report suites: mixed rates/shared foreign fixing, confirmed zero with no fictitious deduction or KH row. |
| A20 | Partial-claims and automatic-approval suites: changed originals/new AI preserve prior choice unconfirmed; stored report remains unchanged. |
| A21 | `tests/claim-period.test.ts`: actual Prague Import Date and generated frequency; explicit monthly January DUZP/January issue plus March import gives no inferred January eligibility; human confirmation/source-independent null Import Date. |
| A22 | `tests/claim-deadlines.test.ts` and reviewed deadline research: pre/post-2025 distinction, inclusive 1 July 2014 example, verified Czech non-working-day boundaries. |
| A23 | Deadline suite: 31 December 2027, supported monthly/quarterly period limits, today's fresh-export check versus exact archived download. |
| A24 | Claim-period suite and real upgrade fixture: direct RC/EU deferral refusal; retained genuine old RC assignment blocks both periods until explicit resolution, without rewriting archive. |
| A25 | Automatic-approval suite: default off, Administrator/SuperAdmin access and audit, no manual/settings/check backlog trigger; upgrade fixture proves off for actual pre-feature Companies. |
| A26 | Automatic-approval/source-formats suites: errors/warnings/duplicates/mapping/verification/period prevent automation; absent locations and provider confidence do not independently block it. |
| A27 | Automatic-approval suite: concurrent/replayed completion, policy toggled off/on, directory change/human takeover, duplicate ordering, locked target, reserved worker authority and one directory identity. |
| A28 | Automatic-approval suite: preserved successful Extraction/one allowance on approval failure, no orphan, later warning/duplicate leaves approval and locked report intact. |
| A29 | `tests/document-review.test.ts`, `tests/return-to-review.test.ts`, `tests/bank-advisories.test.ts`, workspace/shortcuts readonly cases: recorded/current distinction, authoritative locks, independent permitted Bank Account Check. |
| A30 | Manual-document/document-recovery/source-recovery/extraction-preparation suites; format source-independent case; actual upgrade's source-independent legacy Version: truthful source/date/author and no AI allowance. Departure-first-save is separately identified under A06. |
| A31 | `tests/extraction-preparation.test.ts`, `tests/ai-processing-failures.test.ts`, processing/manual-source-AI suites: three public entry paths, real job handler, retry/platform/final distinctions, request generation and usage preservation. |
| A32 | Review/bank-advisory suites and actual upgrade: current versus recorded findings, late previous-Version result isolation, readable legacy Versions/reports without invented metadata. |
| A33 | Reviewed documentation commit `085ec43c34fe2f0651e0491884423a6ae0ed6f45` contains the seven approved artifacts. Preserve its ancestry and original manifest evidence; later intentional edits require applicable review. |

## Actual upgrade procedure

Run only in an owned, already running linked-worktree stack, with other users of that lane stopped:

```sh
node scripts/verify-document-review-upgrade.mjs --slot 11 --confirm-reset
```

This command deliberately destroys that named local lane's data. It refuses the main checkout and requires matching slot reservation, generated project ID, loopback API/DB ports and Docker database binding. It refuses a running acceptance server on port 3142 or an interrupted claim-clock fixture. It never selects a linked/remote database.

The runner extracts baseline `5e60cba61410dc80fc48f9c03a2de1f1342b30aa` privately and verifies matching locked dependency/setup files. It resets only the named lane to migration `20261129090000`, creates real old AI/manual Versions and finalized XML archives through baseline commands as authenticated Users, captures immutable public results/stored values/bytes, applies all pending migrations without reset, and runs separate current-code assertions against those same identities. Neither stage uses baseline's CWD-dependent default global setup.

Current assertions compare saved Versions, extraction request identities, report/lock/transition metadata, source and artifact bytes before any current accounting edit; verify no invented selection/confirmation/evidence/link, directory entries or automation; and compare allowance. A genuine legacy RC deferral must block new preparation while its old archive remains downloadable. Only then does explicit unlock/Return to Review/assignment resolution/current approval create legitimate new history. The original Version/report/archive stays unchanged. The exact native business-clock definition is checked before and after the controlled current-date fixture.

Private manifests and technical result files are retained under the reported temporary directory. Local service context is mode 0600 and removed on success; it must not be copied into review or tracker messages. A result records the actual HEAD plus any working-tree changes and does not substitute for final checks on the merged revision.
