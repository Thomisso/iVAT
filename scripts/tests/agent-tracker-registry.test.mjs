import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { initialState, parseRegistry, renderRegistry } from "../agent-tracking/state.mjs";

test("a large registry round-trips all retained state within the comment budget", () => {
  const state = initialState();
  state.tickets[201] = { number: 201, evidence: "Retained independent review and delivery: ř".repeat(2000) };
  state.remote = { views: { board: { id: "PVT_view", groupingVerified: true } } };
  assert.ok(Buffer.byteLength(JSON.stringify(state)) > 60 * 1024);
  const body = renderRegistry(state);
  assert.ok(Buffer.byteLength(body) <= 60 * 1024);
  assert.deepEqual(parseRegistry(body), state);
});

const wrap = value => `<!-- ivat-agent-tracker:registry:v1 -->\n\n\`\`\`json\n${JSON.stringify(value)}\n\`\`\`\n`;
const encoded = bytes => ({ registryEncoding: "gzip-base64-v1", decodedBytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"), data: gzipSync(bytes).toString("base64") });

test("small legacy JSON remains byte-for-byte readable and renderable", () => {
  const legacy = '<!-- ivat-agent-tracker:registry:v1 -->\n\n```json\n{"schemaVersion":1,"revision":0,"generation":0,"owner":null,"tickets":{},"receipts":{},"publishedRevision":0}\n```\n';
  assert.deepEqual(parseRegistry(legacy), initialState());
  assert.equal(renderRegistry(parseRegistry(legacy)), legacy);
});

test("compressed snapshots reject mismatched integrity metadata", () => {
  const envelope = encoded(Buffer.from(JSON.stringify(initialState())));
  assert.deepEqual(parseRegistry(wrap(envelope)), initialState());
  assert.throws(() => parseRegistry(wrap({ ...envelope, sha256: "0".repeat(64) })), { code: "registry_invalid" });
  assert.throws(() => parseRegistry(wrap({ ...envelope, decodedBytes: envelope.decodedBytes - 1 })), { code: "registry_invalid" });
});

test("decoded snapshots have a four MiB budget even when highly compressible", () => {
  const state = initialState();
  state.tickets[201] = { evidence: "x".repeat(4 * 1024 * 1024) };
  assert.throws(() => renderRegistry(state), { code: "registry_capacity_exceeded" });
  const envelope = encoded(Buffer.from(JSON.stringify(state)));
  assert.throws(() => parseRegistry(wrap(envelope)), { code: "registry_capacity_exceeded" });
  assert.throws(() => parseRegistry(wrap({ ...envelope, decodedBytes: 100 })), { code: "registry_invalid" });
});

test("corrupt, unknown and malformed compressed representations are refused", () => {
  const envelope = encoded(Buffer.from(JSON.stringify(initialState())));
  const corrupt = Buffer.from(envelope.data, "base64");
  corrupt[corrupt.length - 1] ^= 1;
  for (const value of [
    { ...envelope, data: corrupt.toString("base64") },
    { ...envelope, data: envelope.data.slice(0, -4) },
    { ...envelope, data: envelope.data + "!" },
    { ...envelope, registryEncoding: "gzip-base64-v2" },
    { ...envelope, decodedBytes: 0 },
    { ...envelope, decodedBytes: "123" },
    encoded(Buffer.from('{"schemaVersion":2}')),
    encoded(Buffer.from([0x22, 0xff, 0x22])),
  ]) assert.throws(() => parseRegistry(wrap(value)), { code: "registry_invalid" });
});

test("the complete rendered UTF-8 body stays bounded even with an encoded payload", () => {
  const body = wrap(encoded(Buffer.from(JSON.stringify(initialState()))));
  const atLimit = body + " ".repeat(60 * 1024 - Buffer.byteLength(body));
  assert.deepEqual(parseRegistry(atLimit), initialState());
  assert.throws(() => parseRegistry(atLimit + "\u3000"), { code: "registry_capacity_exceeded" });
  const state = initialState();
  state.tickets[201] = { evidence: Array.from({ length: 4096 }, (_, index) => createHash("sha256").update(String(index)).digest("hex")).join("") };
  assert.throws(() => renderRegistry(state), { code: "registry_capacity_exceeded" });
});

test("legacy logical fields cannot be mistaken for a representation envelope", () => {
  const state = { ...initialState(), registryEncoding: "retained legacy metadata" };
  assert.deepEqual(parseRegistry(wrap(state)), state);
  state.tickets[201] = { evidence: "retained".repeat(10000) };
  assert.deepEqual(parseRegistry(renderRegistry(state)), state);
});
