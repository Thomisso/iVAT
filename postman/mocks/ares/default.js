// Postman's simulation runtime loads handlers as CommonJS.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const http = require("http");

const PORT = process.env.PORT || 4920;
const JSON_HEADERS = { "content-type": "application/json" };
const path = /^\/ekonomicke-subjekty-v-be\/rest\/ekonomicke-subjekty\/(\d{8})$/;

const server = http.createServer((request, response) => {
  const match = request.method === "GET" ? path.exec(request.url || "") : null;
  if (!match) {
    response.writeHead(501, JSON_HEADERS);
    return response.end(JSON.stringify({ error: "Endpoint not modelled" }));
  }
  response.writeHead(200, JSON_HEADERS);
  response.end(JSON.stringify({
    ico: match[1],
    obchodniJmeno: "ARES Test s.r.o.",
    dic: `CZ${match[1]}`,
    sidlo: {
      nazevUlice: "Dlouhá",
      cisloDomovni: 12,
      cisloOrientacni: "53A",
      nazevObce: "Praha",
      psc: 11000,
    },
  }));
});

server.listen(PORT);
