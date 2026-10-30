# Google sign-in

iVAT uses Supabase Auth's server-side PKCE flow. The browser returns to
`/auth/callback`, where iVAT exchanges the one-time code for a Supabase session.

## Local setup

1. In Google Auth Platform, create an OAuth 2.0 client with application type
   **Web application**.
2. Add the URL where Next.js runs as an authorized JavaScript origin, normally
   `http://127.0.0.1:3000` (or the free port used by a worktree, such as `3100`).
3. Start the checkout's Supabase stack once with `npm run db:start`, then run
   `node scripts/supabase.mjs status -o json`. Add the reported `API_URL` plus
   `/auth/v1/callback` as an authorized redirect URI in Google. The main
   checkout normally uses `http://127.0.0.1:54321/auth/v1/callback`; worktrees
   intentionally use a different port.
4. Create a gitignored `.env` at the repository root:

   ```dotenv
   SUPABASE_AUTH_EXTERNAL_GOOGLE_CLIENT_ID=<google-client-id>
   SUPABASE_AUTH_EXTERNAL_GOOGLE_CLIENT_SECRET=<google-client-secret>
   ```

5. Set `enabled = true` under `[auth.external.google]` in
   `supabase/config.toml`, then restart the local stack (`npm run db:stop`, then `npm run db:start`) so
   Supabase Auth reads the credentials.
6. Set `APP_ORIGIN` and `AUTH_REDIRECT_ALLOWLIST` in `.env.local` to the actual
   application origin and its exact `/auth/callback` URL. Worktree dev ports
   differ from the default; request Origin headers never choose the callback.

The committed provider is disabled. Startup supplies no fake credentials. Login
shows the Google button and separator only when Auth's public settings advertise
Google and confirm that public signup is disabled. Missing settings, errors and
unsafe signup configuration hide the option; direct actions enforce the same
condition. Never enable the provider with example or placeholder credentials.

For a hosted Supabase project, enable Google in the project's Auth provider
settings, enter the same client credentials, and allow the deployed
`https://<app-host>/auth/callback` URL.

For self-hosted Compose, the default is also disabled. Set
`SUPABASE_AUTH_EXTERNAL_GOOGLE_ENABLED=true` and the existing client-id/secret
variables in the private deployment environment only after configuring the
provider. They are passed to Auth, never exposed as application credentials.
Keep `GOTRUE_DISABLE_SIGNUP=true` and the exact application callback allowlist.

## Existing identities and closed registration

Public registration is closed. Keep the top-level `[auth] enable_signup = false`
locally and `GOTRUE_DISABLE_SIGNUP=true` in the deployed Auth service. Keep the
email provider enabled: `[auth.email] enable_signup = true` controls that provider,
not the global signup policy. Native Auth refuses new OAuth accounts under the
global policy, and the database also rejects new non-email provider Users before
creating any Organization. Enabling Google never opens public provisioning.

Supabase Auth automatically links an OAuth identity to an existing user with
the same verified email address. Therefore Google sign-in for an existing
email/password account reuses that user and its existing Memberships; it does
not create a second Organization. This is Supabase Auth's automatic identity
linking behavior, not custom iVAT account matching.

Private local bootstrap/QA provisioning and administrator-issued Invitations
remain the account-creation boundaries. The trusted Invitation claim guard
owns its reserved Auth identity; the ordinary new-user trigger does not create
an unrelated Organization for an invitee. Public signup's future design remains
[#158](https://github.com/Thomisso/iVAT/issues/158).

Focused local checks:

```bash
npx vitest run tests/sign-up.test.ts tests/companies.test.ts tests/invitation-urls.test.ts
PLAYWRIGHT_BASE_URL=http://127.0.0.1:3102 npx playwright test e2e/closed-signup.spec.ts e2e/auth-account-shell.spec.ts
```

These do not call live Google. Application tests use the real SDK and Auth,
with a controlled settings response for the configured-provider branch. The
OAuth insertion invariant is tested under the actual `supabase_auth_admin`
database identity, because admin-create metadata is applied after the initial
Auth INSERT and does not reproduce an OAuth callback's new-user trigger.
For a disposable configured-provider UI check, run the browser command with
`TEST_GOOGLE_CONFIGURED=1` after explicitly enabling Google in that isolated Auth
configuration. This only changes test expectations. Synthetic credentials can
exercise the settings/button branch without starting OAuth; they do not prove
that Google accepts real deployment credentials. Restore the disabled default
with the normal local startup wrapper afterwards.

References: [Supabase Google sign-in](https://supabase.com/docs/guides/auth/social-sign-in/auth-google),
[Supabase identity linking](https://supabase.com/docs/guides/auth/auth-identity-linking).
The pinned Auth implementation rejects OAuth account creation under the global
switch in [external.go](https://github.com/supabase/auth/blob/v2.197.0/internal/api/external.go#L343).
