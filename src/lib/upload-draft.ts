/** Persisted selection. Item order and group identities become fixed at start. */
export type UploadItem = {
  id: string;
  file: File;
  kind: "capture" | "picker";
  progress: number;
  confirmedBytes: number;
  status: "queued" | "uploading" | "retrying" | "uploaded" | "refused";
  error: string | null;
  retryable: boolean;
  sha256: string;
  groupId?: string;
  attemptId?: string | null;
};
export type UploadDraft = { batchId: string | null; items: UploadItem[] };
export type UploadDraftChange =
  | { kind: "dissolve"; groupId: string }
  | { kind: "move"; id: string; by: -1 | 1 }
  | { kind: "remove"; id: string }
  | { kind: "group"; ids: string[]; groupId: string };

export async function restoreUploadDraft(draft: UploadDraft, contentHash: (file: File) => Promise<string>): Promise<UploadDraft> {
  return { batchId: draft.batchId, items: await Promise.all(draft.items.map(async item => ({ ...item,
    sha256: item.sha256 ?? await contentHash(item.file),
    confirmedBytes: 0,
    status: item.status === "uploading" || item.status === "retrying" ? "refused" as const : item.status,
    retryable: item.retryable || item.status === "uploading" || item.status === "retrying",
  }))) };
}

/** The UI and persisted draft use the same before-start transitions. */
export function changeUploadDraft(draft: UploadDraft, change: UploadDraftChange): UploadDraft {
  if (draft.batchId) return draft;
  let items = [...draft.items];
  if (change.kind === "dissolve") items = items.map(item => item.groupId === change.groupId ? { ...item, groupId: undefined } : item);
  if (change.kind === "remove") items = items.filter(item => item.id !== change.id);
  if (change.kind === "move") {
    const index = items.findIndex(item => item.id === change.id), destination = index + change.by;
    if (index >= 0 && destination >= 0 && destination < items.length) [items[index], items[destination]] = [items[destination], items[index]];
  }
  if (change.kind === "group") {
    const selected = items.filter(item => change.ids.includes(item.id));
    if (selected.length < 2 || selected.some(item => !/\.(jpe?g|png|heic|heif)$/i.test(item.file.name))) return draft;
    items = items.map(item => change.ids.includes(item.id) ? { ...item, groupId: change.groupId } : item);
  }
  items = items.map(item => item.groupId && items.filter(other => other.groupId === item.groupId).length < 2 ? { ...item, groupId: undefined } : item);
  return { ...draft, items };
}
