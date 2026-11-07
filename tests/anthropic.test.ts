import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { AnthropicProviderError, anthropicAiProvider } from "@/ai/anthropic";
import { SAMPLE_EXTRACTION } from "@/ai/fake";
import { providerResponseOf } from "@/application/ai-provider";

const servers: ReturnType<typeof createServer>[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

async function anthropicStandIn(
  respond: (request: IncomingMessage, body: unknown, response: ServerResponse) => void,
): Promise<string> {
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    respond(request, JSON.parse(Buffer.concat(chunks).toString("utf8")), response);
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("stand-in did not bind");
  return `http://127.0.0.1:${address.port}`;
}

describe("Anthropic AI provider", () => {
  it("discards unsupported PDF locations without losing valid financial values", async () => {
    const valid = { fieldPath: "rateBreakdown.0.vatAmount", kind: "page", page: 1, x: 0.6, y: 0.7, width: 0.2, height: 0.05 };
    let requestBody: unknown;
    const baseUrl = await anthropicStandIn((_request, body, response) => {
      requestBody = body;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        model: "claude-extract",
        content: [{ type: "text", text: JSON.stringify({
          ...SAMPLE_EXTRACTION,
          sourceEvidence: { sourceFileId: "provider-selected-source" },
          sourceLocations: [
            valid, null, "rectangle",
            { ...valid, fieldPath: "companyId" },
            { ...valid, fieldPath: "rateBreakdown.9.vatAmount" },
            { ...valid, page: 2 }, { ...valid, page: 0 }, { ...valid, page: 1.5 },
            { ...valid, x: -0.1 }, { ...valid, x: 0.9 },
            { ...valid, width: 0 }, { ...valid, height: "0.05" },
            { ...valid, kind: "workbook" },
            { ...valid, sourceFileId: "provider-selected-source" },
          ],
        }) }],
      }));
    });
    const provider = anthropicAiProvider({ apiKey: "test-secret", splitModel: "claude-split", extractModel: "claude-extract", baseUrl });
    const extraction = await provider.extract({ format: "pdf", mediaType: "application/pdf", bytes: new Uint8Array([37, 80, 68, 70]), pageCount: 1 });
    expect(extraction.payload).toEqual({ ...SAMPLE_EXTRACTION, sourceLocations: [valid] });
    expect(requestBody).toMatchObject({
      output_config: { format: { schema: { required: expect.arrayContaining(["sourceLocations"]) } } },
    });
  });

  it("returns real workbook cell evidence and ignores other sheets, omitted rows and image coordinates", async () => {
    let requestBody: unknown;
    const location = { fieldPath: "documentNumber", kind: "workbook", sheetName: "Faktury říjen", firstRow: 7, lastRow: 7, firstColumn: 4, lastColumn: 4 };
    const baseUrl = await anthropicStandIn((_request, body, response) => {
      requestBody = body;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ model: "claude-extract", content: [{ type: "text", text: JSON.stringify({ ...SAMPLE_EXTRACTION, sourceLocations: [
        location, { ...location, sheetName: "Other" }, { ...location, firstRow: 6, lastRow: 6 },
        { ...location, firstColumn: 1 }, { ...location, lastColumn: 99 }, { ...location, x: 0.1 },
        { fieldPath: "documentNumber", kind: "page", page: 1, x: 0.1, y: 0.2, width: 0.3, height: 0.1 },
      ] }) }] }));
    });
    const provider = anthropicAiProvider({ apiKey: "test-secret", splitModel: "claude-split", extractModel: "claude-extract", baseUrl });
    const text = '[Sheet "Faktury říjen"]\n[Columns]\tD\tE\n5\tNumber\tVAT\n7\tCELL-240\t210.00';
    await expect(provider.extract({ format: "xlsx", mediaType: "text/plain; charset=utf-8", bytes: new TextEncoder().encode(text), text, pageCount: 1,
      workbookEvidence: { sheetName: "Faktury říjen", firstRow: 7, lastRow: 7, firstColumn: 4, lastColumn: 5, headerRow: 5 },
    })).resolves.toMatchObject({ payload: { sourceLocations: [location] } });
    expect(requestBody).toMatchObject({ output_config: { format: { schema: { properties: { sourceLocations: { items: {
      required: ["fieldPath", "kind", "sheetName", "firstRow", "lastRow", "firstColumn", "lastColumn"],
      properties: { kind: { enum: ["workbook"] } },
    } } } } } } });
  });

  it("sends a PDF natively and returns the schema-constrained Split", async () => {
    let received: { headers: IncomingMessage["headers"]; body: unknown } | undefined;
    const baseUrl = await anthropicStandIn((request, body, response) => {
      received = { headers: request.headers, body };
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        model: "claude-sonnet-split",
        content: [{ type: "text", text: JSON.stringify({ documents: [{ firstPage: 1, lastPage: 2 }] }) }],
        usage: { input_tokens: 123, output_tokens: 17 },
      }));
    });
    const provider = anthropicAiProvider({
      apiKey: "test-secret",
      splitModel: "claude-sonnet-split",
      extractModel: "claude-sonnet-extract",
      baseUrl,
    });

    await expect(provider.split({
      format: "pdf",
      mediaType: "application/pdf",
      bytes: new Uint8Array([37, 80, 68, 70]),
      pageCount: 2,
    })).resolves.toEqual({
      model: "claude-sonnet-split",
      documents: [{ firstPage: 1, lastPage: 2 }],
      usage: { inputTokens: 123, outputTokens: 17 },
    });
    expect(received).toEqual({
      headers: expect.objectContaining({
        "x-api-key": "test-secret",
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      }),
      body: expect.objectContaining({
        model: "claude-sonnet-split",
        messages: [{
          role: "user",
          content: expect.arrayContaining([
            {
              type: "document",
              source: { type: "base64", media_type: "application/pdf", data: "JVBERg==" },
            },
            expect.objectContaining({ type: "text" }),
          ]),
        }],
        output_config: {
          format: expect.objectContaining({
            type: "json_schema",
            schema: expect.objectContaining({ required: ["documents"] }),
          }),
        },
      }),
    });
  });

  it("sends an image natively and returns a valid Extraction payload", async () => {
    let body: unknown;
    const baseUrl = await anthropicStandIn((_request, received, response) => {
      body = received;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        model: "claude-sonnet-extract",
        content: [{ type: "text", text: JSON.stringify(SAMPLE_EXTRACTION) }],
      }));
    });
    const provider = anthropicAiProvider({
      apiKey: "test-secret",
      splitModel: "claude-sonnet-split",
      extractModel: "claude-sonnet-extract",
      baseUrl,
    });

    await expect(provider.extract({
      format: "png",
      mediaType: "image/png",
      bytes: new Uint8Array([137, 80, 78, 71]),
      pageCount: 1,
    })).resolves.toEqual({ model: "claude-sonnet-extract", payload: SAMPLE_EXTRACTION });
    expect(body).toEqual(expect.objectContaining({
      model: "claude-sonnet-extract",
      messages: [{
        role: "user",
        content: expect.arrayContaining([
          {
            type: "image",
            source: { type: "base64", media_type: "image/png", data: "iVBORw==" },
          },
          expect.objectContaining({
            type: "text",
            text: expect.stringMatching(
              /Credit Note[\s\S]*negative amounts[\s\S]*original Document number/i,
            ),
          }),
        ]),
      }],
      output_config: {
        format: expect.objectContaining({
          type: "json_schema",
          schema: expect.objectContaining({
            required: expect.arrayContaining(["schemaVersion", "documentType", "rateBreakdown", "totals"]),
          }),
        }),
      },
    }));
  });

  it("sends a workbook as text and returns row sets", async () => {
    let body: unknown;
    const baseUrl = await anthropicStandIn((_request, received, response) => {
      body = received;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        model: "claude-sonnet-split",
        content: [{
          type: "text",
          text: JSON.stringify({ documents: [{ sheetName: "Invoices", firstRow: 2, lastRow: 2 }] }),
        }],
      }));
    });
    const provider = anthropicAiProvider({
      apiKey: "test-secret",
      splitModel: "claude-sonnet-split",
      extractModel: "claude-sonnet-extract",
      baseUrl,
    });
    const text = '[Sheet "Invoices"]\n1\tNumber\n2\tFV-1';

    await expect(provider.split({
      format: "xlsx",
      mediaType: "text/plain; charset=utf-8",
      bytes: new TextEncoder().encode(text),
      text,
      pageCount: 1,
    })).resolves.toEqual({
      model: "claude-sonnet-split",
      documents: [{ sheetName: "Invoices", firstRow: 2, lastRow: 2 }],
    });
    expect(body).toEqual(expect.objectContaining({
      messages: [{
        role: "user",
        content: expect.arrayContaining([{ type: "text", text }]),
      }],
      output_config: {
        format: expect.objectContaining({
          schema: expect.objectContaining({
            properties: expect.objectContaining({ documents: expect.objectContaining({ minItems: 1 }) }),
          }),
        }),
      },
    }));
  });

  it.each([
    [429, "rate_limit_error", { "retry-after": "2" }, true],
    [529, "overloaded_error", {}, true],
    [401, "authentication_error", {}, false],
  ])("classifies HTTP %i failures for retry", async (status, type, headers, transient) => {
    const baseUrl = await anthropicStandIn((_request, _body, response) => {
      response.writeHead(status, { "content-type": "application/json", ...headers });
      response.end(JSON.stringify({ type: "error", error: { type, message: "unavailable" } }));
    });
    const provider = anthropicAiProvider({
      apiKey: "test-secret",
      splitModel: "claude-sonnet-split",
      extractModel: "claude-sonnet-extract",
      baseUrl,
    });

    const error = await provider.split({
      format: "pdf",
      mediaType: "application/pdf",
      bytes: new Uint8Array([37, 80, 68, 70]),
      pageCount: 1,
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(AnthropicProviderError);
    expect(error).toMatchObject({ status, transient });
  });

  it("names the failed check and keeps the raw body of an invalid Extraction payload", async () => {
    const extraction = { ...SAMPLE_EXTRACTION, issueDate: "30.10.2026" };
    const raw = JSON.stringify({ model: "claude-sonnet-extract", content: [{ type: "text", text: JSON.stringify(extraction) }] });
    const baseUrl = await anthropicStandIn((_request, _body, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(raw);
    });
    const provider = anthropicAiProvider({
      apiKey: "test-secret",
      splitModel: "claude-sonnet-split",
      extractModel: "claude-sonnet-extract",
      baseUrl,
    });
    const error = await provider.extract({ format: "png", mediaType: "image/png", bytes: new Uint8Array([137, 80, 78, 71]), pageCount: 1 })
      .catch((caught: unknown) => caught);

    expect(error).toEqual(new Error("Anthropic returned an invalid Extraction payload (invalid_date)"));
    expect(providerResponseOf(error)).toBe(raw);
  });

  it.each([
    [401, "authentication_error", "invalid_credentials"],
    [402, "billing_error", "provider_credits_exhausted"],
  ] as const)("classifies HTTP %i as %s platform intervention", async (status, type, classification) => {
    const baseUrl = await anthropicStandIn((_request, _body, response) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify({ type: "error", error: { type, message: "operator-only detail" } }));
    });
    const provider = anthropicAiProvider({
      apiKey: "test-secret",
      splitModel: "claude-sonnet-split",
      extractModel: "claude-sonnet-extract",
      baseUrl,
    });

    const error = await provider.split({
      format: "pdf",
      mediaType: "application/pdf",
      bytes: new Uint8Array([37, 80, 68, 70]),
      pageCount: 1,
    }).catch((caught: unknown) => caught);

    expect(error).toMatchObject({
      transient: false,
      platformIntervention: true,
      classification,
    });
  });

  it.each([
    [
      400,
      {},
      {
        type: "error",
        error: {
          type: "invalid_request_error",
          message: "You have reached your specified API usage limits. Access will resume next month.",
        },
        request_id: "req_spend_limit",
      },
    ],
    [
      429,
      {},
      {
        type: "error",
        error: {
          type: "rate_limit_error",
          message: "You have reached your API usage limits.",
          details: { error_code: "enforced_spend_limit_reached" },
        },
        request_id: "req_tier_cap",
      },
    ],
  ])("classifies Anthropic's documented HTTP %i spend-limit shape as platform intervention", async (
    status,
    headers,
    body,
  ) => {
    const baseUrl = await anthropicStandIn((_request, _body, response) => {
      response.writeHead(status, { "content-type": "application/json", ...headers });
      response.end(JSON.stringify(body));
    });
    const provider = anthropicAiProvider({
      apiKey: "test-secret",
      splitModel: "claude-sonnet-split",
      extractModel: "claude-sonnet-extract",
      baseUrl,
    });

    const error = await provider.split({
      format: "pdf",
      mediaType: "application/pdf",
      bytes: new Uint8Array([37, 80, 68, 70]),
      pageCount: 1,
    }).catch((caught: unknown) => caught);

    expect(error).toMatchObject({
      status,
      transient: false,
      platformIntervention: true,
      classification: "provider_credits_exhausted",
    });
  });
});
