# First-ticket acceptance evidence

Verified on 4 November 2026 for ticket #201. Later #200 slices require their own focused checks and the final combined Standards/Spec review.

The production Project is [iVAT — Agent implementation](https://github.com/users/Thomisso/projects/1), with dedicated registry issue #207. Local Projects authorization and the separate Actions secret were configured with the owner's authorization. Production workflow activation awaits the code reaching the default branch; this evidence does not claim the unmerged production workflow ran.

Live testing used a dedicated private acceptance repository, a separate Project and synthetic parent/implementation issues. Its default branch contained the tracker-only implementation, allowing real dispatch before the iVAT feature merges. The scratch commit observed in the claimed local branch was `841bf0e…`.

- Initial setup encountered and correctly corrected a real provider restriction: `Reviewer` is a reserved custom-field name. The field is now `Review agent`, distinct from native GitHub review-account fields. Repeated setup reused the partially created fields and the same registry comment.
- Both selected dedicated Projects initially had enabled native workflows that could alter progress independently. Their enabled workflows were explicitly removed through the API, and the actual doctor/setup checks then passed.
- [Start execution 41825728541](https://github.com/Thomisso/ivat-agent-tracking-acceptance/actions/runs/41825728541) acquired run `acceptance-201`, generation 1, and returned a projected acknowledgment for revision 1.
- [Claim execution 41825888752](https://github.com/Thomisso/ivat-agent-tracking-acceptance/actions/runs/41825888752), [duplicate 41825922785](https://github.com/Thomisso/ivat-agent-tracking-acceptance/actions/runs/41825922785) and [sync retry 41825926429](https://github.com/Thomisso/ivat-agent-tracking-acceptance/actions/runs/41825926429) all completed successfully. The local CLI reported synchronized revision 2.
- Actual Project inspection found exactly one item referencing the original synthetic implementation issue, with `Implementace`, `Neověřená`, implementing agent `acceptance-worker`, working branch `main`, and native responsible assignee `Thomisso`. Claiming work did not create a verified-activity timestamp.
- Exactly one maintained issue status comment was present. It contained the actual local branch commit and revision 2. Duplicate execution preserved the original state time `2026-11-04T12:02:48.869Z` and did not duplicate either the Project item or comment.

The command tests separately exercise missing/incomplete configuration, conflicting native workflows, missing permission, retained pending writes, original timestamps, absent local branches, linked-worktree ownership and idempotent publication. The real `gh`/Postman HTTPS verifier exercises controlled wire-level failures and partial publication; its simulation context records the model limits. These checks do not make a hard real-time scheduling claim or assert an atomic upstream transaction across all GitHub objects.
