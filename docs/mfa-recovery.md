# Lost-authenticator recovery

From login, request a password recovery email and explicitly verify its link.
If the authenticator is lost, choose the backup-code option and enter one unused
code saved during MFA setup. Confirm replacement, set up the new authenticator,
verify its code and choose a new password. All sessions remain restricted until
recovery finishes. Other unused prepared codes remain valid.

Reloading an unfinished setup can continue with an already saved authenticator
code, or explicitly restart setup to obtain a new QR code. A failed native step
leaves the account restricted and can be retried. If the password already changed
but cleanup failed, finish recovery again without changing it a second time.

After session loss or email-intent expiry, verify a fresh recovery email. The
original device can continue using its protected continuation cookie; another
device needs another unused backup code. A used code cannot be reused, and
losing or expiring the cookie never releases the restriction. Without either
proof, recovery requires an operator's separate account-recovery process; email
alone cannot authorize factor replacement.

Auth owns factors, native AAL2, passwords and refresh-session revocation. The
application stores only private recovery authority and access restrictions, as
described in [ADR-0016](adr/0016-invitations-authorize-narrow-auth-administration.md).
Native Auth recovery-code APIs were tested on v2.197.0 with experimental flags:
they work for newly generated native codes but cannot import existing prepared
iVAT hashes. This flow preserves those codes rather than silently invalidating
them or writing unsupported Auth session state.

Local proof uses the worktree's native Auth and Mailpit. Focused checks include
`tests/mfa-replacement.test.ts`, existing MFA/password tests and the browser
recovery journeys. Cases exercise concurrent code use, real competing AAL2
sessions, enrollment finishing after cleanup, stale JWTs, failed deletion/logout,
legitimate continuation and mandatory MFA. Production SMTP proof is separate.
