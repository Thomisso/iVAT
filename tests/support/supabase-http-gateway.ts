import { createServer } from "node:http";
import { once } from "node:events";

/** A real HTTP hop to the running local Supabase stack. Only failures are
 * injected; successful Auth/REST/Storage responses always come from Supabase. */
export async function supabaseHttpGateway(target: string) {
  let unavailable = false;
  let refusalsRemaining = 0;
  let failedPathPrefix = "/";
  let stalled = false;
  const paths: string[] = [];
  let held: { prefix: string; entered: () => void; released: Promise<void> } | undefined;
  const server = createServer(async (request, response) => {
    paths.push(request.url ?? "/");
    if (held && request.url?.startsWith(held.prefix)) {
      const current = held; held = undefined; current.entered(); await current.released;
    }
    // Hold the actual socket open without headers to exercise client deadlines.
    if (stalled) return;
    if ((unavailable && request.url?.startsWith(failedPathPrefix)) || refusalsRemaining > 0) {
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
    holdNext(prefix: string) {
      let entered!: () => void, release!: () => void;
      const started = new Promise<void>(resolve => { entered = resolve; });
      const released = new Promise<void>(resolve => { release = resolve; });
      held = { prefix, entered, released };
      return { started, release };
    },
    refuseNext: (count: number) => { refusalsRemaining = count; },
    unavailable: (value: boolean, pathPrefix = "/") => { unavailable = value; failedPathPrefix = pathPrefix; },
    stall: (value: boolean) => { stalled = value; },
    close: () => { server.closeAllConnections(); server.close(); },
  };
}
