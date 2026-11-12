"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import type { UploadLimits } from "@/application/source-files";
import { Button } from "@/components/button";
import { DropZone } from "@/components/drop-zone";
import { FormError } from "@/components/form-error";
import { SOURCE_UPLOAD_CHUNK_BYTES } from "@/lib/upload-policy";
import { browserImagePreview } from "@/lib/browser-image-preview";

type UploadItem = {
  id: string;
  file: File;
  kind: "capture" | "picker";
  progress: number;
  confirmedBytes: number;
  status: "queued" | "uploading" | "retrying" | "uploaded" | "refused";
  error: string | null;
  retryable: boolean;
  sha256: string;
};
type UploadDraft = { batchId: string | null; items: UploadItem[] };
type BatchResult = { ok: true; value: { id: string } } | { ok: false; error: string };
type TransportResult =
  | { kind: "uploaded" }
  | { kind: "retryable_failure" }
  | { kind: "refused"; error: string };

const DRAFT_DATABASE = "ivat-upload-drafts";
const DRAFT_STORE = "drafts";

async function contentHash(file: File): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function openDraftDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DRAFT_DATABASE, 1);
    request.addEventListener("upgradeneeded", () => {
      if (!request.result.objectStoreNames.contains(DRAFT_STORE)) request.result.createObjectStore(DRAFT_STORE);
    });
    request.addEventListener("success", () => resolve(request.result));
    request.addEventListener("error", () => reject(request.error));
  });
}

async function readDraft(key: string): Promise<UploadDraft | null> {
  const database = await openDraftDatabase();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(DRAFT_STORE, "readonly");
    const request = transaction.objectStore(DRAFT_STORE).get(key);
    request.addEventListener("success", () => resolve((request.result as UploadDraft | undefined) ?? null));
    request.addEventListener("error", () => reject(request.error));
    transaction.addEventListener("complete", () => database.close());
  });
}

async function writeDraft(key: string, draft: UploadDraft | null): Promise<void> {
  const database = await openDraftDatabase();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(DRAFT_STORE, "readwrite");
    const store = transaction.objectStore(DRAFT_STORE);
    if (draft) store.put(draft, key);
    else store.delete(key);
    transaction.addEventListener("complete", () => {
      database.close();
      resolve();
    });
    transaction.addEventListener("error", () => reject(transaction.error));
  });
}

async function beginBrowserUploadBatch(companyId: string, batchId: string, items: UploadItem[], signal: AbortSignal): Promise<BatchResult> {
  const response = await fetch(`/companies/${encodeURIComponent(companyId)}/upload-batches`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ batchId, fileCount: items.length, selectedFiles: items.map(({ id, sha256 }) => ({ id, sha256 })) }),
    signal,
  });
  return response.json() as Promise<BatchResult>;
}

async function finishBrowserUploadBatch(companyId: string, batchId: string, signal: AbortSignal) {
  const response = await fetch(
    `/companies/${encodeURIComponent(companyId)}/upload-batches/${encodeURIComponent(batchId)}/finish`,
    { method: "POST", signal },
  );
  if (!response.ok) throw new Error("upload batch could not be finished");
}

type ConfirmedProgress = { confirmedBytes: number; byteSize: number; complete: boolean };
type ProgressResult = { ok: true; value: ConfirmedProgress } | { ok: false; error: string };

function sendPortion(
  path: string, batchId: string, item: UploadItem, offset: number,
  update: (change: Partial<UploadItem>) => void, signal: AbortSignal,
): Promise<ProgressResult | TransportResult> {
  return new Promise((resolve) => {
    const request = new XMLHttpRequest();
    request.open("PUT", path);
    request.responseType = "json";
    request.setRequestHeader("Upload-Batch-Id", batchId);
    request.setRequestHeader("Upload-File-Name", encodeURIComponent(item.file.name));
    request.setRequestHeader("Upload-Byte-Size", String(item.file.size));
    request.setRequestHeader("Upload-Sha256", item.sha256);
    request.setRequestHeader("Upload-Offset", String(offset));
    request.upload.addEventListener("progress", (event) => {
      if (event.lengthComputable) update({ progress: Math.min(99, Math.round(((offset + event.loaded) / item.file.size) * 100)) });
    });
    request.addEventListener("load", () => {
      const response = request.response as ProgressResult | null;
      if (request.responseURL && new URL(request.responseURL).pathname !== path) resolve({ kind: "refused", error: "upload_authentication_required" });
      else if (request.status >= 500 || request.status === 0) resolve({ kind: "retryable_failure" });
      else if (response) resolve(response);
      else resolve({ kind: "refused", error: "upload_failed" });
    });
    request.addEventListener("error", () => resolve({ kind: "retryable_failure" }));
    const abort = () => request.abort();
    signal.addEventListener("abort", abort, { once: true });
    request.addEventListener("abort", () => resolve({ kind: "retryable_failure" }));
    request.addEventListener("loadend", () => signal.removeEventListener("abort", abort));
    if (signal.aborted) { resolve({ kind: "retryable_failure" }); return; }
    request.send(item.file.slice(offset, offset + SOURCE_UPLOAD_CHUNK_BYTES));
  });
}

async function sendFile(
  companyId: string, batchId: string, item: UploadItem,
  update: (change: Partial<UploadItem>) => void, signal: AbortSignal,
): Promise<TransportResult> {
  const path = `/companies/${encodeURIComponent(companyId)}/source-files/${encodeURIComponent(item.id)}/transfer`;
  const identity = { batchId, fileName: item.file.name, byteSize: item.file.size, sha256: item.sha256 };
  const command = async (complete = false) => {
    const response = await fetch(path, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...identity, complete }), signal, redirect: "follow",
    });
    if (response.redirected) return { ok: false, error: "upload_authentication_required" } as const;
    if (response.status >= 500) throw new Error("upload unavailable");
    return response.json() as Promise<ProgressResult>;
  };
  try {
    const reconciled = await command();
    if (!reconciled.ok) return { kind: "refused", error: reconciled.error };
    let offset = reconciled.value.confirmedBytes;
    update({ confirmedBytes: offset, progress: Math.min(99, Math.round(offset / item.file.size * 100)) });
    while (!reconciled.value.complete && offset < item.file.size && !signal.aborted) {
      const portion = await sendPortion(path, batchId, item, offset, update, signal);
      if ("kind" in portion) return portion;
      if (!portion.ok) return { kind: "refused", error: portion.error };
      if (portion.value.confirmedBytes <= offset) return { kind: "retryable_failure" };
      offset = portion.value.confirmedBytes;
      update({ confirmedBytes: offset });
    }
    if (signal.aborted) return { kind: "retryable_failure" };
    const completed = await command(true);
    return completed.ok ? { kind: "uploaded" } : { kind: "refused", error: completed.error };
  } catch {
    return { kind: "retryable_failure" };
  }
}

async function uploadFile(
  companyId: string,
  batchId: string,
  item: UploadItem,
  update: (change: Partial<UploadItem>) => void,
  signal: AbortSignal,
) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (signal.aborted) return;
    update({ status: attempt === 0 ? "uploading" : "retrying", error: null });
    const result = await sendFile(companyId, batchId, item, update, signal);
    if (signal.aborted) return;
    if (result.kind === "uploaded") {
      update({ status: "uploaded", progress: 100, error: null, retryable: false });
      return;
    }
    if (result.kind === "refused") {
      update({ status: "refused", error: result.error, retryable: result.error === "upload_authentication_required" });
      return;
    }
  }
  update({ status: "refused", error: "upload_failed", retryable: true });
}

function PhotoPreview({
  item,
  disabled,
  onRemove,
  onRetake,
  number,
}: {
  item: UploadItem;
  disabled: boolean;
  onRemove: () => void;
  onRetake: () => void;
  number: number;
}) {
  const t = useTranslations("sourceFiles");
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    let objectUrl: string | null = null;
    void browserImagePreview(item.file).then((preview) => {
      objectUrl = URL.createObjectURL(preview);
      if (active) setUrl(objectUrl);
      else URL.revokeObjectURL(objectUrl);
    }).catch(() => {
      if (active) setUrl(null);
    });
    return () => {
      active = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [item.file]);
  return (
    <section className="capture-preview" role="region" aria-label={t("photoPreviewLabel", { name: item.file.name, number })}>
      {/* A local blob URL is already the exact client-side preview and cannot use next/image. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      {url && <img src={url} alt={t("photoPreviewAlt", { name: item.file.name })} />}
      <div><strong className="iv-mono">{item.file.name}</strong><span>{t("onePhotoOneSourceFile")}</span></div>
      <div className="capture-preview-actions">
        <Button size="sm" onClick={onRetake} disabled={disabled}>{t("retakePhoto")}</Button>
        <Button size="sm" variant="ghost" onClick={onRemove} disabled={disabled}>{t("removePhoto")}</Button>
      </div>
    </section>
  );
}

export function SourceFileUploadForm({ companyId, userId, limits }: { companyId: string; userId: string; limits: UploadLimits }) {
  const t = useTranslations("sourceFiles");
  const router = useRouter();
  const [items, setItems] = useState<UploadItem[]>([]);
  const itemsRef = useRef<UploadItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [selecting, setSelecting] = useState(false);
  const [duplicateNotice, setDuplicateNotice] = useState(false);
  const [batchId, setBatchId] = useState<string | null>(null);
  const [draftLoaded, setDraftLoaded] = useState(false);
  const [draftRestored, setDraftRestored] = useState(false);
  const camera = useRef<HTMLInputElement>(null);
  const form = useRef<HTMLFormElement>(null);
  const selectionWork = useRef<Promise<void>>(Promise.resolve());
  const queuedSelections = useRef(0);
  const retakeId = useRef<string | null>(null);
  const activeUpload = useRef<AbortController | null>(null);
  const draftKey = `user:${userId}:company:${companyId}`;

  const replaceItems = (next: UploadItem[]) => {
    itemsRef.current = next;
    setItems(next);
  };
  const update = (index: number, change: Partial<UploadItem>) => {
    const next = itemsRef.current.map((item, itemIndex) =>
      itemIndex === index ? { ...item, ...change } : item,
    );
    itemsRef.current = next;
    setItems(next);
  };
  function removeItem(id: string) {
    const next = itemsRef.current.filter((item) => item.id !== id);
    replaceItems(next);
    setError(next.length > limits.maxBatchFiles ? "too_many_files" : null);
    setDuplicateNotice(false);
    form.current?.reset();
  }

  useEffect(() => {
    let active = true;
    void readDraft(draftKey).then(async (draft) => {
      if (!active) return;
      if (draft?.items.length) {
        const restored = await Promise.all(draft.items.map(async (item) => ({ ...item,
          sha256: item.sha256 ?? await contentHash(item.file),
          confirmedBytes: 0,
          status: item.status === "uploading" || item.status === "retrying" ? "refused" as const : item.status,
          retryable: item.retryable || item.status === "uploading" || item.status === "retrying",
        })));
        if (!active) return;
        itemsRef.current = restored;
        setItems(restored);
        setBatchId(draft.batchId);
        setDraftRestored(true);
      }
      setDraftLoaded(true);
    }).catch(() => setDraftLoaded(true));
    return () => { active = false; activeUpload.current?.abort(); };
  }, [draftKey]);

  useEffect(() => {
    if (draftLoaded) void writeDraft(draftKey, items.length ? { batchId, items } : null);
  }, [batchId, draftKey, draftLoaded, items]);

  async function completeBatch(id: string, signal: AbortSignal) {
    await finishBrowserUploadBatch(companyId, id, signal);
    if (signal.aborted) return;
    await writeDraft(draftKey, null);
    setBatchId(null);
    form.current?.reset();
    replaceItems([]);
    router.push(`/companies/${encodeURIComponent(companyId)}/upload-batches/${encodeURIComponent(id)}`);
  }

  async function runUploads(id: string, indices: number[], signal: AbortSignal) {
    let next = 0;
    const worker = async () => {
      while (next < indices.length && !signal.aborted) {
        const index = indices[next++];
        const item = itemsRef.current[index];
        if (item.file.size > limits.maxFileBytes) {
          update(index, { status: "refused", error: "file_too_large", retryable: false });
          continue;
        }
        await uploadFile(companyId, id, item, (change) => update(index, change), signal);
      }
    };
    await Promise.all(Array.from({ length: Math.min(3, indices.length) }, () => worker()));
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!itemsRef.current.length) return setError("file_required");
    if (itemsRef.current.length > limits.maxBatchFiles) return setError("too_many_files");
    setPending(true);
    setError(null);
    const controller = new AbortController();
    activeUpload.current = controller;
    try {
      const activeBatchId = batchId ?? crypto.randomUUID();
      setBatchId(activeBatchId);
      // Persist the frozen selection and identities before the first request can arrive.
      await writeDraft(draftKey, { batchId: activeBatchId, items: itemsRef.current });
      const started = await beginBrowserUploadBatch(companyId, activeBatchId, itemsRef.current, controller.signal);
      if (!started.ok) return setError(started.error);
      const indices = itemsRef.current.flatMap((item, index) => item.status === "queued" || item.retryable ? [index] : []);
      await runUploads(activeBatchId, indices, controller.signal);
      if (!controller.signal.aborted) {
        await writeDraft(draftKey, { batchId: activeBatchId, items: itemsRef.current });
        if (itemsRef.current.every((item) => item.status === "uploaded")) await completeBatch(activeBatchId, controller.signal);
      }
    } catch {
      setError("upload_failed");
    } finally {
      setPending(false);
    }
  }

  async function retry(index: number) {
    if (!batchId) return;
    setPending(true);
    setError(null);
    const controller = new AbortController();
    activeUpload.current = controller;
    try {
      await uploadFile(companyId, batchId, itemsRef.current[index], (change) => update(index, change), controller.signal);
      if (!controller.signal.aborted) {
        await writeDraft(draftKey, { batchId, items: itemsRef.current });
        if (itemsRef.current.every((item) => item.status === "uploaded")) await completeBatch(batchId, controller.signal);
      }
    } catch {
      setError("upload_failed");
    } finally {
      setPending(false);
    }
  }

  async function finishWithFailures() {
    if (!batchId) return;
    setPending(true);
    setError(null);
    const controller = new AbortController();
    activeUpload.current = controller;
    try {
      // Keep the original planned count/manifest and every successful Source File.
      // The existing finish command records the missing transfers as failures.
      await completeBatch(batchId, controller.signal);
    } catch {
      setError("upload_failed");
    } finally {
      setPending(false);
    }
  }

  function appendFiles(files: File[], kind: UploadItem["kind"], replacingId: string | null = null) {
    queuedSelections.current += 1;
    setSelecting(true);
    selectionWork.current = selectionWork.current.then(async () => {
      let next = [...itemsRef.current];
      let duplicate = false;
      for (const file of files) {
        const sha256 = await contentHash(file);
        if (next.some((item) => item.id !== replacingId && item.sha256 === sha256)) {
          duplicate = true;
          continue;
        }
        if (replacingId) next = next.filter((item) => item.id !== replacingId);
        next.push({ id: crypto.randomUUID(), file, kind, sha256, progress: 0, confirmedBytes: 0, status: "queued", error: null, retryable: false });
      }
      replaceItems(next);
      setDuplicateNotice(duplicate);
      setDraftRestored(false);
      setError(next.length > limits.maxBatchFiles ? "too_many_files" : null);
      await writeDraft(draftKey, { batchId: null, items: next });
    }).catch(() => setError("upload_failed")).finally(() => {
      queuedSelections.current -= 1;
      setSelecting(queuedSelections.current > 0);
    });
  }

  const hasPermanentRefusal = !!batchId && items.some((item) => item.status === "refused" && !item.retryable);
  const hasRetryableFiles = items.some((item) => item.status === "queued" || item.retryable);
  const allFilesUploaded = items.length > 0 && items.every((item) => item.status === "uploaded");

  return (
    <form ref={form} onSubmit={submit} className="form upload-form">
      {/* Shown only on a coarse pointer or a small viewport (globals.css). */}
      <div className="capture-action">
        <label className="iv-btn iv-btn-primary iv-btn-md" htmlFor="document-camera" onClick={() => { retakeId.current = null; }}>{t("takeDocumentPhoto")}</label>
        <input
          ref={camera}
          id="document-camera"
          className="sr-only"
          type="file"
          accept="image/jpeg,image/png,image/heic,image/heif,.heic,.heif"
          capture="environment"
          disabled={pending || !!batchId || !draftLoaded}
          onChange={(event) => {
            const file = event.currentTarget.files?.[0];
            if (!file) return;
            appendFiles([file], "capture", retakeId.current);
            retakeId.current = null;
            event.currentTarget.value = "";
          }}
        />
        <p>{t("captureHint")}</p>
      </div>
      {items.filter((item) => item.kind === "capture").map((captured, index) => <PhotoPreview
        key={captured.id}
        item={captured}
        number={index + 1}
        disabled={pending || selecting || !!batchId}
        onRetake={() => { retakeId.current = captured.id; camera.current?.click(); }}
        onRemove={() => removeItem(captured.id)}
      />)}
      <div className="upload-picker-separator"><span>{t("orChooseFiles")}</span></div>
      <DropZone
        multiple
        disabled={pending || !!batchId || !draftLoaded}
        accept=".pdf,.png,.jpg,.jpeg,.heic,.heif,.xlsx,.xls,image/heic,image/heif"
        hint={t("batchHint", {
          count: limits.maxBatchFiles,
          size: Math.floor(limits.maxFileBytes / 1024 / 1024),
          pages: limits.maxFilePages,
        })}
        onFiles={(event) => {
          const selected = Array.from(event.currentTarget.files ?? []);
          appendFiles(selected, "picker");
          event.currentTarget.value = "";
        }}
      />
      {draftRestored && <p role="status" className="iv-muted">{t("draftRestored")}</p>}
      {duplicateNotice && <p role="status" className="iv-muted">{t("identicalFileOmitted")}</p>}
      <FormError error={error} />
      {items.length > 0 && <ul className="upload-items" aria-live="polite">
        {items.map((item, index) => <li key={item.id}>
          <span className="iv-mono">{item.file.name}</span>
          <div className="upload-item-progress">
            <progress max={100} value={item.progress} aria-label={t("uploadProgress", { name: item.file.name })} />
            <span>{t("transferEstimate", { percent: item.progress })}</span>
            <span>{t("serverConfirmed", { bytes: item.confirmedBytes, total: item.file.size })}</span>
          </div>
          <span>{t(`uploadStatus.${item.status}`)}
            {!batchId && <Button size="sm" variant="ghost" icon="remove" aria-label={t("removeFile", { name: item.file.name })}
              disabled={pending || selecting} onClick={() => removeItem(item.id)} />}
          </span>
          {item.error && <FormError error={item.error} />}
          {item.retryable && <Button size="sm" onClick={() => void retry(index)} disabled={pending}>
            {t("retryUpload", { name: item.file.name })}
          </Button>}
        </li>)}
      </ul>}
      <Button variant="primary" icon="upload" type="submit" disabled={pending || selecting || !draftLoaded || (!!batchId && !hasRetryableFiles && !allFilesUploaded)}>
        {pending ? t("uploading") : batchId ? allFilesUploaded ? t("finishBatch") : t("retryFailedFiles") : t("upload")}
      </Button>
      {hasPermanentRefusal && <div>
        <p>{t("finishWithFailuresHint")}</p>
        <Button onClick={() => void finishWithFailures()} disabled={pending}>{t("finishWithFailures")}</Button>
      </div>}
    </form>
  );
}
