import { createServer } from "node:http";
import { once } from "node:events";

/** A real HTTP hop to the running local Supabase stack. Only failures are
 * injected; successful Auth/REST/Storage responses always come from Supabase. */
export async function supabaseHttpGateway(target: string) {
  let unavailable = false;
  let refusalsRemaining = 0;
  const paths: string[] = [];
  const server = createServer(async (request, response) => {
    paths.push(request.url ?? "/");
    if (unavailable || refusalsRemaining > 0) {
      refusalsRemaining = Math.max(0, refusalsRemaining - 1);
      response.writeHead(503, { "content-type": "application/json" });
      response.end(JSON.stringify({ message: "Dependency unavailable" }));
      return;
    }
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const headers = new Headers();
      for (const [name, value] of Object.entries(request.headers)) {
        if (value && !["host", "connection", "content-length"].includes(name)) headers.set(name, String(value));
      }
      const result = await fetch(`${target}${request.url}`, {
        method: request.method, headers, body: chunks.length ? Buffer.concat(chunks) : undefined, redirect: "manual",
      });
      response.writeHead(result.status, Object.fromEntries([...result.headers].filter(([key]) => !["content-encoding", "content-length", "transfer-encoding"].includes(key))));
      response.end(Buffer.from(await result.arrayBuffer()));
    } catch {
      response.writeHead(502);
      response.end();
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Gateway has no port");
  return {
    url: `http://127.0.0.1:${address.port}`,
    paths,
    refuseNext: (count: number) => { refusalsRemaining = count; },
    unavailable: (value: boolean) => { unavailable = value; },
    close: () => { server.closeAllConnections(); server.close(); },
  };
}
