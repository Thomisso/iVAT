"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import type { UploadLimits } from "@/application/source-files";
import { Button } from "@/components/button";
import { DropZone } from "@/components/drop-zone";
import { FormError } from "@/components/form-error";
import { SOURCE_UPLOAD_CHUNK_BYTES } from "@/lib/upload-policy";
import { changeUploadDraft, restoreUploadDraft, reselectUploadFile, type UploadItem, type UploadDraft } from "@/lib/upload-draft";
import { indexedDbUploadDraftStorage, type UploadDraftStorage } from "@/lib/upload-draft-storage";
import { browserImagePreview } from "@/lib/browser-image-preview";

type BatchResult = { ok: true; value: { id: string } } | { ok: false; error: string };
type TransportResult =
  | { kind: "uploaded" }
  | { kind: "retryable_failure" }
  | { kind: "refused"; error: string };

async function contentHash(file: File): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function browserResult<T>(response: Response): Promise<{ ok: true; value: T } | { ok: false; error: string; attemptId?: string }> {
  if (response.redirected || response.status === 401) return { ok: false, error: "upload_authentication_required" };
  if (response.status >= 500 || response.status === 429) throw new Error("Upload service unavailable");
  try {
    const result = await response.json();
    if (result && typeof result === "object" && (result.ok === true || (result.ok === false && typeof result.error === "string"))) return result;
  } catch { /* Refusals without JSON still keep their HTTP meaning. */ }
  if (response.status === 403) return { ok: false, error: "forbidden" };
  if (!response.ok) return { ok: false, error: "upload_failed" };
  throw new Error("Invalid upload service response");
}

async function beginBrowserUploadBatch(companyId: string, batchId: string, items: UploadItem[], signal: AbortSignal): Promise<BatchResult> {
  const response = await fetch(`/companies/${encodeURIComponent(companyId)}/upload-batches`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ batchId, fileCount: items.length, selectedFiles: items.map(({ id, sha256, groupId }) => ({ id, sha256, ...(groupId ? { groupId } : {}) })) }),
    signal,
  });
  return browserResult<{ id: string }>(response);
}

async function finishBrowserUploadBatch(companyId: string, batchId: string, signal: AbortSignal) {
  const response = await fetch(
    `/companies/${encodeURIComponent(companyId)}/upload-batches/${encodeURIComponent(batchId)}/finish`,
    { method: "POST", signal },
  );
  return browserResult<null>(response);
}

type ConfirmedProgress = { attemptId: string | null; confirmedBytes: number; byteSize: number; complete: boolean };
type ProgressResult = { ok: true; value: ConfirmedProgress } | { ok: false; error: string; attemptId?: string };

function sendPortion(
  path: string, batchId: string, item: UploadItem, attemptId: string, offset: number,
  update: (change: Partial<UploadItem>) => void, signal: AbortSignal,
): Promise<ProgressResult | TransportResult> {
  return new Promise((resolve) => {
    const request = new XMLHttpRequest();
    request.open("PUT", path);
    request.responseType = "json";
    request.setRequestHeader("Upload-Batch-Id", batchId);
    request.setRequestHeader("Upload-File-Name", encodeURIComponent(item.fileName!));
    request.setRequestHeader("Upload-Byte-Size", String(item.byteSize!));
    request.setRequestHeader("Upload-Sha256", item.sha256);
    request.setRequestHeader("Upload-Offset", String(offset));
    request.setRequestHeader("Upload-Attempt-Id", attemptId);
    request.upload.addEventListener("progress", (event) => {
      if (event.lengthComputable) update({ progress: Math.min(99, Math.round(((offset + event.loaded) / item.byteSize!) * 100)) });
    });
    request.addEventListener("load", () => {
      const response = request.response as ProgressResult | null;
      if (request.status === 401 || (request.responseURL && new URL(request.responseURL).pathname !== path)) resolve({ kind: "refused", error: "upload_authentication_required" });
      else if (request.status >= 500 || request.status === 0) resolve({ kind: "retryable_failure" });
      else if (response && typeof response.ok === "boolean") resolve(response);
      else if (request.status === 403) resolve({ kind: "refused", error: "forbidden" });
      else resolve({ kind: "refused", error: "upload_failed" });
    });
    request.addEventListener("error", () => resolve({ kind: "retryable_failure" }));
    const abort = () => request.abort();
    signal.addEventListener("abort", abort, { once: true });
    request.addEventListener("abort", () => resolve({ kind: "retryable_failure" }));
    request.addEventListener("loadend", () => signal.removeEventListener("abort", abort));
    if (signal.aborted) { resolve({ kind: "retryable_failure" }); return; }
    request.send(item.file!.slice(offset, offset + SOURCE_UPLOAD_CHUNK_BYTES));
  });
}

async function sendFile(
  companyId: string, batchId: string, item: UploadItem,
  update: (change: Partial<UploadItem>) => void, signal: AbortSignal,
): Promise<TransportResult> {
  const path = `/companies/${encodeURIComponent(companyId)}/source-files/${encodeURIComponent(item.id)}/transfer`;
  const identity = { batchId, fileName: item.fileName!, byteSize: item.byteSize!, sha256: item.sha256 };
  const command = async (complete = false, expectedAttemptId: string | null | undefined = item.attemptId): Promise<ProgressResult> => {
    const response = await fetch(path, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...identity, complete, expectedAttemptId }), signal, redirect: "follow",
    });
    return browserResult<ConfirmedProgress>(response);
  };
  try {
    const reconciled = await command();
    if (!reconciled.ok) {
      if (reconciled.attemptId) update({ attemptId: reconciled.attemptId });
      return { kind: "refused", error: reconciled.error };
    }
    if (item.attemptId !== undefined && item.attemptId !== reconciled.value.attemptId) return { kind: "refused", error: "upload_attempt_changed" };
    const attemptId = reconciled.value.attemptId;
    update({ attemptId });
    let offset = reconciled.value.confirmedBytes;
    update({ confirmedBytes: offset, progress: Math.min(99, Math.round(offset / item.byteSize! * 100)) });
    if (!reconciled.value.complete && !item.file) return { kind: "refused", error: "upload_file_required" };
    while (!reconciled.value.complete && offset < item.byteSize! && !signal.aborted) {
      const portion = await sendPortion(path, batchId, item, attemptId!, offset, update, signal);
      if ("kind" in portion) return portion;
      if (!portion.ok) return { kind: "refused", error: portion.error };
      if (portion.value.confirmedBytes <= offset) return { kind: "retryable_failure" };
      offset = portion.value.confirmedBytes;
      update({ confirmedBytes: offset });
    }
    if (signal.aborted) return { kind: "retryable_failure" };
    const completed = await command(true, attemptId);
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
  const apply = (change: Partial<UploadItem>) => { item = { ...item, ...change }; update(change); };
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (signal.aborted) return;
    update({ status: attempt === 0 ? "uploading" : "retrying", error: null });
    const result = await sendFile(companyId, batchId, item, apply, signal);
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
    void browserImagePreview(item.file!).then((preview) => {
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
    <section className="capture-preview" role="region" aria-label={t("photoPreviewLabel", { name: item.fileName!, number })}>
      {/* A local blob URL is already the exact client-side preview and cannot use next/image. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      {url && <img src={url} alt={t("photoPreviewAlt", { name: item.fileName ?? t("unidentifiedSource") })} />}
      <div><strong className="iv-mono">{item.fileName!}</strong><span>{t("onePhotoOneSourceFile")}</span></div>
      <div className="capture-preview-actions">
        <Button size="sm" onClick={onRetake} disabled={disabled}>{t("retakePhoto")}</Button>
        <Button size="sm" variant="ghost" onClick={onRemove} disabled={disabled}>{t("removePhoto")}</Button>
      </div>
    </section>
  );
}

type UploadFormProps = { companyId: string; userId: string; limits: UploadLimits; storage?: UploadDraftStorage; recoveryDraft?: UploadDraft; recoveryPlannedCount?: number };
export function SourceFileUploadForm(props: UploadFormProps) {
  return <ScopedUploadForm key={`${props.userId}:${props.companyId}:${props.recoveryDraft?.batchId ?? "local"}`} {...props} />;
}
function ScopedUploadForm({ companyId, userId, limits, storage = indexedDbUploadDraftStorage, recoveryDraft, recoveryPlannedCount }: UploadFormProps) {
  const t = useTranslations("sourceFiles");
  const router = useRouter();
  const [items, setItems] = useState<UploadItem[]>([]);
  const itemsRef = useRef<UploadItem[]>([]);
  const [selectedPhotos, setSelectedPhotos] = useState<string[]>([]);
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
  const draftKey = `user:${userId}:company:${companyId}${recoveryDraft?.batchId ? `:batch:${recoveryDraft.batchId}` : ""}`;
  const lifetime = useRef<AbortController | null>(null);
  const writes = useRef<Promise<void>>(Promise.resolve());
  const startedBatch = useRef<string | null>(recoveryDraft?.batchId ?? null);
  const snapshot = (id: string | null, selected: UploadItem[]): UploadDraft => ({ batchId: id, items: selected, ...(id && startedBatch.current === id ? { started: true } : {}) });
  const lastPersistedBatch = useRef<string | null>(recoveryDraft?.batchId ?? null);
  const [localUnavailable, setLocalUnavailable] = useState(false);
  async function persist(draft: UploadDraft | null) {
    const signal = lifetime.current?.signal;
    if (!signal || signal.aborted) return;
    const clearBatch = draft ? null : lastPersistedBatch.current;
    if (draft?.batchId) lastPersistedBatch.current = draft.batchId;
    writes.current = writes.current.then(async () => {
      if (signal.aborted) return;
      try {
        await storage.write(draftKey, draft, signal);
        if (signal.aborted) return;
        if (draft?.batchId && !recoveryDraft) await storage.write(`${draftKey}:batch:${draft.batchId}`, draft, signal);
        if (!draft && clearBatch) {
          const rootKey = `user:${userId}:company:${companyId}`;
          await storage.write(`${rootKey}:batch:${clearBatch}`, null, signal);
          if (recoveryDraft) {
            const previous = await storage.read(rootKey, signal);
            if (previous && typeof previous === "object" && "batchId" in previous && previous.batchId === clearBatch) await storage.write(rootKey, null, signal);
          }
        }
      }
      catch { if (!signal.aborted) setLocalUnavailable(true); }
    });
    await writes.current;
  }

  const replaceItems = (next: UploadItem[]) => {
    itemsRef.current = next;
    setItems(next);
  };
  const update = (index: number, change: Partial<UploadItem>) => {
    if (lifetime.current?.signal.aborted) return;
    const next = itemsRef.current.map((item, itemIndex) =>
      itemIndex === index ? { ...item, ...change } : item,
    );
    itemsRef.current = next;
    setItems(next);
  };
  function removeItem(id: string) {
    const next = changeUploadDraft(snapshot(batchId, itemsRef.current), { kind: "remove", id }).items;
    replaceItems(next);
    setError(next.length > limits.maxBatchFiles ? "too_many_files" : null);
    setDuplicateNotice(false);
    setSelectedPhotos(value => value.filter(selected => selected !== id));
    form.current?.reset();
  }

  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    lifetime.current = controller;
    const load = async () => {
      const draft = await storage.read(draftKey, controller.signal);
      if (!recoveryDraft) return draft;
      if (draft && typeof draft === "object" && "batchId" in draft && draft.batchId === recoveryDraft.batchId) return draft;
      const previous = await storage.read(`user:${userId}:company:${companyId}`, controller.signal);
      return previous && typeof previous === "object" && "batchId" in previous && previous.batchId === recoveryDraft.batchId ? previous : null;
    };
    void load().then(async (draft) => {
      if (!active) return;
      const saved = draft ?? recoveryDraft;
      if (saved) {
        const restoredDraft = await restoreUploadDraft(saved, contentHash);
        const restored = restoredDraft.items;
        if (!active) return;
        itemsRef.current = restored;
        setItems(restored);
        setBatchId(restoredDraft.batchId);
        if (restoredDraft.started || restored.some(item => item.attemptId !== undefined)) startedBatch.current = restoredDraft.batchId;
        setDraftRestored(true);
      }
      setDraftLoaded(true);
    }).catch(async () => {
      if (!active) return;
      setLocalUnavailable(true);
      if (recoveryDraft) {
        const restored = await restoreUploadDraft(recoveryDraft, contentHash);
        if (!active) return;
        replaceItems(restored.items); setBatchId(restored.batchId); setDraftRestored(true);
      }
      setDraftLoaded(true);
    });
    return () => { active = false; controller.abort(); activeUpload.current?.abort(); };
  // Each scope is mounted with a separate key and adapter.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (draftLoaded) void persist(items.length ? snapshot(batchId, items) : null);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [batchId, draftLoaded, items]);

  async function completeBatch(id: string, signal: AbortSignal) {
    const finished = await finishBrowserUploadBatch(companyId, id, signal);
    if (signal.aborted) return;
    if (!finished.ok) { setError(finished.error); return; }
    await persist(null);
    if (signal.aborted) return;
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
        await uploadFile(companyId, id, item, (change) => update(index, change), signal);
      }
    };
    await Promise.all(Array.from({ length: Math.min(3, indices.length) }, () => worker()));
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!itemsRef.current.length) return setError("file_required");
    if (!batchId && itemsRef.current.length > limits.maxBatchFiles) return setError("too_many_files");
    setPending(true);
    setError(null);
    const controller = new AbortController();
    activeUpload.current = controller;
    try {
      const activeBatchId = batchId ?? crypto.randomUUID();
      setBatchId(activeBatchId);
      // Persist the frozen selection and identities before the first request can arrive.
      await persist(snapshot(activeBatchId, itemsRef.current));
      if (controller.signal.aborted) return;
      if (startedBatch.current !== activeBatchId) {
        const started = await beginBrowserUploadBatch(companyId, activeBatchId, itemsRef.current, controller.signal);
        if (!started.ok) return setError(started.error);
        startedBatch.current = activeBatchId;
      }
      const indices = itemsRef.current.flatMap((item, index) => item.status === "queued" || item.retryable ? [index] : []);
      await runUploads(activeBatchId, indices, controller.signal);
      if (!controller.signal.aborted) {
        await persist(snapshot(activeBatchId, itemsRef.current));
        if ((recoveryPlannedCount === undefined || itemsRef.current.length === recoveryPlannedCount) && itemsRef.current.every((item) => item.status === "uploaded")) await completeBatch(activeBatchId, controller.signal);
      }
    } catch {
      setError("upload_failed");
    } finally {
      setPending(false);
    }
  }

  async function retireOrRestart(index: number, action: "cancel" | "restart") {
    if (!batchId) return;
    const item = itemsRef.current[index];
    if (!item.attemptId) return;
    setPending(true);
    const controller = new AbortController();
    activeUpload.current = controller;
    try {
      const response = await fetch(`/companies/${encodeURIComponent(companyId)}/source-files/${encodeURIComponent(item.id)}/transfer`, {
        method: "POST", headers: { "Content-Type": "application/json" }, signal: controller.signal,
        body: JSON.stringify({ batchId, fileName: item.fileName!, byteSize: item.byteSize!, sha256: item.sha256,
          expectedAttemptId: item.attemptId, [action]: true }),
      });
      const result = await browserResult<ConfirmedProgress>(response);
      if (controller.signal.aborted) return;
      if (!result.ok) { update(index, { attemptId: result.attemptId ?? item.attemptId, status: "refused", error: result.error, retryable: result.error === "upload_authentication_required" }); return; }
      if (result.value.complete) {
        update(index, { attemptId: result.value.attemptId, confirmedBytes: result.value.byteSize, progress: 100, status: "uploaded", error: null, retryable: false });
        await persist(snapshot(batchId, itemsRef.current));
        return;
      }
      update(index, { attemptId: result.value.attemptId, confirmedBytes: result.value.confirmedBytes, progress: Math.min(99, Math.round(result.value.confirmedBytes / result.value.byteSize * 100)),
        status: action === "restart" ? "queued" : "refused", error: action === "restart" ? null : "upload_cancelled", retryable: action === "restart" });
      await persist(snapshot(batchId, itemsRef.current));
      if (action === "restart") await uploadFile(companyId, batchId, itemsRef.current[index], change => update(index, change), controller.signal);
    } catch { setError("upload_failed"); }
    finally { setPending(false); }
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
        await persist(snapshot(batchId, itemsRef.current));
        if ((recoveryPlannedCount === undefined || itemsRef.current.length === recoveryPlannedCount) && itemsRef.current.every((item) => item.status === "uploaded")) await completeBatch(batchId, controller.signal);
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

  async function reselect(id: string, file: File) {
    const signal = lifetime.current?.signal;
    setSelecting(true);
    try {
      const result = await reselectUploadFile(snapshot(batchId, itemsRef.current), id, file, contentHash);
      if (signal?.aborted) return;
      if (!result.ok) { setError(result.error); return; }
      replaceItems(result.value.items); setError(null);
      await persist(result.value);
    } catch { if (!signal?.aborted) setError("upload_failed"); }
    finally { if (!signal?.aborted) setSelecting(false); }
  }

  function appendFiles(files: File[], kind: UploadItem["kind"], replacingId: string | null = null) {
    queuedSelections.current += 1;
    setSelecting(true);
    const signal = lifetime.current?.signal;
    selectionWork.current = selectionWork.current.then(async () => {
      if (signal?.aborted) return;
      const next = [...itemsRef.current];
      let duplicate = false;
      for (const file of files) {
        const sha256 = await contentHash(file);
        if (signal?.aborted) return;
        if (next.some((item) => item.id !== replacingId && item.sha256 === sha256)) {
          duplicate = true;
          continue;
        }
        const replacementIndex = replacingId ? next.findIndex(item => item.id === replacingId) : -1;
        const item: UploadItem = { id: crypto.randomUUID(), file, fileName: file.name, byteSize: file.size, kind, sha256, progress: 0, confirmedBytes: 0, status: "queued", error: null, retryable: false,
          ...(replacementIndex >= 0 ? { groupId: next[replacementIndex].groupId } : {}) };
        if (replacementIndex >= 0) next[replacementIndex] = item;
        else next.push(item);
      }
      replaceItems(next);
      setDuplicateNotice(duplicate);
      setDraftRestored(false);
      setError(next.length > limits.maxBatchFiles ? "too_many_files" : null);
      await persist({ batchId: null, items: next });
    }).catch(() => { if (!signal?.aborted) setError("upload_failed"); }).finally(() => {
      if (signal?.aborted) return;
      queuedSelections.current -= 1;
      setSelecting(queuedSelections.current > 0);
    });
  }

  const hasPermanentRefusal = !!batchId && (recoveryPlannedCount !== undefined && items.length < recoveryPlannedCount || items.some((item) => item.status === "refused" && !item.retryable));
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
      {items.filter((item) => item.kind === "capture" && item.file).map((captured, index) => <PhotoPreview
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
      {localUnavailable && <p role="status">{t("localDraftUnavailable")}</p>}
      <p className="iv-muted">{t("sameDeviceRecoveryHint")}</p>
      {draftRestored && <p role="status" className="iv-muted">{t("draftRestored")}</p>}
      {duplicateNotice && <p role="status" className="iv-muted">{t("identicalFileOmitted")}</p>}
      <FormError error={error} />
      {!batchId && items.length > 1 && <Button disabled={pending || selecting || selectedPhotos.length < 2} onClick={() => {
        const groupId = crypto.randomUUID();
        replaceItems(changeUploadDraft(snapshot(batchId, itemsRef.current), { kind: "group", ids: selectedPhotos, groupId }).items);
        setSelectedPhotos([]);
      }}>{t("groupPhotos")}</Button>}
      {items.length > 0 && <ul className="upload-items" aria-live="polite">
        {items.map((item, index) => <li key={item.id}>
          <span className="iv-mono">{item.fileName ?? t("unidentifiedSource")}</span>
          {!item.file && item.status !== "uploaded" && <label>{t("reselectFile")}
            <input type="file" aria-label={t("reselectFile")} disabled={pending || selecting}
              onChange={event => { const file = event.currentTarget.files?.[0]; if (file) void reselect(item.id, file); event.currentTarget.value = ""; }} />
          </label>}
          {!batchId && /\.(jpe?g|png|heic|heif)$/i.test(item.fileName ?? "") && <label><input type="checkbox" checked={selectedPhotos.includes(item.id)} disabled={pending || selecting}
            onChange={event => setSelectedPhotos(value => event.target.checked ? [...value, item.id] : value.filter(id => id !== item.id))} />{t("selectPhoto")}</label>}
          {item.groupId && <span>{t("groupPage", { group: items.findIndex(other => other.groupId === item.groupId) + 1, page: items.slice(0, index + 1).filter(other => other.groupId === item.groupId).length })}
            {!batchId && <Button size="sm" disabled={pending || selecting} onClick={() => replaceItems(changeUploadDraft(snapshot(batchId, itemsRef.current), { kind: "dissolve", groupId: item.groupId! }).items)}>{t("dissolveGroup")}</Button>}
          </span>}
          {!batchId && <span>
            <Button size="sm" disabled={pending || selecting || index === 0} onClick={() => { replaceItems(changeUploadDraft(snapshot(batchId, itemsRef.current), { kind: "move", id: item.id, by: -1 }).items); }}>{t("movePhotoEarlier")}</Button>
            <Button size="sm" disabled={pending || selecting || index === items.length - 1} onClick={() => { replaceItems(changeUploadDraft(snapshot(batchId, itemsRef.current), { kind: "move", id: item.id, by: 1 }).items); }}>{t("movePhotoLater")}</Button>
          </span>}
          <div className="upload-item-progress">
            <progress max={100} value={item.progress} aria-label={t("uploadProgress", { name: item.fileName ?? t("unidentifiedSource") })} />
            <span>{t("transferEstimate", { percent: item.progress })}</span>
            <span>{item.byteSize === null ? t("sourceBytesUnknown") : t("serverConfirmed", { bytes: item.confirmedBytes, total: item.byteSize })}</span>
          </div>
          <span>{t(`uploadStatus.${item.status}`)}
            {!batchId && <Button size="sm" variant="ghost" icon="remove" aria-label={t("removeFile", { name: item.fileName ?? t("unidentifiedSource") })}
              disabled={pending || selecting} onClick={() => removeItem(item.id)} />}
          </span>
          {!item.file && batchId && item.fileName && item.byteSize && <Button size="sm" disabled={pending || selecting} onClick={() => void retry(index)}>{t("checkStoredSource")}</Button>}
          {item.error && <FormError error={item.error} />}
          {(item.error === "upload_expired" || item.error === "upload_cancelled") && item.attemptId && <Button size="sm" onClick={() => void retireOrRestart(index, "restart")} disabled={pending || !item.file}>{t("restartFullUpload")}</Button>}
          {batchId && item.attemptId && item.status !== "uploaded" && item.error !== "upload_cancelled" && <Button size="sm" variant="ghost" onClick={() => void retireOrRestart(index, "cancel")} disabled={pending}>{t("cancelTransfer")}</Button>}
          {item.error === "upload_attempt_changed" && <Button size="sm" disabled={pending} onClick={() => { update(index, { attemptId: undefined }); void retry(index); }}>{t("checkCurrentTransfer")}</Button>}
          {item.retryable && <Button size="sm" onClick={() => void retry(index)} disabled={pending || !item.file}>
            {t("retryUpload", { name: item.fileName ?? t("unidentifiedSource") })}
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
