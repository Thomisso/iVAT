# OpenAI simulation

Generated 2026-10-27 from the public Responses API contract used by ticket #29.

## Purpose

Runs the real iVAT OpenAI adapter against `postman/mocks/openai-responses`, without credentials or provider side effects. The mock models only `POST /responses` for iVAT Split and Extraction.

## Execution

1. `postman simulation run postman/simulations/openai/openai.sim.yaml --port 4919 --output ndjson --no-history`
2. In another terminal: `OPENAI_SIMULATION_BASE_URL=http://127.0.0.1:4919/openai npm test -- tests/simulation/openai.test.ts`
3. Confirm the simulation log contains two `request` events for the `openai` member, then stop it with Ctrl-C.

## Assumptions

- The simulation validates iVAT's bearer header, JSON-schema output request, and native PDF/image content-block shape. It cannot establish live model availability, extraction quality, provider limits, or credential validity; use `npm run test:contract:openai` for the live boundary. (reasoned 2026-10-27, mock handler and official contract)

## Observations

<!-- begin:observations -->
2026-10-27: the `openai` member served both `POST /responses` calls; the real adapter completed native PDF Split and native image Extraction through the simulation.
<!-- end:observations -->

## PDF raster input verification (2026-11-10, #253)

The simulation test now runs native PDF Split and real Poppler preparation of a
three-page PDF for Extraction. The stand-in requires three numbered PNG blocks
and refuses a native PDF Extraction block. On 2026-11-10 the real adapter test
passed and the simulation log recorded both POST /responses requests. This
establishes serialization and HTTP routing against this repository-owned mock;
it does not establish model localization quality or live provider limits.

The production adapter also has focused real-HTTP stand-in coverage for page-2
locations. Official formats: https://developers.openai.com/api/docs/guides/images-vision
and https://platform.claude.com/docs/en/build-with-claude/vision . The original
2026-10-27 observations above remain historical evidence for the prior test.

## Bounded evaluator CLI (2026-11-13, #303)

Supported within the repository-owned stand-in: the real public evaluator CLI
prepares a three-page synthetic PDF, sends native PDF Split and rasterized PNG
Extraction, and persists its private report. The `bounded-evaluator` mock case
requires `max_output_tokens:512` and returns deterministic usage of 32 input/12 output
for each request. The successful focused run recorded two 200 request events for
that model with the explicit 512 ceiling; the CLI reported two attempts,
1024 reserved generated tokens, 64 observed input tokens and 24 observed generated
tokens. Both the new bounded case and the previous PDF case passed. The mock
belongs to this repository; no owner discovery or external mock was needed.

Evidence: `tests/simulation/openai.test.ts`,
`postman/mocks/openai-responses/default.js`, `src/evaluation/evaluation-cli.ts`
and `src/ai/openai.ts`; Postman CLI 1.73.0, dirty #303 tree based on merge
`3fa7e633336da0e4e54df472a14fb8d92cf034e0`. The initial bounded run returned a
partial report when this stand-in supplied no usage; adding deterministic
metering made the complete controlled run possible. The caller therefore
stops safely when usage is unavailable rather than treating it as zero.

Primary contract read 2026-11-13:
https://developers.openai.com/api/reference/resources/responses/methods/create
specifies `max_output_tokens` as the generated ceiling, including reasoning;
https://developers.openai.com/api/docs/guides/token-counting describes input
counting as a separate request. Zero-call preflight makes no such request.
These checks establish request serialization, accounting and private output
against this stand-in. They do not establish real provider metering, model
availability, invoice prices, extraction quality, a hard input+output token
ceiling or a guaranteed monetary cap. No live provider calls were made.
