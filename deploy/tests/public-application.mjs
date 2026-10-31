import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import path from "node:path";

/** Anonymous requests through the real disposable production proxy, never redirects. */
export function requestPublicApplication(endpoint) {
  const url = new URL(endpoint);
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1") throw new Error("Disposable loopback application required.");
  // Match the deployment probe: fetch may discard Host for a loopback URL.
  return new Promise((resolve, reject) => {
    const request = httpRequest(url, { signal: AbortSignal.timeout(15000), headers: { Host: "app.ivat.cz", "X-Forwarded-Proto": "https" } }, response => {
      const chunks = [];
      response.on("data", chunk => { chunks.push(chunk); });
      response.on("error", reject);
      response.on("end", () => resolve({ status: response.statusCode, contentType: response.headers["content-type"] ?? "", bytes: Buffer.concat(chunks) }));
    });
    request.setTimeout(15000, () => request.destroy(new Error("Disposable application request timed out.")));
    request.on("error", reject);
    request.end();
  });
}

export async function assertPublicApplicationAssets(origin, source) {
  const assets = [
    ["/brand/logo.svg", "public/brand/logo.svg", /^image\/svg\+xml(?:;|$)/],
    ["/brand/mark.svg", "public/brand/mark.svg", /^image\/svg\+xml(?:;|$)/],
    ["/icon.svg", "src/app/icon.svg", /^image\/svg\+xml(?:;|$)/],
    ["/icon1.png", "src/app/icon1.png", /^image\/png(?:;|$)/],
    ["/apple-icon.png", "src/app/apple-icon.png", /^image\/png(?:;|$)/],
    ["/favicon.ico", "src/app/favicon.ico", /^image\/(?:x-icon|vnd.microsoft.icon)(?:;|$)/],
  ];
  for (const [pathname, file, contentType] of assets) {
    const response = await requestPublicApplication(new URL(pathname, origin));
    assert.equal(response.status, 200, `${pathname}: anonymous production response`);
    assert.match(response.contentType, contentType, `${pathname}: image MIME type`);
    assert.deepEqual(response.bytes, await readFile(path.join(source, file)), `${pathname}: exact published asset bytes`);
    if (pathname.endsWith(".svg")) assert.match(response.bytes.toString("utf8"), /<svg\b/, `${pathname}: SVG content`);
    if (pathname.endsWith(".png")) assert.deepEqual(response.bytes.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), `${pathname}: PNG signature`);
    if (pathname.endsWith(".ico")) assert.deepEqual(response.bytes.subarray(0, 4), Buffer.from([0, 0, 1, 0]), `${pathname}: icon signature`);
  }
}
