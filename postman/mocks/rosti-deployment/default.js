// Local contract-derived stand-in; owner discovery was unavailable without login.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const http = require("http");
let compose = "";
let behavior = "success";
const json = (response, status, body) => { response.writeHead(status, { "content-type": "application/json" }); response.end(JSON.stringify(body)); };
http.createServer((request, response) => {
  if (request.method === "POST" && request.url === "/__control") {
    behavior = request.body.behavior || "success";
    compose = request.body.compose || "";
    return json(response, 200, { ready: true });
  }
  const match = /^\/api-n\/7895\/stacks\/931(\/compose\?call_up=false)?$/.exec(request.url || "");
  if (!match) return json(response, 501, { detail: "Endpoint not modelled" });
  if (!request.headers["x-api-key"]) return json(response, 401, { detail: "Unauthorized" });
  if (request.method === "PUT" && match[1]) {
    if (behavior === "locked") return json(response, 423, { detail: "locked" });
    if (behavior === "html") { response.writeHead(502, { "content-type": "text/html" }); return response.end("PRIVATE_PROVIDER_RESPONSE"); }
    if (!request.headers["content-type"]?.startsWith("text/plain") || typeof request.body !== "string") return json(response, 400, { detail: "Expected raw Compose text" });
    compose = request.body;
    if (behavior === "timeout-after-write") return setTimeout(() => json(response, 200, { status: 0 }), 2000);
    return json(response, 200, { status: 0 });
  }
  if (request.method === "GET" && !match[1]) return json(response, 200, {
    compose_b64: Buffer.from(behavior === "mismatch" ? "different Compose" : compose).toString("base64"),
    env_b64: Buffer.from("PRIVATE_PROVIDER_ENVIRONMENT").toString("base64"),
    pull_token: "PRIVATE_PROVIDER_TOKEN",
  });
  return json(response, 501, { detail: "Endpoint not modelled" });
}).listen(process.env.PORT || 4955);
