// Postman's simulation runtime loads handlers as CommonJS.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const http = require("http");

const PORT = process.env.PORT || 4920;
const JSON_HEADERS = { "content-type": "application/json" };
const path = /^\/ekonomicke-subjekty-v-be\/rest\/ekonomicke-subjekty(-rzp)?\/(\d{8})$/;

const server = http.createServer((request, response) => {
  const match = request.method === "GET" ? path.exec(request.url || "") : null;
  if (!match) {
    response.writeHead(501, JSON_HEADERS);
    return response.end(JSON.stringify({ error: "Endpoint not modelled" }));
  }
  const ico = match[2];
  if (ico === "90000003") {
    response.writeHead(503, JSON_HEADERS);
    return response.end(JSON.stringify({ kod: "NEOCEKAVANA_CHYBA", popis: "Registry unavailable" }));
  }
  response.writeHead(200, JSON_HEADERS);
  if (match[1]) return response.end(JSON.stringify({
    icoId: ico,
    zaznamy: [{ ico, primarniZaznam: true, osobaPodnikatel: {
      jmeno: "Marie Anna", ...(ico === "90000002" ? {} : { prijmeni: "Nováková" }),
    }, angazovaneOsoby: [{ jmeno: "Petr", prijmeni: "Jiný" }] }],
  }));
  const natural = ico === "90000001" || ico === "90000002";
  response.end(JSON.stringify({
    ico,
    obchodniJmeno: natural ? "Ing. Marie Anna Nováková - studio" : "ARES Test s.r.o.",
    pravniForma: natural ? "101" : "112",
    dic: `CZ${ico}`,
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
