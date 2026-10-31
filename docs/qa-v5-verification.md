# QA v5 final local verification (#179)

The results below are retained pre-fix evidence at their exact revisions. The
subsequent combined-review corrections change workbook/native-mail copy,
Invitation confirmation and production asset packaging. Fresh final integration
checks are required after those corrections; the earlier application results
must not be treated as passing coverage of the corrected HEAD.

Verified on 31 October 2026 in the isolated integration worktree, after all
ticket stacks stopped. Tests ran sequentially on Docker Desktop for macOS with
Linux containers. Local Auth, PostgreSQL, Storage, SMTP capture, application,
and worker processes were real. Test identities and financial data were
synthetic; external AI, VAT registry, exchange-rate, and provider-control
dependencies used the existing fake adapters or Postman simulations. No paid
provider or live Google calls were made.

## Passing results and exact revisions

| Check | Revision | Result | Elapsed |
| --- | --- | --- | --- |
| `npm ci` | `5d813218018616f92247b75d47fd2bc43341514c` | Passed | 6.31 s |
| Fresh `npm run db:start -- --profile=e2e`, `npm run db:reset`, `npm run db:types` and generated-type diff | `5d813218018616f92247b75d47fd2bc43341514c` | Passed; generated types matched | 26.89 s / 24.73 s / 0.48 s |
| `npm run test:serial` | `5d813218018616f92247b75d47fd2bc43341514c` | 880 passed, 6 skipped; 86 passing files, 6 skipped files | 345.96 s test / 346.61 s command |
| `npm run typecheck` | `5d813218018616f92247b75d47fd2bc43341514c` | Passed | 5.48 s |
| `npm run lint` | `5d813218018616f92247b75d47fd2bc43341514c` | Passed | 5.74 s |
| CI policy, release identity, prepare, host and connect Node checks | `5d813218018616f92247b75d47fd2bc43341514c` | 23 passed | 9.00 s |
| Full opt-in host/SSH runtime fixture | `80ace776d9325550214c1ac5e447532ba80b8807` | 3 passed, zero skipped | 190.09 s |
| Complete repository production E2E command | `a1986d9d6d29d89c532e9f28eebe781231a192c2` | 84 passed, zero skipped | 305.4 s browser phase / 342.34 s command |
| Next development runtime and browser checks | `a1986d9d6d29d89c532e9f28eebe781231a192c2` | MCP, React inspection and all 40 layout observations passed | Separate runtime confirmation |

The six serial-suite skips are five opt-in live-provider contract checks and
one optional OpenAI simulation check. They were not enabled for this local run.

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
manual-recovery guard. Disposable host services were removed afterward.

The complete browser command was:

```bash
PLAYWRIGHT_BASE_URL=http://127.0.0.1:3104 npm run test:e2e
```

Its harness started a fresh isolated e2e-profile stack with local Mailpit,
Postman ARES simulation, fake provider adapters, production Next server and
worker. Its actual `npm run build` passed in 3.4 seconds and is the production
build counted for this final run. The command ran every repository browser
case, including native Auth/invitation/password/MFA recovery, manual-original
attachment and explicit AI replacement, Role boundaries, Source recovery,
review, reports, archive/export workflows, branding and shared-shell checks.
The harness stopped its managed application, worker and simulation processes.

The application/schema/dependencies did not change between the serial-suite
revision and the later host/browser revisions: the two intervening corrections
only changed release-fixture HTTP transport and stale browser test locators.
The passing application checks therefore carry forward without redundant full
serial runs. The host proof likewise carries forward across the locator-only
correction. This evidence commit changes documentation only. A subsequent
formatting-only follow-up removes surplus EOF blank lines from four new
migrations and the TOTP test helper; SQL tokens, schema behavior and helper
logic are unchanged.

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
no body horizontal overflow, and light styling despite a dark system preference.
Representative mobile and desktop images were visually inspected.

React inspection confirmed the live login ActionState, the saved report's
`GenerateForm` with `exists: true` and `disabled: true` matching the pending
review blocker, and the actual `CorrectionForm` Version and payload. Runtime
metadata identified the corresponding application routes. This was runtime
confirmation, not a second E2E suite. The development output was preserved while
the server ran. The scoped browser, development server and owned database
stack were stopped afterward; no ticket stacks or owned application listeners
remained. The integration working tree and verified HEAD remained unchanged.

## Earlier failed attempts, retained separately

- At `04bfc5f560a5589d64e6fb31d5ab66ae91107c87`, the first serial run had
  18 failed, 861 passed and 6 skipped tests (307.44 seconds command). Repeated
  local startup had invalidated mounted Auth template files. The wrapper was
  corrected to preserve file identity and received actual HTTP/template/mail
  regression proof before the passing serial run above.
- At `5d813218018616f92247b75d47fd2bc43341514c`, the full host fixture had one
  passing source-preparation case and one failing runtime case, zero skips
  (247.21 seconds). The fixture's independent login request lost its explicit
  Host header through Node's global fetch and received 404. Its HTTP transport
  was corrected and proved with a real loopback server before the full passing
  host run above. Compiled tag and full-revision assertions were preserved.
- At `80ace776d9325550214c1ac5e447532ba80b8807`, the first complete browser run
  had 83 passed and one failed case, zero skips (354.55 seconds command). Two
  shared-shell locators still expected the old Auth banner brand placement.
  They were aligned with the approved centered panel. The full affected case
  and seven related Auth/branding cases then passed before the complete
  84-case passing command above. All later shell/Role/accessibility assertions
  remained intact.

Original failure logs and private traces were preserved rather than overwritten
or represented as passing runs. One temporary runtime fixture launcher also
needed its outside-repository top-level-await execution shape adapted to the
local TypeScript loader; this occurred before any application call and changed
no repository source.

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

The earlier 880-test, 84-browser, three-host-case and 40-layout results above
remain pre-fix history. Fresh complete integration checks, including the updated
full host fixture and production browser build, follow reviewed integration of
these application/runtime corrections. Their future results are not claimed here.

## Remaining gates and limits

These are local integration results, not production provider or delivery proof.
A separate read-only production SSH inventory informed SMTP preparation; no
production writes, mail sends, Release activation or monitored production
Release were performed. Production SMTP acceptance (#169) still requires the
owner-supplied existing credentials and a controlled delivery check. Production
release verification (#180) remains separate. Exact-main CI and Deployment
verification remain release gates; these draft integration results do not
replace them.

The final two independent combined review axes follow this evidence merge.
This record does not itself mark the integration PR ready or close the spec.
Credentials, tokens, factor secrets, private host details, test account values,
and raw logs/screenshots are excluded from this public record.
