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

5. Restart the local stack (`npm run db:stop`, then `npm run db:start`) so
   Supabase Auth reads the credentials.

The committed configuration uses non-secret placeholders when those variables
are absent. This keeps local development and CI available, but Google sign-in
only works after real credentials are supplied.

For a hosted Supabase project, enable Google in the project's Auth provider
settings, enter the same client credentials, and allow the deployed
`https://<app-host>/auth/callback` URL.

## First sign-in and matching email addresses

A first-time Google user is created through the same database trigger as an
email/password user: creation of the Auth user atomically creates an
Organization and its Organization-level Administrator Membership. The Google
display name names the initial Organization; the email address is the fallback.

Supabase Auth automatically links an OAuth identity to an existing user with
the same verified email address. Therefore Google sign-in for an existing
email/password account reuses that user and its existing Memberships; it does
not create a second Organization. This is Supabase Auth's automatic identity
linking behavior, not custom iVAT account matching.

References: [Supabase Google sign-in](https://supabase.com/docs/guides/auth/social-sign-in/auth-google),
[Supabase identity linking](https://supabase.com/docs/guides/auth/auth-identity-linking).
