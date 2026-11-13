import { expect, it } from "vitest";
import { changeUploadDraft, restoreUploadDraft, type UploadDraft } from "@/lib/upload-draft";

it("restores the pending ordered group and permits dissolution before start", async () => {
  const file = new File([new Uint8Array([1, 2, 3])], "page.png", { type: "image/png" });
  const item = { file, kind: "picker" as const, progress: 0, confirmedBytes: 0, status: "queued" as const, error: null, retryable: false, sha256: "a".repeat(64) };
  const saved: UploadDraft = { batchId: null, items: [{ ...item, id: "first", groupId: "group" }, { ...item, id: "second", groupId: "group" }, { ...item, id: "ordinary" }] };
  const restored = await restoreUploadDraft(saved, async () => "b".repeat(64));
  expect(restored.items.map(({ id, groupId }) => [id, groupId])).toEqual([["first", "group"], ["second", "group"], ["ordinary", undefined]]);
  const moved = changeUploadDraft(restored, { kind: "move", id: "second", by: -1 });
  expect(moved.items.map(({ id, groupId }) => [id, groupId])).toEqual([["second", "group"], ["first", "group"], ["ordinary", undefined]]);
  const dissolved = changeUploadDraft(moved, { kind: "dissolve", groupId: "group" });
  expect(dissolved.items.map(({ id, groupId }) => [id, groupId])).toEqual([["second", undefined], ["first", undefined], ["ordinary", undefined]]);
  expect(saved.items.map(item => item.id)).toEqual(["first", "second", "ordinary"]);
  expect(new Uint8Array(await dissolved.items[0].file.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
});

it("keeps the started manifest and identities immutable through restoration and draft edits", async () => {
  const file = new File(["original"], "page.heic");
  const item = { file, kind: "capture" as const, progress: 30, confirmedBytes: 3, status: "uploading" as const, error: null, retryable: false, sha256: "c".repeat(64), groupId: "group" };
  const restored = await restoreUploadDraft({ batchId: "batch", items: [{ ...item, id: "first" }, { ...item, id: "second" }] }, async () => "d".repeat(64));
  expect(restored.items.map(({ id, sha256, groupId, status, confirmedBytes, retryable }) => ({ id, sha256, groupId, status, confirmedBytes, retryable }))).toEqual([
    { id: "first", sha256: "c".repeat(64), groupId: "group", status: "refused", confirmedBytes: 0, retryable: true },
    { id: "second", sha256: "c".repeat(64), groupId: "group", status: "refused", confirmedBytes: 0, retryable: true },
  ]);
  for (const change of [{ kind: "move", id: "second", by: -1 }, { kind: "remove", id: "first" }, { kind: "dissolve", groupId: "group" }] as const) expect(changeUploadDraft(restored, change)).toEqual(restored);
});
