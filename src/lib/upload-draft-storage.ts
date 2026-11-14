import type { UploadDraft } from "./upload-draft";

/** Platform boundary. A failure affects local recovery, never server upload authority. */
export interface UploadDraftStorage {
  read(key: string, signal: AbortSignal): Promise<unknown>;
  write(key: string, draft: UploadDraft | null, signal: AbortSignal): Promise<void>;
}

const DATABASE = "ivat-upload-drafts", STORE = "drafts";
function open(signal: AbortSignal): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(signal.reason); return; }
    const request = indexedDB.open(DATABASE, 1);
    let finished = false;
    const fail = (reason: unknown) => { finished = true; signal.removeEventListener("abort", abort); reject(reason); };
    const abort = () => fail(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    request.addEventListener("upgradeneeded", () => {
      if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE);
    });
    request.addEventListener("blocked", () => fail(new Error("Local upload storage is blocked")));
    request.addEventListener("error", () => fail(request.error));
    request.addEventListener("success", () => {
      signal.removeEventListener("abort", abort);
      if (finished || signal.aborted) request.result.close();
      else { request.result.addEventListener("versionchange", () => request.result.close()); resolve(request.result); }
    });
  });
}
async function transaction(key: string, signal: AbortSignal, write: boolean, draft?: UploadDraft | null): Promise<unknown> {
  const database = await open(signal);
  try {
    return await new Promise((resolve, reject) => {
      if (signal.aborted) { reject(signal.reason); return; }
      const tx = database.transaction(STORE, write ? "readwrite" : "readonly");
      const store = tx.objectStore(STORE);
      const request = write ? draft ? store.put(draft, key) : store.delete(key) : store.get(key);
      const abort = () => tx.abort();
      signal.addEventListener("abort", abort, { once: true });
      const clean = () => signal.removeEventListener("abort", abort);
      tx.addEventListener("complete", () => { clean(); resolve(write ? undefined : request.result ?? null); });
      tx.addEventListener("abort", () => { clean(); reject(tx.error ?? new Error("Local upload storage aborted")); });
      tx.addEventListener("error", () => { clean(); reject(tx.error); });
    });
  } finally { database.close(); }
}
export const indexedDbUploadDraftStorage: UploadDraftStorage = {
  read: (key, signal) => transaction(key, signal, false),
  async write(key, draft, signal) {
    try { await transaction(key, signal, true, draft); }
    catch (error) {
      if (!(error instanceof DOMException) || !["DataCloneError", "QuotaExceededError"].includes(error.name) || !draft) throw error;
      // Retain identities even when this platform cannot clone File blobs.
      await transaction(key, signal, true, { ...draft, items: draft.items.map(item => ({ ...item, file: undefined })) });
    }
  },
};
