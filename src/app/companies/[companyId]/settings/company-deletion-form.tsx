"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { Button } from "@/components/button";
import { Notice } from "@/components/notice";
import {
  forgetPendingCompanyExport,
  pollCompanyExportStatus,
  readPendingCompanyExport,
  rememberPendingCompanyExport,
  type CompanyExportTerminalStatus,
} from "@/lib/company-export-polling";

function downloadName(disposition: string | null): string {
  return disposition?.match(/filename="([^"]+)"/)?.[1] ?? "iVAT-company-export.zip";
}

export function CompanyDeletionForm({ companyId }: { companyId: string }) {
  const t = useTranslations("company");
  const router = useRouter();
  const controllerRef = useRef<AbortController | null>(null);
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<"technical" | Exclude<CompanyExportTerminalStatus, "completed"> | null>(null);

  const continueExport = useCallback(async (exportId: string, signal: AbortSignal) => {
    try {
      const status = await pollCompanyExportStatus(async (pollSignal) => {
        const response = await fetch(
          `/companies/${encodeURIComponent(companyId)}/exports/${encodeURIComponent(exportId)}`,
          { cache: "no-store", signal: pollSignal },
        );
        if (!response.ok) throw new Error("Company export status failed");
        return response.json();
      }, { signal });
      signal.throwIfAborted();
      if (status !== "completed") {
        forgetPendingCompanyExport(sessionStorage, companyId);
        setFailure(status);
        setPending(false);
        return;
      }
      const deleted = await fetch(`/companies/${companyId}/delete`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ exportId }),
        signal,
      });
      if (!deleted.ok) throw new Error("Company deletion failed");
      forgetPendingCompanyExport(sessionStorage, companyId);
      router.replace("/");
    } catch {
      if (!signal.aborted) {
        setFailure("technical");
        setPending(false);
      }
    }
  }, [companyId, router]);

  useEffect(() => {
    const exportId = readPendingCompanyExport(sessionStorage, companyId);
    if (!exportId) return;
    const controller = new AbortController();
    controllerRef.current = controller;
    queueMicrotask(() => {
      if (controller.signal.aborted) return;
      setPending(true);
      setFailure(null);
      void continueExport(exportId, controller.signal);
    });
    return () => controller.abort();
  }, [companyId, continueExport]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!window.confirm(t("deleteConfirm"))) return;
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    setPending(true);
    setFailure(null);
    try {
      const response = await fetch(`/companies/${companyId}/export`, {
        method: "POST",
        signal: controller.signal,
      });
      if (!response.ok) throw new Error("Company export and deletion failed");
      const blob = await response.blob();
      const exportId = response.headers.get("X-Company-Export-Id");
      if (!exportId) throw new Error("Company export receipt missing");
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = downloadName(response.headers.get("Content-Disposition"));
      anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 0);
      rememberPendingCompanyExport(sessionStorage, companyId, exportId);
      await continueExport(exportId, controller.signal);
    } catch {
      if (!controller.signal.aborted) {
        setFailure("technical");
        setPending(false);
      }
    }
  }

  return (
    <section className="company-delete">
      <h2>{t("deleteTitle")}</h2>
      <p>{t("deleteIntro")}</p>
      <form method="post" action={`/companies/${companyId}/delete`} onSubmit={submit}>
        <Button type="submit" variant="danger" disabled={pending}>
          {t(pending ? "deletePreparing" : "deleteButton")}
        </Button>
      </form>
      {failure && (
        <Notice tone="danger">
          {t(failure === "stale" ? "deleteStale" : failure === "failed" ? "deleteWorkerFailed" : "deleteFailed")}
        </Notice>
      )}
    </section>
  );
}
