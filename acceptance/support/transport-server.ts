import { createServer } from "node:http";
import { writeFileSync } from "node:fs";
import { once } from "node:events";
import { supabaseHttpGateway } from "../../tests/support/supabase-http-gateway";

// Disposable, loopback-only control of the existing real-Supabase HTTP hop.
// Never included in the application or a production deployment.
async function main() {
  const [target, readyFile] = process.argv.slice(2);
  if (!target || new URL(target).hostname !== "127.0.0.1" || !readyFile) throw new Error("Local Supabase target and private ready file required");
  const gateway = await supabaseHttpGateway(target);
  const control = createServer(async (request, response) => {
    if (request.method === "GET" && request.url === "/paths") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(gateway.paths)); return;
    }
    if (request.method !== "POST" || request.url !== "/state") { response.writeHead(404); response.end(); return; }
    let content = "";
    for await (const chunk of request) {
      content += chunk;
      if (content.length > 1024) { response.writeHead(413); response.end(); return; }
    }
    const state = JSON.parse(content);
    gateway.unavailable(state.unavailable === true, state.pathPrefix ?? "/");
    gateway.stall(state.stall === true);
    if (state.clearPaths) gateway.paths.length = 0;
    response.writeHead(204); response.end();
  });
  control.listen(0, "127.0.0.1");
  await once(control, "listening");
  const address = control.address();
  if (!address || typeof address === "string") throw new Error("Control has no port");
  writeFileSync(readyFile, JSON.stringify({ internalUrl: gateway.url, controlUrl: `http://127.0.0.1:${address.port}` }), { mode: 0o600, flag: "wx" });
  const stop = () => { gateway.close(); control.closeAllConnections(); control.close(); };
  process.once("SIGTERM", stop); process.once("SIGINT", stop);
}
void main();
