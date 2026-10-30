# SuperAdmin has platform-wide access without Memberships

The SuperAdmin Role grants access to every Organization and Company, including their administrative functions, without requiring a Membership. This replaces membership-only tenant access for SuperAdmin so platform administration can work across tenants without artificial Memberships; other Roles retain their scoped access. PostgreSQL remains the authority for visibility and actions under ADR-0008, so this is an authorization change rather than merely showing additional navigation links.

SuperAdmin acts under their own identity without impersonation, with mandatory MFA, audited actions and the same business safeguards as an Administrator. Period Locks must be explicitly unlocked before protected data changes. SuperAdmin may enter and administer a blocked Organization, but ordinary processing resumes only after unblocking; a deleted Company exposes retained history and audit without automatic restoration or ordinary processing.
