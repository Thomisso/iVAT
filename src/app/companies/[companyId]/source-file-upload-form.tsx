"use client";

import { useRef, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import type { UploadLimits } from "@/application/source-files";
import {
  DIRECTIONS,
  type Direction,
} from "@/application/extraction-payload";
import { Button } from "@/components/button";
import { DropZone } from "@/components/drop-zone";
import { FormError } from "@/components/form-error";

type UploadItem = {
  file: File;
  progress: number;
  status: "queued" | "uploading" | "uploaded" | "refused";
  error: string | null;
};

type BatchResult =
  | { ok: true; value: { id: string } }
  | { ok: false; error: string };

async function beginBrowserUploadBatch(
  companyId: string,
  fileCount: number,
): Promise<BatchResult> {
  const response = await fetch(
    `/companies/${encodeURIComponent(companyId)}/upload-batches`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fileCount }),
    },
  );
  return response.json() as Promise<BatchResult>;
}

async function finishBrowserUploadBatch(companyId: string, batchId: string) {
  const response = await fetch(
    `/companies/${encodeURIComponent(companyId)}/upload-batches/${encodeURIComponent(batchId)}/finish`,
    { method: "POST" },
  );
  if (!response.ok) throw new Error("upload batch could not be finished");
}

function uploadFile(
  companyId: string,
  batchId: string,
  item: UploadItem,
  direction: Direction | "",
  update: (change: Partial<UploadItem>) => void,
): Promise<void> {
  return new Promise((resolve) => {
    const request = new XMLHttpRequest();
    request.open(
      "POST",
      `/companies/${encodeURIComponent(companyId)}/source-files`,
    );
    request.responseType = "json";
    request.upload.addEventListener("progress", (event) => {
      if (event.lengthComputable) {
        update({
          status: "uploading",
          progress: Math.round((event.loaded / event.total) * 100),
        });
      }
    });
    request.addEventListener("load", () => {
      const response = request.response as
        | { ok: true }
        | { ok: false; error?: string }
        | null;
      if (request.status >= 200 && request.status < 300 && response?.ok) {
        update({ status: "uploaded", progress: 100, error: null });
      } else {
        update({
          status: "refused",
          error:
            response && !response.ok && response.error
              ? response.error
              : "upload_failed",
        });
      }
      resolve();
    });
    request.addEventListener("error", () => {
      update({ status: "refused", error: "upload_failed" });
      resolve();
    });
    const data = new FormData();
    data.set("batchId", batchId);
    if (direction) data.set("direction", direction);
    data.set("file", item.file);
    request.send(data);
  });
}

export function SourceFileUploadForm({
  companyId,
  limits,
}: {
  companyId: string;
  limits: UploadLimits;
}) {
  const t = useTranslations("sourceFiles");
  const router = useRouter();
  const [items, setItems] = useState<UploadItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [direction, setDirection] = useState<Direction | "">("");
  const form = useRef<HTMLFormElement>(null);

  const update = (index: number, change: Partial<UploadItem>) => {
    setItems((current) =>
      current.map((item, itemIndex) =>
        itemIndex === index ? { ...item, ...change } : item,
      ),
    );
  };

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!items.length) return setError("file_required");
    if (items.length > limits.maxBatchFiles) return setError("too_many_files");
    setPending(true);
    setError(null);
    try {
      const started = await beginBrowserUploadBatch(companyId, items.length);
      if (!started.ok) {
        setError(started.error);
        return;
      }

      let next = 0;
      const worker = async () => {
        while (next < items.length) {
          const index = next++;
          const item = items[index];
          if (item.file.size > limits.maxFileBytes) {
            update(index, { status: "refused", error: "file_too_large" });
            continue;
          }
          await uploadFile(
            companyId,
            started.value.id,
            item,
            direction,
            (change) => update(index, change),
          );
        }
      };
      await Promise.all(
        Array.from({ length: Math.min(3, items.length) }, () => worker()),
      );
      await finishBrowserUploadBatch(companyId, started.value.id);
      form.current?.reset();
      setDirection("");
      router.refresh();
    } catch {
      setError("upload_failed");
    } finally {
      setPending(false);
    }
  }

  return (
    <form ref={form} onSubmit={submit} className="form upload-form">
      <div className="iv-field">
        <label className="iv-field-label" htmlFor="upload-direction">
          {t("direction")}
        </label>
        <select
          id="upload-direction"
          name="direction"
          value={direction}
          disabled={pending}
          onChange={(event) =>
            setDirection(event.currentTarget.value as Direction | "")
          }
        >
          <option value="">{t("directionAutomatic")}</option>
          {DIRECTIONS.map((value) => (
            <option key={value} value={value}>
              {t(`directionValue.${value}`)}
            </option>
          ))}
        </select>
      </div>
      <DropZone
        required
        multiple
        disabled={pending}
        hint={t("batchHint", {
          count: limits.maxBatchFiles,
          size: Math.floor(limits.maxFileBytes / 1024 / 1024),
          pages: limits.maxFilePages,
        })}
        onFiles={(event) => {
          const selected = Array.from(event.currentTarget.files ?? []);
          setItems(
            selected.map((file) => ({
              file,
              progress: 0,
              status: "queued",
              error: null,
            })),
          );
          setError(
            selected.length > limits.maxBatchFiles ? "too_many_files" : null,
          );
        }}
      />
      <FormError error={error} />
      {items.length > 0 && (
        <ul className="upload-items" aria-live="polite">
          {items.map((item, index) => (
            <li key={`${item.file.name}-${item.file.lastModified}-${index}`}>
              <span className="iv-mono">{item.file.name}</span>
              <progress max={100} value={item.progress} />
              <span>{t(`uploadStatus.${item.status}`)}</span>
              {item.error && <FormError error={item.error} />}
            </li>
          ))}
        </ul>
      )}
      <Button variant="primary" icon="upload" type="submit" disabled={pending}>
        {pending ? t("uploading") : t("upload")}
      </Button>
    </form>
  );
}
