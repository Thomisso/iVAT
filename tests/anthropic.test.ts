import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { AnthropicProviderError, anthropicAiProvider } from "@/ai/anthropic";
import { SAMPLE_EXTRACTION } from "@/ai/fake";

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
          expect.objectContaining({ type: "text" }),
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

  it.each([
    [429, true],
    [529, true],
    [401, false],
  ])("classifies HTTP %i failures for retry", async (status, transient) => {
    const baseUrl = await anthropicStandIn((_request, _body, response) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify({ type: "error", error: { type: "api_error", message: "unavailable" } }));
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
});
