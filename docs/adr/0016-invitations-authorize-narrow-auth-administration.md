# Invitations authorize narrow server Auth administration

A seven-day Invitation is an application capability, independent of short-lived
Supabase Auth email tokens. Its recoverable token is encrypted in Vault and
only scoped Administrators can retrieve it. Opening its landing page performs
no authentication or acceptance; the explicit acceptance action supplies the
password or uses the matching signed-in identity.

Commands still take an `AppClient`, and PostgreSQL remains the authority for
scope, Role and lifecycle. A narrow server Auth adapter receives a database-issued
one-minute acceptance claim, never an arbitrary email or User id. Claims serialize
onboarding for one email. For a genuinely new identity the database reserves its
User id; the Auth insert trigger locks the Invitation and claim, checks the email
and validity, and sets a trusted provisioning origin before tenant creation.
GoTrue applies caller `app_metadata` after its initial insert, so passing metadata
alone cannot protect the tenant trigger. The adapter uses Auth's atomic
`createUser` with the chosen password and reserved id; existing identities only
sign in, and their credentials are never replaced by onboarding.

Detached Auth sessions reach browser cookies only after the same authoritative
acceptance transaction creates the Membership. Cancellation, replacement and
acceptance lock the Invitation consistently. Aborting or cancelling a claim
removes only its newly provisioned, unaccepted identity with no Membership,
under the Auth User row lock; Auth foreign keys remove its temporary sessions.
This deliberately narrow database cleanup cannot delete a preexisting or accepted
identity. Expired interrupted claims are cleaned before a new claim starts.
`SystemClient` remains worker-only under ADR-0010; the server Auth adapter exposes
only these claim-scoped operations, without general service-role application
queries or writes. Audit events continue using the real User and contain no
Invitation token, password or User personal data.

Invitation mail uses a small server SMTP transport with the same private managed
mailbox configuration as Auth. Auth remains the password and recovery authority;
its invite/verify API has no atomic chosen-password-at-verification operation.
Using that mailer would require placeholder identities and later password
replacement, so Invitations instead send their persistent application URL
without creating an Auth identity. Password recovery mail still originates in
Auth. Both transports require authenticated encrypted SMTP in production; only
explicit loopback Mailpit capture permits plaintext without authentication.
New links keep the capability in the URL fragment, and development Server
Function argument logging is disabled so credentials and links stay out of logs.

The provider behavior is pinned to [GoTrue v2.197.0 admin creation](https://github.com/supabase/auth/blob/v2.197.0/internal/api/admin.go)
and [email verification](https://github.com/supabase/auth/blob/v2.197.0/internal/api/verify.go).
The adapter and real-Auth race tests must be rechecked when upgrading Auth.

Password recovery uses the same narrow trusted-adapter boundary. A private
one-hour request capability is bound to the Auth User and delivered only inside
the native recovery email; request responses reveal neither that capability nor
account existence. Explicit native recovery verification plus that capability
authorizes a one-use reset intent bound to the returned Auth session. A service-only
database operation checks the fresh native session and request owner before
binding them; ordinary clients cannot issue or authorize these intents. This is
necessary because [pinned Auth classifies OTP, MagicLink and Recovery as recovery
methods](https://github.com/supabase/auth/blob/v2.197.0/internal/models/factor.go),
and implicit recovery JWTs use `otp`, so AMR alone cannot establish the
specific email-recovery request. Native Auth still verifies the email token,
enforces its one-hour expiry and single use, requires actual AAL2 for an enrolled
authenticator, updates the password and revokes other refresh sessions. The
application intent grants no MFA elevation or data access, never removes a
factor, and writes only private application state; native Auth tables are read
for identity/session binding, without unsupported changes to their internals.
