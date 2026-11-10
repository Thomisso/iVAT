# Repository publication

Keep production credentials, private operator records, original account-specific
design references and database/backup archives outside version control. The
example environment intentionally leaves Supabase keys empty; `npm run db:start`
writes this checkout's actual keys to ignored `.env.local`. Use the supported
`bootstrap:superadmin` command with an explicit identity instead of personal SQL
snippets. New commits should use the maintainer's GitHub no-reply email.

The removed local API-key values were also embedded as public defaults in the
distributed Supabase CLI. Removing those defaults does not by itself require
credential rotation or a database restart. Rotation applies to installation-specific
secrets that were exposed; keep local stacks restricted to trusted access.

## One-time history cutover

Content cleanup on a branch does not remove the original values from Git
history. Before changing visibility:

1. Retain protected, verified Git bundles and the installation-specific operator
   record outside the repository. Preserve local-only branches, worktrees,
   uncommitted work and the shared tracker journal.
2. Merge the reviewed publication cleanup, then prepare a fresh mirror of every
   advertised branch, tag and pull-request ref. Remove local keys, the private
   administrator snippet, the original account page and installation-specific
   records from every historical version. Replace private author/committer/tagger
   email with the maintainer's GitHub no-reply address.
3. Verify every rewritten ref, the complete reachable object set and the retained
   PDF pages. Scan the current tracked tree, history and commit messages for
   secrets. Keep the old-to-new commit map privately; never publish original
   credentials or removed operator records as audit evidence.
4. Invalidate any credential that could remain accessible in an old object,
   clone or cache. A local database reset is not a key-rotation procedure.
   Keep the human database and services intact; a supported local key change
   must preserve data and be verified before the old credential is considered
   revoked.
5. Back up unnecessary historical test traces and credential-bearing CI logs
   privately before deleting them. Retain release manifests and verification
   evidence required to identify or recover deployed images.
6. During the approved cutover, stop new Git writes, compare all remote branch
   and tag tips with the prepared snapshot, and push the reviewed replacements
   atomically with an explicit lease for every updated ref. Do not use a broad
   mirror push that could delete unrelated refs. Check the remote tips again.
7. GitHub pull-request refs are read-only and old commits can remain accessible
   through PRs or cached SHA views after a force push. Confirm their removal
   through a supported GitHub capability; if that capability is unavailable,
   publication remains outstanding. Do not claim a successful cleanup from
   branch/tag replacement alone.
8. Recreate working copies from the clean history, preserving uncommitted and
   local-only work separately. Do not merge or push old branches into the
   cleaned repository. Preserve tracker state for recovery and treat recorded
   old revisions as historical evidence, not approval for a rewritten commit.

A history rewrite changes release tags' commit identities and can invalidate
commit signatures and old source-verification records. Running containers and
immutable image digests remain unchanged. Before the next deployment, run fresh
full release verification for the actual new source revision; do not map old
verification success onto a new commit automatically.

Repository visibility changes only after the cutover and final readback succeed.
A new clean repository is an alternative when the original repository's retained
pull-request/cached objects cannot be removed; it requires a separate migration
decision and does not preserve the original issue/PR history automatically.

GitHub documents the [effects of publication](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/managing-repository-settings/setting-repository-visibility)
and [sensitive-data removal](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/removing-sensitive-data-from-a-repository).
