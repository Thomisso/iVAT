# Agent tracking acceptance evidence

Verified slices #201–204 on 4–5 November 2026. Independent freshness (#205), final gates (#206) and the parent’s combined verification remain outstanding in this draft.

## First-ticket reporting (#201)

The production Project is [iVAT — Agent implementation](https://github.com/users/Thomisso/projects/1), with dedicated registry issue #207. Local Projects authorization and the separate Actions secret were configured with the owner's authorization. Production workflow activation awaits the code reaching the default branch; this evidence does not claim the unmerged production workflow ran.

Live testing used a dedicated private acceptance repository, a separate Project and synthetic parent/implementation issues. Its default branch contained the tracker-only implementation, allowing real dispatch before the iVAT feature merges. The scratch commit observed in the claimed local branch was `841bf0e…`.

- Initial setup encountered and correctly corrected a real provider restriction: `Reviewer` is a reserved custom-field name. The field is now `Review agent`, distinct from native GitHub review-account fields. Repeated setup reused the partially created fields and the same registry comment.
- Both selected dedicated Projects initially had enabled native workflows that could alter progress independently. Their enabled workflows were explicitly removed through the API, and the actual doctor/setup checks then passed.
- [Start execution 41825728541](https://github.com/Thomisso/ivat-agent-tracking-acceptance/actions/runs/41825728541) acquired run `acceptance-201`, generation 1, and returned a projected acknowledgment for revision 1.
- [Claim execution 41825888752](https://github.com/Thomisso/ivat-agent-tracking-acceptance/actions/runs/41825888752), [duplicate 41825922785](https://github.com/Thomisso/ivat-agent-tracking-acceptance/actions/runs/41825922785) and [sync retry 41825926429](https://github.com/Thomisso/ivat-agent-tracking-acceptance/actions/runs/41825926429) all completed successfully. The local CLI reported synchronized revision 2.
- Actual Project inspection found exactly one item referencing the original synthetic implementation issue, with `Implementace`, `Neověřená`, implementing agent `acceptance-worker`, working branch `main`, and native responsible assignee `Thomisso`. Claiming work did not create a verified-activity timestamp.
- Exactly one maintained issue status comment was present. It contained the actual local branch commit and revision 2. Duplicate execution preserved the original state time `2026-11-04T12:02:48.869Z` and did not duplicate either the Project item or comment.

The command tests separately exercise missing/incomplete configuration, conflicting native workflows, missing permission, retained pending writes, original timestamps, absent local branches, linked-worktree ownership and idempotent publication. The real `gh`/Postman HTTPS verifier exercises controlled wire-level failures and partial publication; its simulation context records the model limits. These checks do not make a hard real-time scheduling claim or assert an atomic upstream transaction across all GitHub objects.


## Membership and parent views (#202)

The isolated [acceptance Project](https://github.com/users/Thomisso/projects/2) contains existing issue references. Actual readback verified Status columns on the board's `verticalGroupByFields` axis, a native parent filter on the specification table, and no implementation Status on parent #1. Horizontal grouping is a separate axis; an earlier verification error was corrected against provider readback.

[Automatic discovery 42064709894](https://github.com/Thomisso/ivat-agent-tracking-acceptance/actions/runs/42064709894) added newly approved child #5 as Připraveno/Neaktivní while preserving already owned tickets #2 and #4. [Label-removal reconciliation 42065186364](https://github.com/Thomisso/ivat-agent-tracking-acceptance/actions/runs/42065186364) retained the same Project item. The selected native-parent table filter and the parent’s maintained overview were verified on actual GitHub objects.

## Review, integration and dependencies (#203)

Synthetic ticket #5 changed only one README marker. Focused `git diff --check` and `node --check` passed for exact revision `3f9fdb09938b51a35fff3382d02584936a5d9930`. A fresh independent reviewer inspected its pinned base and diff and reported Standards PASS / Spec PASS without findings. [Review result 42070641723](https://github.com/Thomisso/ivat-agent-tracking-acceptance/actions/runs/42070641723) recorded that attestation; [integration 42070734085](https://github.com/Thomisso/ivat-agent-tracking-acceptance/actions/runs/42070734085) corroborated actual merge `5c6024954bcb53d4edccba4360f5b7a510c6f99e` into the intended synthetic integration branch. Project Status became V integrační větvi while issue #5 remained open.

[Readiness 42070841854](https://github.com/Thomisso/ivat-agent-tracking-acceptance/actions/runs/42070841854) accepted internal integration of #5 but kept dependent #7 blocked by external fixture #6, which was closed without a merged PR. Removing only that external dependency made #7 ready; [claim 42071268622](https://github.com/Thomisso/ivat-agent-tracking-acceptance/actions/runs/42071268622) then succeeded while #5 was still open. Mere closure did not establish delivery.

## Recovery and fencing (#204)

[Same-computer resume 42071606694](https://github.com/Thomisso/ivat-agent-tracking-acceptance/actions/runs/42071606694) reconstructed and synchronized the original run. [Explicit stop 42071707272](https://github.com/Thomisso/ivat-agent-tracking-acceptance/actions/runs/42071707272) released ownership with validated history, retained phases and made its tickets inactive. [Restart 42071844604](https://github.com/Thomisso/ivat-agent-tracking-acceptance/actions/runs/42071844604) acquired generation 2 without restarting historical workers.

An empty separate clone could not attach with ordinary resume. [Explicit takeover 42072090451](https://github.com/Thomisso/ivat-agent-tracking-acceptance/actions/runs/42072090451) acquired a different logical run at generation 3; the old controller’s attempted phase update was refused as `run_superseded`. [Explicit same-ID recovery 42072679007](https://github.com/Thomisso/ivat-agent-tracking-acceptance/actions/runs/42072679007) in another fresh clone advanced to generation 4 and fenced generation 3. Recovery identified missing unpublished history rather than claiming it was recovered. The procedure used the current tracker version, including when a synthetic working branch retained an older copy.

Live historical reclaim exposed an inactive-phase edge case. Regression tests now keep review/integrated work inactive and refuse changed reviewed tips. [Negative run 42073242034](https://github.com/Thomisso/ivat-agent-tracking-acceptance/actions/runs/42073242034) intentionally failed with `historical_revision_mismatch`; [exact-tip reclaim 42073275746](https://github.com/Thomisso/ivat-agent-tracking-acceptance/actions/runs/42073275746) succeeded at synchronized revision 27. Actual Project fields retained V integrační větvi/Neaktivní, the original state time `2026-11-05T17:03:02.426Z`, reviewed revision and integration evidence.

The composed source passed 59 public CLI subprocess tests, typecheck and lint (one pre-existing unused-import warning). Independent ticket and fix reviews were clean. Controlled failure/lost-response tests and the 13-case real `gh`/Postman verifier complement this live evidence; they do not turn mocked failures into claims about live scheduling or atomic provider transactions.
