# Personal password change

`/settings/security` changes the signed-in User's password. Current password,
matching new-password confirmation and at least eight characters are required.
Passwords are never returned in form state or logged as Server Function arguments.

`changePassword` reads the identity from the original AppClient. The narrow
`supabasePasswordVerifier` signs in with that identity's email using a fresh
in-memory publishable-key client, with persistence and automatic refresh disabled.
It signs out only its temporary session (`scope: local`) and disposes the client
before returning success. A verification or cleanup refusal prevents the change.
No request cookies or original-session state are supplied to that client.

The password update runs on the **original** AppClient, passing `current_password`.
[GoTrue v2.197.0](https://github.com/supabase/auth/blob/v2.197.0/internal/api/user.go)
requires actual AAL2 when a verified MFA factor exists and performs the update
without removing factors. Its supported password-update operation revokes other
refresh sessions while retaining the current session. Already issued access JWTs
remain usable until expiry; this is not immediate access-token revocation.

Production Compose also enables
`GOTRUE_SECURITY_UPDATE_PASSWORD_REQUIRE_CURRENT_PASSWORD=true`. Supabase CLI
2.122 does not expose that flag; `secure_password_change` is a different
reauthentication/nonce policy. Sending `current_password` alone under the CLI
therefore does not establish enforcement. The independent real-Auth verifier is
used in both environments and tested against the actual local Auth service.

Initial invited password creation and token-authorized recovery are separate
flows. They must not call this normal-change command with an empty or bypassed
current password. The command does not grant a recovery exception based on a
client flag. Pinned `verifyOtp(type: recovery)` currently emits an `otp` AMR claim,
so a future recovery authority must not infer recovery from a literal JWT method
named `recovery`.

Focused evidence lives in `tests/password-change.test.ts` and
`e2e/password-change.spec.ts`: wrong password, field validation, real AAL1 refusal
and AAL2 preservation, temporary-session revocation, failure to revoke that session,
current-versus-other refresh sessions, CS/EN UI and unchanged browser auth tokens.
