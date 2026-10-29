import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { OpenAiProviderError, openAiProvider } from "@/ai/openai";
import { SAMPLE_EXTRACTION } from "@/ai/fake";

const servers: ReturnType<typeof createServer>[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

async function openAiStandIn(
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

describe("OpenAI provider", () => {
  it("sends a PDF natively and returns the schema-constrained Split", async () => {
    let received: { headers: IncomingMessage["headers"]; body: unknown } | undefined;
    const baseUrl = await openAiStandIn((request, body, response) => {
      received = { headers: request.headers, body };
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        model: "gpt-split",
        status: "completed",
        usage: { input_tokens: 91, output_tokens: 12 },
        output: [{
          type: "message",
          content: [{ type: "output_text", text: JSON.stringify({ documents: [{ firstPage: 1, lastPage: 2 }] }) }],
        }],
      }));
    });
    const provider = openAiProvider({
      apiKey: "test-secret",
      splitModel: "gpt-split",
      extractModel: "gpt-extract",
      baseUrl,
    });

    await expect(provider.split({
      format: "pdf",
      mediaType: "application/pdf",
      bytes: new Uint8Array([37, 80, 68, 70]),
      pageCount: 2,
    })).resolves.toEqual({
      model: "gpt-split",
      documents: [{ firstPage: 1, lastPage: 2 }],
      usage: { inputTokens: 91, outputTokens: 12 },
    });
    expect(received).toEqual({
      headers: expect.objectContaining({
        authorization: "Bearer test-secret",
        "content-type": "application/json",
      }),
      body: expect.objectContaining({
        model: "gpt-split",
        store: false,
        input: [{
          role: "user",
          content: expect.arrayContaining([
            {
              type: "input_file",
              filename: "source-file.pdf",
              file_data: "data:application/pdf;base64,JVBERg==",
            },
            expect.objectContaining({ type: "input_text" }),
          ]),
        }],
        text: {
          format: expect.objectContaining({
            type: "json_schema",
            name: "ivat_split",
            strict: true,
            schema: expect.objectContaining({ required: ["documents"] }),
          }),
        },
      }),
    });
  });

  it("sends an image natively and returns a valid Extraction payload", async () => {
    let body: unknown;
    const baseUrl = await openAiStandIn((_request, received, response) => {
      body = received;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        model: "gpt-extract",
        status: "completed",
        output: [{
          type: "message",
          content: [{ type: "output_text", text: JSON.stringify(SAMPLE_EXTRACTION) }],
        }],
      }));
    });
    const provider = openAiProvider({
      apiKey: "test-secret",
      splitModel: "gpt-split",
      extractModel: "gpt-extract",
      baseUrl,
    });

    await expect(provider.extract({
      format: "png",
      mediaType: "image/png",
      bytes: new Uint8Array([137, 80, 78, 71]),
      pageCount: 1,
    })).resolves.toEqual({ model: "gpt-extract", payload: SAMPLE_EXTRACTION });
    expect(body).toEqual(expect.objectContaining({
      model: "gpt-extract",
      input: [{
        role: "user",
        content: expect.arrayContaining([
          {
            type: "input_image",
            image_url: "data:image/png;base64,iVBORw==",
            detail: "high",
          },
          expect.objectContaining({
            type: "input_text",
            text: expect.stringMatching(
              /Credit Note[\s\S]*negative amounts[\s\S]*original Document number/i,
            ),
          }),
        ]),
      }],
      text: {
        format: expect.objectContaining({
          type: "json_schema",
          name: "ivat_extraction",
          strict: true,
          schema: expect.objectContaining({
            required: expect.arrayContaining(["schemaVersion", "documentType", "rateBreakdown", "totals"]),
          }),
        }),
      },
    }));
  });

  it("sends a workbook as text and returns row sets", async () => {
    let body: unknown;
    const baseUrl = await openAiStandIn((_request, received, response) => {
      body = received;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        model: "gpt-split",
        status: "completed",
        output: [{
          type: "message",
          content: [{
            type: "output_text",
            text: JSON.stringify({ documents: [{ sheetName: "Invoices", firstRow: 2, lastRow: 2 }] }),
          }],
        }],
      }));
    });
    const provider = openAiProvider({
      apiKey: "test-secret",
      splitModel: "gpt-split",
      extractModel: "gpt-extract",
      baseUrl,
    });
    const text = '[Sheet "Invoices"]\n1\tNumber\n2\tFV-1';

    await expect(provider.split({
      format: "xls",
      mediaType: "text/plain; charset=utf-8",
      bytes: new TextEncoder().encode(text),
      text,
      pageCount: 1,
    })).resolves.toEqual({
      model: "gpt-split",
      documents: [{ sheetName: "Invoices", firstRow: 2, lastRow: 2 }],
    });
    expect(body).toEqual(expect.objectContaining({
      input: [{
        role: "user",
        content: expect.arrayContaining([{ type: "input_text", text }]),
      }],
      text: {
        format: expect.objectContaining({
          schema: expect.objectContaining({
            properties: expect.objectContaining({ documents: expect.objectContaining({ minItems: 1 }) }),
          }),
        }),
      },
    }));
  });

  it.each([
    [429, true],
    [503, true],
    [401, false],
  ])("classifies HTTP %i failures for retry", async (status, transient) => {
    const baseUrl = await openAiStandIn((_request, _body, response) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { code: "unavailable", message: "unavailable" } }));
    });
    const provider = openAiProvider({
      apiKey: "test-secret",
      splitModel: "gpt-split",
      extractModel: "gpt-extract",
      baseUrl,
    });

    const error = await provider.split({
      format: "pdf",
      mediaType: "application/pdf",
      bytes: new Uint8Array([37, 80, 68, 70]),
      pageCount: 1,
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(OpenAiProviderError);
    expect(error).toMatchObject({ status, transient });
  });

  it.each([
    [401, "invalid_api_key", "invalid_credentials"],
    [429, "insufficient_quota", "provider_credits_exhausted"],
  ] as const)("classifies HTTP %i with %s as platform intervention", async (status, code, classification) => {
    const baseUrl = await openAiStandIn((_request, _body, response) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { code, message: "operator-only detail" } }));
    });
    const provider = openAiProvider({
      apiKey: "test-secret",
      splitModel: "gpt-split",
      extractModel: "gpt-extract",
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
});
