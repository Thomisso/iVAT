import { expect, it } from "vitest";
import { changeUploadDraft, restoreUploadDraft, reselectUploadFile, type UploadDraft } from "@/lib/upload-draft";
import { createHash } from "node:crypto";
const hashFile = async (file: File) => createHash("sha256").update(new Uint8Array(await file.arrayBuffer())).digest("hex");

it("reselects identical bytes under a new name without changing the frozen manifest or attempt", async () => {
  const draft: UploadDraft = { batchId: "batch", items: [{ id: "first", fileName: "original.png", byteSize: 3,
    sha256: "039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81", kind: "picker", groupId: "group", attemptId: "old-attempt",
    progress: 0, confirmedBytes: 0, status: "refused", retryable: false, error: "upload_file_required" }] };
  const wrong = await reselectUploadFile(draft, "first", new File([new Uint8Array([3, 2, 1])], "original.png"), hashFile);
  expect(wrong).toEqual({ ok: false, error: "upload_checksum_mismatch" });
  expect(draft.items[0].file).toBeUndefined();
  const matched = await reselectUploadFile(draft, "first", new File([new Uint8Array([1, 2, 3])], "renamed.png"), hashFile);
  expect(matched.ok).toBe(true);
  if (!matched.ok) throw new Error("Expected identical bytes");
  expect(matched.value.items.map(({ file, ...item }) => { void file; return item; })).toEqual([{ ...draft.items[0], error: null, retryable: true, status: "queued" }]);
  expect(await matched.value.items[0].file!.arrayBuffer()).toEqual(new Uint8Array([1, 2, 3]).buffer);
});

it("restores immutable metadata without evicted bytes and never restores estimated progress", async () => {
  const saved = { batchId: "batch", items: [{ id: "source", fileName: "original.png", byteSize: 3,
    sha256: "a".repeat(64), kind: "picker", groupId: "group", attemptId: "attempt",
    progress: 99, confirmedBytes: 2, status: "uploading", retryable: false, error: null }] };
  const restored = await restoreUploadDraft(saved as unknown as UploadDraft, async () => { throw new Error("No bytes exist"); });
  expect(restored).toEqual({ batchId: "batch", items: [{ ...saved.items[0], file: undefined,
    progress: 0, confirmedBytes: 0, status: "refused", retryable: false, error: "upload_file_required" }] });
});

it("restores the pending ordered group and permits dissolution before start", async () => {
  const file = new File([new Uint8Array([1, 2, 3])], "page.png", { type: "image/png" });
  const item = { file, fileName: file.name, byteSize: file.size, kind: "picker" as const, progress: 0, confirmedBytes: 0, status: "queued" as const, error: null, retryable: false, sha256: "a".repeat(64) };
  const saved: UploadDraft = { batchId: null, items: [{ ...item, id: "first", groupId: "group" }, { ...item, id: "second", groupId: "group" }, { ...item, id: "ordinary" }] };
  const restored = await restoreUploadDraft(saved, async () => "a".repeat(64));
  expect(restored.items.map(({ id, groupId }) => [id, groupId])).toEqual([["first", "group"], ["second", "group"], ["ordinary", undefined]]);
  const moved = changeUploadDraft(restored, { kind: "move", id: "second", by: -1 });
  expect(moved.items.map(({ id, groupId }) => [id, groupId])).toEqual([["second", "group"], ["first", "group"], ["ordinary", undefined]]);
  const dissolved = changeUploadDraft(moved, { kind: "dissolve", groupId: "group" });
  expect(dissolved.items.map(({ id, groupId }) => [id, groupId])).toEqual([["second", undefined], ["first", undefined], ["ordinary", undefined]]);
  expect(saved.items.map(item => item.id)).toEqual(["first", "second", "ordinary"]);
  expect(new Uint8Array(await dissolved.items[0].file!.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
});

it("keeps the started manifest and identities immutable through restoration and draft edits", async () => {
  const file = new File(["original"], "page.heic");
  const item = { file, fileName: file.name, byteSize: file.size, kind: "capture" as const, progress: 30, confirmedBytes: 3, status: "uploading" as const, error: null, retryable: false, sha256: "c".repeat(64), groupId: "group" };
  const restored = await restoreUploadDraft({ batchId: "batch", items: [{ ...item, id: "first" }, { ...item, id: "second" }] }, async () => "c".repeat(64));
  expect(restored.items.map(({ id, sha256, groupId, status, confirmedBytes, retryable }) => ({ id, sha256, groupId, status, confirmedBytes, retryable }))).toEqual([
    { id: "first", sha256: "c".repeat(64), groupId: "group", status: "refused", confirmedBytes: 0, retryable: true },
    { id: "second", sha256: "c".repeat(64), groupId: "group", status: "refused", confirmedBytes: 0, retryable: true },
  ]);
  for (const change of [{ kind: "move", id: "second", by: -1 }, { kind: "remove", id: "first" }, { kind: "dissolve", groupId: "group" }] as const) expect(changeUploadDraft(restored, change)).toEqual(restored);
});

it("requires server reconciliation for locally uploaded items and preserves undefined, UUID and null attempt identities", async () => {
  const file = new File([new Uint8Array([1, 2, 3])], "page.png");
  const base = { file, fileName: "page.png", byteSize: 3, sha256: "039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81",
    kind: "picker" as const, progress: 100, confirmedBytes: 3, status: "uploaded" as const, error: null, retryable: false };
  const restored = await restoreUploadDraft({ batchId: "batch", items: [{ ...base, id: "undiscovered" }, { ...base, id: "known", attemptId: "attempt-A" }, { ...base, id: "legacy", attemptId: null }] }, hashFile);
  expect(restored.items.map(({ attemptId, status, progress, confirmedBytes, retryable }) => ({ attemptId, status, progress, confirmedBytes, retryable }))).toEqual([
    { attemptId: undefined, status: "queued", progress: 0, confirmedBytes: 0, retryable: true },
    { attemptId: "attempt-A", status: "queued", progress: 0, confirmedBytes: 0, retryable: true },
    { attemptId: null, status: "queued", progress: 0, confirmedBytes: 0, retryable: true },
  ]);
});
