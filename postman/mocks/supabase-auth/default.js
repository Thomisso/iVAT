// Failure-only stand-in; successful authentication belongs to the real local Auth.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const http = require("http");

http.createServer((request, response) => {
  const path = new URL(request.url, "http://localhost").pathname;
  response.setHeader("content-type", "application/json");
  if (request.method === "GET" && path === "/auth/v1/settings") {
    return response.end(JSON.stringify({ disable_signup: true, external: { google: false } }));
  }
  if (request.method === "POST" && path === "/auth/v1/token") {
    const email = request.body?.email;
    const [status, code] = email === "limited@example.test"
      ? [429, "over_request_rate_limit"]
      : email === "unavailable@example.test"
        ? [503, "unexpected_failure"]
        : [400, "invalid_credentials"];
    response.writeHead(status);
    return response.end(JSON.stringify({ error_code: code, msg: "Scripted Auth refusal" }));
  }
  response.writeHead(501);
  response.end(JSON.stringify({ error: "Endpoint not modelled" }));
}).listen(process.env.PORT || 4930);
