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
