import { createHash } from "node:crypto";
import { gzipSync, gunzipSync } from "node:zlib";
import { TrackerError } from "./github.mjs";

export const registryBodyLimit = 60 * 1024;
export const registryDecodedLimit = 4 * 1024 * 1024;
export const registryMarker = "<!-- ivat-agent-tracker:registry:v1 -->";
const partMarker = "<!-- ivat-agent-tracker:part:v1 -->";
const encoding = "gzip-parts-v1";
const partLimit = 32 * 1024;
const countLimit = 256;
const compressedLimit = partLimit * countLimit;
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const digest = value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const positive = value => Number.isSafeInteger(value) && value > 0;
const invalid = () => { throw new TrackerError("registry_invalid"); };
const capacity = () => { throw new TrackerError("registry_capacity_exceeded"); };
const keys = (value, names) => value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === names.length && names.every(name => Object.hasOwn(value, name));

function wrap(marker, value) {
  const body = `${marker}\n\n\`\`\`json\n${JSON.stringify(value)}\n\`\`\`\n`;
  if (Buffer.byteLength(body) > registryBodyLimit) capacity();
  return body;
}

function container(body, marker) {
  if (typeof body !== "string") invalid();
  if (Buffer.byteLength(body) > registryBodyLimit) capacity();
  const prefix = `${marker}\n\n\`\`\`json\n`;
  if (!body.startsWith(prefix) || !body.endsWith("\n```\n")) invalid();
  try { return JSON.parse(body.slice(prefix.length, -5)); } catch { invalid(); }
}

export function isPartsManifest(value) {
  return value && !Object.hasOwn(value, "schemaVersion") && value.registryEncoding === encoding;
}

export function decodeParts(manifest, comments, commentId) {
  if (!keys(manifest, ["registryEncoding", "decodedBytes", "sha256", "compressedBytes", "compressedSha256", "parts"]) || !positive(commentId)
    || !positive(manifest.decodedBytes) || !positive(manifest.compressedBytes) || !digest(manifest.sha256) || !digest(manifest.compressedSha256)
    || !Array.isArray(manifest.parts) || !manifest.parts.length) invalid();
  if (manifest.decodedBytes > registryDecodedLimit || manifest.compressedBytes > compressedLimit || manifest.parts.length > countLimit) capacity();
  if (!Array.isArray(comments)) invalid();
  const seen = new Set();
  const buffers = manifest.parts.map((descriptor, index) => {
    if (!keys(descriptor, ["id", "bytes", "sha256"]) || !positive(descriptor.id) || !positive(descriptor.bytes) || !digest(descriptor.sha256) || seen.has(descriptor.id)) invalid();
    if (descriptor.bytes > partLimit) capacity();
    seen.add(descriptor.id);
    const matches = comments.filter(comment => comment.id === descriptor.id);
    if (matches.length !== 1) invalid();
    const part = container(matches[0].body, partMarker);
    if (!keys(part, ["rootCommentId", "snapshotSha256", "index", "count", "sha256", "data"])
      || part.rootCommentId !== commentId || part.snapshotSha256 !== manifest.sha256 || part.index !== index || part.count !== manifest.parts.length
      || part.sha256 !== descriptor.sha256 || typeof part.data !== "string") invalid();
    const bytes = Buffer.from(part.data, "base64");
    if (bytes.toString("base64") !== part.data || bytes.length !== descriptor.bytes || hash(bytes) !== descriptor.sha256) invalid();
    return bytes;
  });
  const compressed = Buffer.concat(buffers);
  if (compressed.length !== manifest.compressedBytes || hash(compressed) !== manifest.compressedSha256) invalid();
  try {
    const decoded = gunzipSync(compressed, { maxOutputLength: registryDecodedLimit });
    if (decoded.length !== manifest.decodedBytes || hash(decoded) !== manifest.sha256) invalid();
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(decoded));
  } catch (error) {
    if (error instanceof TrackerError) throw error;
    invalid();
  }
}

/** Immutable parts are retained, including orphans. Only the root commits state. */
export function publishParts(github, config, commentId, state) {
  const json = JSON.stringify(state);
  const decodedBytes = Buffer.byteLength(json);
  if (decodedBytes > registryDecodedLimit) capacity();
  const compressed = gzipSync(json);
  const sha256 = hash(json);
  const count = Math.ceil(compressed.length / partLimit);
  if (compressed.length > compressedLimit || count > countLimit) capacity();
  const parts = Array.from({ length: count }, (_, index) => {
    const bytes = compressed.subarray(index * partLimit, (index + 1) * partLimit);
    return { bytes: bytes.length, sha256: hash(bytes), body: wrap(partMarker, {
      rootCommentId: commentId, snapshotSha256: sha256, index, count, sha256: hash(bytes), data: bytes.toString("base64"),
    }) };
  });
  const manifest = descriptors => ({ registryEncoding: encoding, decodedBytes, sha256,
    compressedBytes: compressed.length, compressedSha256: hash(compressed), parts: descriptors });
  // Bound the complete root before creating anything, including worst-case IDs.
  wrap(registryMarker, manifest(parts.map(part => ({ id: Number.MAX_SAFE_INTEGER, bytes: part.bytes, sha256: part.sha256 }))));
  const endpoint = `repos/${config.repository}/issues/${config.registryIssue}/comments`;
  let comments = github.pages(endpoint);
  const descriptors = parts.map(part => {
    const find = () => comments.filter(comment => comment.body === part.body).sort((first, second) => first.id - second.id)[0];
    let stored = find();
    if (!stored) {
      try { stored = github.request(endpoint, { method: "POST", body: { body: part.body } }); }
      catch (error) {
        // An ambiguous POST may already have created the exact immutable part.
        comments = github.pages(endpoint);
        stored = find();
        if (!stored) throw error;
      }
    }
    if (!positive(stored?.id)) invalid();
    const observed = github.request(`repos/${config.repository}/issues/comments/${stored.id}`);
    if (observed?.id !== stored.id || observed.body !== part.body) invalid();
    return { id: stored.id, bytes: part.bytes, sha256: part.sha256 };
  });
  const body = wrap(registryMarker, manifest(descriptors));
  return github.request(`repos/${config.repository}/issues/comments/${commentId}`, { method: "PATCH", body: { body } });
}
