/** Persisted selection. Item order and group identities become fixed at start. */
export type UploadItem = {
  id: string;
  file?: File;
  fileName: string | null;
  byteSize: number | null;
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
export type UploadDraft = { batchId: string | null; items: UploadItem[]; started?: boolean };
export type UploadDraftChange =
  | { kind: "dissolve"; groupId: string }
  | { kind: "move"; id: string; by: -1 | 1 }
  | { kind: "remove"; id: string }
  | { kind: "group"; ids: string[]; groupId: string };

/** Treat stored content as untrusted input; older drafts derive metadata from their File. */
export async function restoreUploadDraft(value: unknown, contentHash: (file: File) => Promise<string>): Promise<UploadDraft> {
  if (!value || typeof value !== "object") throw new Error("Invalid upload draft");
  const draft = value as UploadDraft;
  if (!(draft.batchId === null || typeof draft.batchId === "string") || !Array.isArray(draft.items)) throw new Error("Invalid upload draft");
  const items = await Promise.all(draft.items.map(async item => {
    if (!item || typeof item.id !== "string" || !item.id || !["picker", "capture"].includes(item.kind)
      || !["queued", "uploading", "retrying", "uploaded", "refused"].includes(item.status)
      || !(item.error === null || typeof item.error === "string")
      || (item.attemptId !== undefined && item.attemptId !== null && typeof item.attemptId !== "string")
      || (item.groupId !== undefined && typeof item.groupId !== "string")) throw new Error("Invalid upload item");
    let file = item.file && typeof item.file.arrayBuffer === "function" && typeof item.file.slice === "function" ? item.file : undefined;
    const fileName = item.fileName ?? file?.name ?? null;
    const byteSize = item.byteSize ?? file?.size ?? null;
    if ((fileName !== null && (typeof fileName !== "string" || !fileName.trim()))
      || (byteSize !== null && (!Number.isSafeInteger(byteSize) || byteSize < 1))) throw new Error("Invalid upload identity");
    let sha256 = item.sha256;
    if (!sha256 && file) sha256 = await contentHash(file);
    if (typeof sha256 !== "string" || !/^[0-9a-f]{64}$/.test(sha256)) throw new Error("Invalid upload checksum");
    // A saved checksum never proves that the locally retained File still contains those bytes.
    if (file) {
      try { if (file.size !== byteSize || await contentHash(file) !== sha256) file = undefined; }
      catch { file = undefined; }
    }
    const lifecycle = ["upload_expired", "upload_cancelled", "upload_attempt_changed"].includes(item.error ?? "");
    const interrupted = item.status === "uploading" || item.status === "retrying";
    const claimedComplete = item.status === "uploaded";
    return { ...item, file, fileName, byteSize, sha256, progress: 0, confirmedBytes: 0,
      status: !file || interrupted ? "refused" as const : claimedComplete ? "queued" as const : item.status,
      retryable: !!file && !lifecycle && (item.retryable || interrupted || claimedComplete),
      error: file || lifecycle ? item.error : "upload_file_required" };
  }));
  if (new Set(items.map(item => item.id)).size !== items.length) throw new Error("Duplicate upload identities");
  return { batchId: draft.batchId, items, ...(draft.started === true ? { started: true } : {}) };
}

/** Reattaches verified bytes to the same manifest item, including a previously discovered attempt. */
export async function reselectUploadFile(draft: UploadDraft, id: string, file: File, contentHash: (file: File) => Promise<string>): Promise<
  { ok: true; value: UploadDraft } | { ok: false; error: "upload_checksum_mismatch" }
> {
  const item = draft.items.find(item => item.id === id);
  if (!item || (item.byteSize !== null && item.byteSize !== file.size) || await contentHash(file) !== item.sha256) {
    return { ok: false, error: "upload_checksum_mismatch" };
  }
  // Lifecycle refusals require their explicit action even after the right bytes are available.
  const lifecycle = ["upload_expired", "upload_cancelled", "upload_attempt_changed"].includes(item.error ?? "");
  return { ok: true, value: { ...draft, items: draft.items.map(current => current.id !== id ? current : {
    ...current, file, fileName: current.fileName ?? file.name, byteSize: current.byteSize ?? file.size,
    status: lifecycle ? "refused" : "queued", error: lifecycle ? current.error : null, retryable: !lifecycle,
  }) } };
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
    if (selected.length < 2 || selected.some(item => !/\.(jpe?g|png|heic|heif)$/i.test(item.fileName ?? ""))) return draft;
    items = items.map(item => change.ids.includes(item.id) ? { ...item, groupId: change.groupId } : item);
  }
  items = items.map(item => item.groupId && items.filter(other => other.groupId === item.groupId).length < 2 ? { ...item, groupId: undefined } : item);
  return { ...draft, items };
}
