"use client";

import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import type { UploadLimits } from "@/application/source-files";
import { DIRECTIONS, type Direction } from "@/application/extraction-payload";
import { Button } from "@/components/button";
import { DropZone } from "@/components/drop-zone";
import { FormError } from "@/components/form-error";

type UploadItem = {
  id: string;
  file: File;
  kind: "capture" | "picker";
  progress: number;
  status: "queued" | "uploading" | "retrying" | "uploaded" | "refused";
  error: string | null;
  retryable: boolean;
};
type UploadDraft = { batchId: string | null; direction: Direction | ""; items: UploadItem[] };
type BatchResult = { ok: true; value: { id: string } } | { ok: false; error: string };
type TransportResult =
  | { kind: "uploaded" }
  | { kind: "retryable_failure" }
  | { kind: "refused"; error: string };

const DRAFT_DATABASE = "ivat-upload-drafts";
const DRAFT_STORE = "drafts";

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

async function beginBrowserUploadBatch(companyId: string, fileCount: number): Promise<BatchResult> {
  const response = await fetch(`/companies/${encodeURIComponent(companyId)}/upload-batches`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ fileCount }),
  });
  return response.json() as Promise<BatchResult>;
}

async function finishBrowserUploadBatch(companyId: string, batchId: string) {
  const response = await fetch(
    `/companies/${encodeURIComponent(companyId)}/upload-batches/${encodeURIComponent(batchId)}/finish`,
    { method: "POST" },
  );
  if (!response.ok) throw new Error("upload batch could not be finished");
}

function sendFile(
  companyId: string,
  batchId: string,
  item: UploadItem,
  direction: Direction | "",
  update: (change: Partial<UploadItem>) => void,
): Promise<TransportResult> {
  return new Promise((resolve) => {
    const request = new XMLHttpRequest();
    request.open("POST", `/companies/${encodeURIComponent(companyId)}/source-files`);
    request.responseType = "json";
    request.upload.addEventListener("progress", (event) => {
      if (event.lengthComputable) update({ status: "uploading", progress: Math.round((event.loaded / event.total) * 100) });
    });
    request.addEventListener("load", () => {
      const response = request.response as { ok: boolean; error?: string } | null;
      if (request.status >= 200 && request.status < 300 && response?.ok) resolve({ kind: "uploaded" });
      else if (request.status >= 500 || request.status === 0) resolve({ kind: "retryable_failure" });
      else resolve({ kind: "refused", error: response?.error ?? "upload_failed" });
    });
    request.addEventListener("error", () => resolve({ kind: "retryable_failure" }));
    const data = new FormData();
    data.set("batchId", batchId);
    if (direction) data.set("direction", direction);
    data.set("file", item.file);
    request.send(data);
  });
}

async function uploadFile(
  companyId: string,
  batchId: string,
  item: UploadItem,
  direction: Direction | "",
  update: (change: Partial<UploadItem>) => void,
) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    update({ status: attempt === 0 ? "uploading" : "retrying", error: null });
    const result = await sendFile(companyId, batchId, item, direction, update);
    if (result.kind === "uploaded") {
      update({ status: "uploaded", progress: 100, error: null, retryable: false });
      return;
    }
    if (result.kind === "refused") {
      update({ status: "refused", error: result.error, retryable: false });
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
}: {
  item: UploadItem;
  disabled: boolean;
  onRemove: () => void;
  onRetake: () => void;
}) {
  const t = useTranslations("sourceFiles");
  const url = useMemo(() => URL.createObjectURL(item.file), [item.file]);
  useEffect(() => {
    return () => URL.revokeObjectURL(url);
  }, [url]);
  return (
    <section className="capture-preview" role="region" aria-label={t("photoPreview")}>
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

export function SourceFileUploadForm({ companyId, limits }: { companyId: string; limits: UploadLimits }) {
  const t = useTranslations("sourceFiles");
  const router = useRouter();
  const [items, setItems] = useState<UploadItem[]>([]);
  const itemsRef = useRef<UploadItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [direction, setDirection] = useState<Direction | "">("");
  const [batchId, setBatchId] = useState<string | null>(null);
  const [draftLoaded, setDraftLoaded] = useState(false);
  const [draftRestored, setDraftRestored] = useState(false);
  const camera = useRef<HTMLInputElement>(null);
  const form = useRef<HTMLFormElement>(null);
  const draftKey = `company:${companyId}`;

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

  useEffect(() => {
    let active = true;
    void readDraft(draftKey).then((draft) => {
      if (!active) return;
      if (draft?.items.length) {
        itemsRef.current = draft.items;
        setItems(draft.items);
        setDirection(draft.direction);
        setBatchId(draft.batchId);
        setDraftRestored(true);
      }
      setDraftLoaded(true);
    }).catch(() => setDraftLoaded(true));
    return () => { active = false; };
  }, [draftKey]);

  useEffect(() => {
    if (draftLoaded) void writeDraft(draftKey, items.length ? { batchId, direction, items } : null);
  }, [batchId, direction, draftKey, draftLoaded, items]);

  async function completeBatch(id: string) {
    await finishBrowserUploadBatch(companyId, id);
    await writeDraft(draftKey, null);
    setBatchId(null);
    form.current?.reset();
    replaceItems([]);
    setDirection("");
    router.push(`/companies/${encodeURIComponent(companyId)}/upload-batches/${encodeURIComponent(id)}`);
  }

  async function runUploads(id: string, indices: number[]) {
    let next = 0;
    const worker = async () => {
      while (next < indices.length) {
        const index = indices[next++];
        const item = itemsRef.current[index];
        if (item.file.size > limits.maxFileBytes) {
          update(index, { status: "refused", error: "file_too_large", retryable: false });
          continue;
        }
        await uploadFile(companyId, id, item, direction, (change) => update(index, change));
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
    try {
      let activeBatchId = batchId;
      if (!activeBatchId) {
        const started = await beginBrowserUploadBatch(companyId, itemsRef.current.length);
        if (!started.ok) return setError(started.error);
        activeBatchId = started.value.id;
        setBatchId(activeBatchId);
      }
      const indices = itemsRef.current.flatMap((item, index) => item.status === "uploaded" ? [] : [index]);
      await runUploads(activeBatchId, indices);
      if (!itemsRef.current.some((item) => item.retryable)) await completeBatch(activeBatchId);
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
    try {
      await uploadFile(companyId, batchId, itemsRef.current[index], direction, (change) => update(index, change));
      if (!itemsRef.current.some((item) => item.retryable)) await completeBatch(batchId);
    } catch {
      setError("upload_failed");
    } finally {
      setPending(false);
    }
  }

  const selectedItems = (files: File[], kind: UploadItem["kind"]): UploadItem[] => files.map((file) => ({
    id: crypto.randomUUID(),
    file,
    kind,
    progress: 0,
    status: "queued",
    error: null,
    retryable: false,
  }));
  const captured = items.find((item) => item.kind === "capture");

  return (
    <form ref={form} onSubmit={submit} className="form upload-form">
      <div className="iv-field">
        <label className="iv-field-label" htmlFor="upload-direction">{t("direction")}</label>
        <select
          id="upload-direction"
          name="direction"
          value={direction}
          disabled={pending || !!batchId}
          onChange={(event) => setDirection(event.currentTarget.value as Direction | "")}
        >
          <option value="">{t("directionAutomatic")}</option>
          {DIRECTIONS.map((value) => <option key={value} value={value}>{t(`directionValue.${value}`)}</option>)}
        </select>
      </div>
      <div className="capture-action">
        <label className="iv-btn iv-btn-primary iv-btn-md" htmlFor="document-camera">{t("takeDocumentPhoto")}</label>
        <input
          ref={camera}
          id="document-camera"
          className="sr-only"
          type="file"
          accept="image/jpeg,image/png,image/heic,image/heif,.heic,.heif"
          capture="environment"
          disabled={pending || !!batchId}
          onChange={(event) => {
            const file = event.currentTarget.files?.[0];
            if (!file) return;
            replaceItems([...itemsRef.current.filter((item) => item.kind !== "capture"), ...selectedItems([file], "capture")]);
            setDraftRestored(false);
            setError(null);
            event.currentTarget.value = "";
          }}
        />
        <p>{t("captureHint")}</p>
      </div>
      {captured && <PhotoPreview
        item={captured}
        disabled={pending || !!batchId}
        onRetake={() => camera.current?.click()}
        onRemove={() => replaceItems(itemsRef.current.filter((item) => item.id !== captured.id))}
      />}
      <div className="upload-picker-separator"><span>{t("orChooseFiles")}</span></div>
      <DropZone
        multiple
        disabled={pending || !!batchId}
        accept=".pdf,.png,.jpg,.jpeg,.heic,.heif,.xlsx,.xls,image/heic,image/heif"
        hint={t("batchHint", {
          count: limits.maxBatchFiles,
          size: Math.floor(limits.maxFileBytes / 1024 / 1024),
          pages: limits.maxFilePages,
        })}
        onFiles={(event) => {
          const selected = Array.from(event.currentTarget.files ?? []);
          replaceItems([...itemsRef.current.filter((item) => item.kind !== "picker"), ...selectedItems(selected, "picker")]);
          setDraftRestored(false);
          setError(selected.length > limits.maxBatchFiles ? "too_many_files" : null);
        }}
      />
      {draftRestored && <p role="status" className="iv-muted">{t("draftRestored")}</p>}
      <FormError error={error} />
      {items.length > 0 && <ul className="upload-items" aria-live="polite">
        {items.map((item, index) => <li key={item.id}>
          <span className="iv-mono">{item.file.name}</span>
          <progress max={100} value={item.progress} aria-label={t("uploadProgress", { name: item.file.name })} />
          <span>{t(`uploadStatus.${item.status}`)}</span>
          {item.error && <FormError error={item.error} />}
          {item.retryable && <Button size="sm" onClick={() => void retry(index)} disabled={pending}>
            {t("retryUpload", { name: item.file.name })}
          </Button>}
        </li>)}
      </ul>}
      <Button variant="primary" icon="upload" type="submit" disabled={pending || !draftLoaded}>
        {pending ? t("uploading") : t("upload")}
      </Button>
    </form>
  );
}
