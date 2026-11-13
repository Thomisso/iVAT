// Postman's simulation runtime loads handlers as CommonJS.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const http = require("http");

const PORT = process.env.PORT || 4919;
const JSON_HEADERS = { "content-type": "application/json" };
const EXTRACTION = {
  schemaVersion: 1,
  documentType: null,
  documentNumber: "SIM-1",
  issueDate: null,
  taxPointDate: null,
  dueDate: null,
  direction: null,
  supplier: {
    name: null,
    ico: null,
    vatId: null,
    street: null,
    city: null,
    postalCode: null,
    country: null,
  },
  customer: {
    name: null,
    ico: null,
    vatId: null,
    street: null,
    city: null,
    postalCode: null,
    country: null,
  },
  currency: "CZK",
  rateBreakdown: [],
  totals: { netAmount: null, vatAmount: null, grossAmount: null },
  payment: { variableSymbol: null, bankAccount: null, iban: null },
  proposedVatRegime: null,
  originalDocumentNumber: null,
};

const server = http.createServer(async (request, response) => {
  if (request.method !== "POST" || request.url !== "/responses") {
    response.writeHead(501, JSON_HEADERS);
    return response.end(
      JSON.stringify({ error: { message: "Endpoint not modelled" } }),
    );
  }
  const body = await readJson(request);
  if (body.model === "bounded-evaluator" && body.max_output_tokens !== 512) {
    response.writeHead(400, JSON_HEADERS);
    return response.end(JSON.stringify({ error: { message: "Expected explicit generated-token ceiling" } }));
  }
  if (
    !request.headers.authorization?.startsWith("Bearer ") ||
    body.text?.format?.type !== "json_schema"
  ) {
    response.writeHead(400, JSON_HEADERS);
    return response.end(
      JSON.stringify({ error: { message: "Invalid Responses request" } }),
    );
  }
  const content = body.input?.[0]?.content ?? [];
  const schemaName = body.text.format.name;
  const nativeType = schemaName === "ivat_split" ? "input_file" : "input_image";
  if (!content.some((item) => item.type === nativeType)) {
    response.writeHead(400, JSON_HEADERS);
    return response.end(
      JSON.stringify({ error: { message: `Missing ${nativeType}` } }),
    );
  }
  if (schemaName === "ivat_extraction") {
    const images = content.filter(item => item.type === "input_image");
    const labels = content.filter(item => item.type === "input_text");
    if (images.length !== 3 || content.some(item => item.type === "input_file") ||
        !images.every(item => item.image_url.startsWith("data:image/png;base64,iVBORw0KGgo")) ||
        ![1, 2, 3].every(page => labels.some(item => item.text.startsWith(`Page ${page} of 3 `)))) {
      response.writeHead(400, JSON_HEADERS);
      return response.end(JSON.stringify({ error: { message: "Expected three numbered full-page PNG images" } }));
    }
  }
  const value =
    schemaName === "ivat_split"
      ? { documents: [{ firstPage: 1, lastPage: 1 }] }
      : EXTRACTION;
  response.writeHead(200, JSON_HEADERS);
  response.end(
    JSON.stringify({
      model: body.model,
      ...(body.model === "bounded-evaluator" ? { usage: { input_tokens: 32, output_tokens: 12 } } : {}),
      status: "completed",
      output: [
        {
          type: "message",
          content: [{ type: "output_text", text: JSON.stringify(value) }],
        },
      ],
    }),
  );
});

function readJson(request) {
  return new Promise((resolve) => {
    let raw = "";
    request.on("data", (chunk) => (raw += chunk));
    request.on("end", () => {
      try {
        resolve(JSON.parse(raw));
      } catch {
        resolve({});
      }
    });
  });
}

server.listen(PORT);
