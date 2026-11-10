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
