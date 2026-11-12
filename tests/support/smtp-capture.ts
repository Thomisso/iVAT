import { createServer, type Socket } from "node:net";

/** Owned loopback SMTP, with explicit responses and no external forwarding. */
export async function localSmtpCapture(outcome: "accepted" | "refused" | "unknown") {
  const messages: string[] = [];
  const sockets = new Set<Socket>();
  const server = createServer(socket => {
    sockets.add(socket); socket.on("close", () => sockets.delete(socket));
    socket.setEncoding("utf8"); socket.write("220 local.example.test ESMTP\r\n");
    let buffer = "", data = false, body = "";
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      while (buffer.includes("\r\n")) {
        const boundary = buffer.indexOf("\r\n");
        const line = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2);
        if (data) {
          if (line !== ".") { body += `${line}\r\n`; continue; }
          messages.push(body); data = false;
          if (outcome === "unknown") { socket.destroy(); return; }
          socket.write("250 2.0.0 accepted by controlled SMTP\r\n");
        } else if (/^EHLO|^HELO/i.test(line)) socket.write("250 local.example.test\r\n");
        else if (/^MAIL FROM/i.test(line)) socket.write("250 OK\r\n");
        else if (/^RCPT TO/i.test(line)) socket.write(outcome === "refused" ? "550 5.1.1 refused by controlled SMTP\r\n" : "250 OK\r\n");
        else if (/^DATA/i.test(line)) { data = true; socket.write("354 end with dot\r\n"); }
        else if (/^QUIT/i.test(line)) socket.end("221 goodbye\r\n");
        else socket.write("250 OK\r\n");
      }
    });
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("SMTP fixture did not bind loopback");
  return { port: address.port, messages, async close() {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  } };
}
