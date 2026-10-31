# QA v5 final local verification (#179)

The ready-profile [cloud CI run 41162978978](https://github.com/Thomisso/iVAT/actions/runs/41162978978)
at `3dc4bd8bb05abdb02321e0db0d01f6cf530a5752` failed the application suite:
878 passed, four failed and six optional checks skipped (1019.67 seconds;
84 passing files, two failing files and six skipped files). The same run's
complete 85-case browser job passed, and
[Deployment verification 41162979086](https://github.com/Thomisso/iVAT/actions/runs/41162979086)
passed, including actual image/proxy assets and release identity. The required
application check remains unsatisfied until the reviewed correction receives
fresh complete integration and cloud verification. Focused proof is recorded
below; the earlier passing local results retain their exact historical revisions.

Earlier local integration verification passed the complete 85-case production
browser suite and live Next/React runtime checks at
`e36ed6266badc247e7051a4a1688be4a6d0a4c6b`. The fresh application and updated
full host results below were executed at `cf16536ae79e8e9a2583fbdc74f94f4108b92c40`
and carried across the subsequent one-line CSS/browser-fixture correction at
that revision.
Earlier failures and pre-fix passing runs remain separate history below.

Verified on 31 October 2026 in the isolated integration worktree, after all
ticket stacks stopped. Tests ran sequentially on Docker Desktop for macOS with
Linux containers. Local Auth, PostgreSQL, Storage, SMTP capture, application,
and worker processes were real. Test identities and financial data were
synthetic; external AI, VAT registry, exchange-rate and provider-control
dependencies used the existing fake adapters or Postman simulations. No paid
provider or live Google calls were made.

## Earlier passing local results and exact revisions

| Check | Revision | Result | Elapsed |
| --- | --- | --- | --- |
| `npm ci` | `cf16536ae79e8e9a2583fbdc74f94f4108b92c40` | Passed | 6.86 s |
| Fresh `npm run db:start -- --profile=e2e`, `npm run db:reset`, `npm run db:types` and generated-type diff | `cf16536ae79e8e9a2583fbdc74f94f4108b92c40` | Passed; generated types matched | 26.96 s / 24.76 s / 0.47 s |
| `npm run test:serial` | `cf16536ae79e8e9a2583fbdc74f94f4108b92c40` | 882 passed, 6 skipped; 86 passing files, 6 skipped files | 345.35 s test / 345.83 s command |
| `npm run typecheck` | `cf16536ae79e8e9a2583fbdc74f94f4108b92c40` | Passed | 2.72 s |
| `npm run lint` | `cf16536ae79e8e9a2583fbdc74f94f4108b92c40` | Passed | 5.32 s |
| CI policy, release identity, prepare, host and connect Node checks | `cf16536ae79e8e9a2583fbdc74f94f4108b92c40` | 23 passed | 8.77 s |
| Updated full opt-in host/SSH runtime fixture, including six public assets | `cf16536ae79e8e9a2583fbdc74f94f4108b92c40` | 3 passed, zero skipped | 192.61 s |
| Four affected browser cases, plus typecheck and lint | `53a22d7db08ce3067ab91cdae6e2e3111c43c435` | 4 passed, zero skipped; static checks passed | 26.3 s browser |
| Complete repository production E2E command | `e36ed6266badc247e7051a4a1688be4a6d0a4c6b` | 85 passed, zero skipped | 315.2 s browser phase / 352.90 s command |
| Next development runtime and browser checks | `e36ed6266badc247e7051a4a1688be4a6d0a4c6b` | MCP, React inspection and all 40 layout observations passed | Separate runtime confirmation |

The six serial-suite skips are five opt-in live-provider contract checks and
one optional OpenAI simulation check. They were not enabled for this local run.
The two additional cases since the earlier 880-test run cover actual native
MagicLink template/session behavior and catalog-generated Auth template/subject
artifact drift in normal saved verification.

The exact additional Node command was:

```bash
node --test scripts/tests/ci-policy.test.mjs scripts/tests/release-identity.test.mjs deploy/tests/release-prepare.test.mjs deploy/tests/release-host.test.mjs deploy/tests/release-connect.test.mjs
```

The full host fixture was executed with its opt-in flag, not substituted by the
fast source-preparation case or a skipped test:

```bash
IVAT_RELEASE_RUNTIME_TEST=1 node --test deploy/tests/release-runtime.test.mjs
```

It built the custom AMD64 images from a complete committed source tree with an
annotated disposable release tag and probe migration. It used actual pinned
test SSH and a disposable production Compose stack. Passing scenarios included
preflight refusals, interrupted-observer lock retention and durable completion,
selected-image inspection failure, successful upgrade, installed generator and
compiled login tag/full-revision identity, retained data, and the failed-migration
manual-recovery guard. Anonymous HTTP checks through the real proxy verified
both brand SVGs and four published icon paths: 200 responses, correct MIME types,
exact source bytes and image signatures. Disposable host services were removed.

The complete browser command was:

```bash
PLAYWRIGHT_BASE_URL=http://127.0.0.1:3104 npm run test:e2e
```

Its harness started a fresh isolated e2e-profile stack with local Mailpit,
Postman ARES simulation, fake provider adapters, production Next server and
worker. Its actual `npm run build` passed in 4.1 seconds and is the production
build counted for this final run. Every repository browser case ran, including
native Auth/invitation/password/MFA recovery, localized workbook downloads,
abortable cancellation, manual-original attachment and explicit AI replacement,
Role boundaries, Source recovery, review, reports, archive/export, branding
and shared-shell checks. The new 85th case independently retains a live
operational alert with long labels across both languages and all four widths,
so successful Source remediation cannot mask layout regressions. The harness
stopped its managed application, worker and simulation processes.

After `cf16536`, the only behavioral correction was the existing facts grid's
minimum widths; the other change was deterministic browser-fixture selection
with its independent alert regression. Application/worker logic, Auth, schema,
dependencies and release runtime fixture did not change. For that CSS/browser-
fixture revision, the passing application and host checks carried forward
without redundant full serial or host runs. Typecheck and lint passed again on
that two-file correction, which both review axes approved before the complete
85-case rerun. The later cloud-performance correction adds a view migration and
requires fresh full integration application and host checks after review.

## Development runtime confirmation

After the production E2E services stopped, Next 16.4.3 ran with Turbopack and a
worktree-scoped agent-browser 0.39.4 session with React DevTools enabled. Next
MCP exposed its tools and route map, reported no compilation issues, and
reported empty configuration/session error lists after navigation. Browser
page errors were empty.

A real privately provisioned test identity logged in through the UI. The
existing fixture supplied an actual stored PDF Source File, a populated
AI-authored Extraction Version awaiting human review, and a saved VAT Report.
Auth, Company, Source, Review and Report surfaces were observed in Czech and
English at 360, 720, 1024 and 1440 pixels: 40 observations and screenshots.
Every observation had one main region, a visible main heading, loaded branding,
no body horizontal overflow and light styling despite a dark system preference.
Representative mobile and desktop images were visually inspected.

React inspection confirmed the live login ActionState, the saved report's
`GenerateForm` with `exists: true` and `disabled: true` matching the pending
review blocker, and the actual `CorrectionForm` Version and populated payload.
Runtime metadata and observed links identified the corresponding routes.
This was runtime confirmation, not a second E2E suite. Development output was
preserved while the server ran. The scoped browser, development server and
owned database were stopped afterward; no ticket stacks or owned application
listeners remained. The integration working tree and verified HEAD stayed clean.

## Earlier failed attempts, retained separately

- At `04bfc5f560a5589d64e6fb31d5ab66ae91107c87`, the first serial run had
  18 failed, 861 passed and 6 skipped tests (307.44 seconds command). Repeated
  local startup had invalidated mounted Auth template files. The wrapper was
  corrected to preserve file identity and received actual HTTP/template/mail
  regression proof before the later passing serial runs.
- At `5d813218018616f92247b75d47fd2bc43341514c`, the full host fixture had one
  passing source-preparation case and one failing runtime case, zero skips
  (247.21 seconds). The fixture's independent login request lost its explicit
  Host header through Node's global fetch and received 404. Its HTTP transport
  was corrected and proved with a real loopback server before the later full passing
  host runs. Compiled tag and full-revision assertions were preserved.
- At `80ace776d9325550214c1ac5e447532ba80b8807`, the first complete browser run
  had 83 passed and one failed case, zero skips (354.55 seconds command). Two
  shared-shell locators still expected the old Auth banner brand placement.
  They were aligned with the approved centered panel. The full affected case
  and seven related Auth/branding cases then passed before the complete
  84-case historical passing command below. All later shell, Role and
  accessibility assertions remained intact.

- At `cf16536ae79e8e9a2583fbdc74f94f4108b92c40`, the fresh complete browser
  command had 81 passed, three failed and zero skipped cases (343.4 seconds
  browser / 381.55 seconds command). One remediation fixture accepted the
  first configuration in mixed inventory: OpenAI was assigned to a worker
  deliberately configured with only the fake adapter. Two 720-pixel Platform
  views overflowed to 733 pixels while that legitimate live alert was present.
  The application suite and updated full host fixture at this revision passed;
  the development runtime phase was held after the browser failure.

The Source diagnosis replayed the original stored input through actual native
AAL2 authorization, the real queue claim and the production worker handler.
The incompatible assignment reproduced `waiting_for_platform` with
`configuration_unusable` in 0.111 seconds. Changing only the assignment to an
existing fake configuration reached `split` in 0.132 seconds; restoring the
incompatible assignment reproduced the refusal in 0.087 seconds. Generations
matched and jobs completed, ruling out a need to relax worker availability or
increase timeouts. The browser fixture now creates its own fake configuration
and explicitly selects its ID despite incompatible inventory; both the first
remediation and final terminal-job retry must reach durable `split`.

For the independent layout diagnosis, the same live alert, long Company and
configuration labels stayed present. Changing only the facts-grid minimums
reduced 733 pixels to 720; restoring them restored the overflow. Select minimums
and text wrapping alone did not repair it. The new standalone browser regression
reproduced the card ending at 733 pixels in a 720-pixel viewport before the
one-line CSS correction. It keeps the real alert and open editing/assignment
forms visible in both languages and all four widths before repairing its own
Company through the UI and checking durable Source completion. No labels were
shortened, content hidden, provider guard bypassed or timeout increased.

Original failure logs and private traces were preserved rather than overwritten
or represented as passing runs. One temporary runtime fixture launcher also
needed its outside-repository top-level-await execution shape adapted to the
local TypeScript loader; this occurred before any application call and changed
no repository source.

## Earlier passing results, retained as history

| Check | Revision | Historical result |
| --- | --- | --- |
| Application serial suite | `5d813218018616f92247b75d47fd2bc43341514c` | 880 passed, 6 optional skips; 346.61 s command |
| Full host/SSH fixture before asset assertions | `80ace776d9325550214c1ac5e447532ba80b8807` | 3 passed, zero skipped; 190.09 s |
| Complete browser suite before combined-review corrections | `a1986d9d6d29d89c532e9f28eebe781231a192c2` | 84 passed, zero skipped; 342.34 s command |
| Next runtime before combined-review corrections | `a1986d9d6d29d89c532e9f28eebe781231a192c2` | MCP, React and 40 layout observations passed |

These historical results were not carried across the subsequent application
and runtime corrections. Fresh application/host checks at `cf16536` and the
complete browser/Next checks at `e36ed62` establish the current evidence instead.
A formatting-only follow-up also removed surplus EOF blank lines from four
new migrations and the TOTP helper without changing SQL tokens or helper logic.

## Combined-review corrections: focused proof

The fixes based on `0c46f95711ef350ccb3da5dd2ff0f8f87785628c` add translated
workbook copy through a next-intl route boundary, catalog-generated bilingual
native Auth templates/subjects, an abortable in-page Invitation cancellation
confirmation, and the missing `public` directory in the production image.
Application workbook generation remains framework-free. Auth still sends and
verifies its own single-use tokens; localization does not introduce a replacement
mailer, session flag, environment variable or MFA exception.

Focused verification during this correction:

- Seven application test files passed all 43 cases: workbook generation,
  inclusion/readiness (including the large projection), manual Documents,
  messages, native password recovery and live Auth templates. Actual Mailpit
  recovery and MagicLink emails contain Czech/English body and subject copy;
  native session verification/single use, one-hour recovery expiry, existing MFA,
  refresh-session handling and repeated-start template mounts remain covered.
  The normal messages test also checks generated artifacts against the catalogs.
- An actual CS/EN browser workbook download passed after its untranslated-copy
  failure. Four further browser cases passed: full new/existing-user invitation
  onboarding, silent copied-link replacement/cancellation, and existing real
  PDF/workbook boundary refusal, add/remove and entered-value restoration.
  Aborting cancellation preserves the same pending link and expiry, returns
  focus and sends no email. Only explicit confirmation invalidates the link.
- Actual AMD64 production web/proxy images reproduced anonymous 404 responses
  for both brand SVGs, while the four existing icon paths returned 200. After
  copying `public` into the runtime image, all six paths returned anonymous 200
  with correct MIME types, exact published bytes and valid image signatures.
  These shared HTTP assertions now run in the existing deployment CI runtime
  stage and the full host fixture, without adding another CI image or stack.
  Two earlier local harness port-setup attempts did not reach HTTP and are not
  counted as the missing-asset reproduction.
- Typecheck and lint passed. Focused Node CI/release/prepare/host/connect/runtime
  checks passed 25 cases; their one opt-in full-host skip does not establish a
  fresh full-host pass. No full application suite or full host fixture was run
  during this fix delivery.
- A fresh Next/Turbopack MCP and scoped React/browser check reported no
  compilation, configuration, session or browser errors. English/Czech
  cancellation groups at 360 and 1440 pixels preserved link/status/expiry on
  abort, returned focus, remained light under dark preference and had no body
  overflow. Explicit Czech confirmation reached Cancelled; local Mailpit
  contained no message for this silent workflow. Owned resources were stopped.

## Ready-profile cloud failure and focused correction

Three cloud failures were Duplicate Warning requests cancelled by PostgreSQL's
normal eight-second authenticated statement limit. The fourth was the
1,001-Document Period Lock pagination case's 60-second outer test deadline.
Original cloud logs and local reproduction evidence were retained.

A cached real native-authenticated warning lookup for two owned Documents
scaled with foreign current-Document inventory: about 1.94 seconds at 4,021
Documents and 5.65 seconds at 12,029. At 18,035 it reproduced the same database
refusal twice, at 8.004 and 8.011 seconds. Native query plans showed a global
materialized CTE causing 18,427 Company-access checks and 36,854 MFA checks
before returning one warning. The existing latest-version index was working.
Changing only CTE materialization in the diagnostic native query reduced the
lookup from about 9.6 seconds to 4 milliseconds and five Company-access checks,
with the same result and authorization. A 20-second local transaction limit was
confined to diagnostic plan capture and rolled back; normal API limits remained
unchanged. The migration preserves the view's `security_invoker`, grants, RLS
predicates and warning semantics, allowing request filters into its branches.

The permanent regression uses only two owned and 32 foreign current Documents,
real native sessions and actual application results/isolation. On a clean
fixture, the old view failed the measured database-work bound with 38 access
checks. The corrected view passed the generous bound of fewer than 16. This
scoped performance observation executes the same native view with the verified
Auth identity and unchanged claims; its counter settings and transaction are
rolled back and its connection closed. It avoids a hardware-sensitive timing
assertion or routine 18,000-Document setup.

The cloud 60-second deadline was not reproduced on the developer host. The
exact fresh original pagination case completed in 17.55 seconds, including
1,001 genuine successful approvals and matching actor audit events. Its purpose
is lock-map completeness, so a controlled setup-order comparison finalized an
empty real report first and then recorded 1,001 actual Source-derived
Extractions in the locked period, which ADR-0007 permits for review. The same
1,001 lock mappings, first/last native approval refusals (`period_locked`), and
unchanged finalized snapshot passed in 5.84 seconds. The fixture now uses that
order, retaining every row and the original 60-second test/eight-second API
limits. Remaining Period Lock tests retain approved-document safeguards.
No CPU/storage explanation for the cloud deadline is asserted. Running the
11 actual MFA recovery cases and comparing the same cached reads also ruled
out a material slowdown from other Users' recovery history; MFA guards were
left unchanged.

Focused correction checks passed all 33 cases: four Duplicate Warning tests,
18 Period Lock tests and 11 actual native MFA replacement tests (22.32 seconds).
Generated database types matched; typecheck, lint and combined diff checks
passed. No full application, host or browser suite was rerun during this focused
fix delivery. Fresh full integration validation, including actual host upgrade
through the new migration, follows independent review; subsequent cloud CI is
still required. Production operations remain separate.

## Remaining gates and limits

These are local integration results, not production provider or delivery proof.
A separate read-only production SSH inventory informed SMTP preparation; no
production writes, mail sends, Release activation or monitored production
Release were performed. Production SMTP acceptance (#169) still requires the
owner-supplied existing credentials and a controlled delivery check. Production
release verification (#180) remains separate. Ready/full-cloud checks and
exact-main CI and Deployment verification remain gates; these local integration
results do not replace them.

The initial independent combined reviews found three hard findings: translated
workbook/native-mail copy, abortable Invitation cancellation, and production
public-asset packaging. Those corrections received focused proof and both axes
re-reviewed them with zero hard or code findings; the optional range-editor
suggestion was withdrawn. Both axes also reviewed the final CSS/browser-fixture
follow-up with zero hard, code or optional findings. The cloud-performance
correction above awaits its independent delta reviews and fresh full checks.
This record does not itself mark the integration PR ready or close the spec.

Credentials, tokens, factor secrets, private host details, test account values,
and raw logs/screenshots are excluded from this public record.
