"use client";

import { useState, type FormEvent } from "react";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { Button } from "@/components/button";
import { Notice } from "@/components/notice";
import { COMPANY_EXPORT_POLL_TIMEOUT_MS } from "@/lib/processing-policy";

type TerminalExportStatus = "failed" | "stale";

const EXPORT_POLL_INTERVAL_MS = 500;

function downloadName(disposition: string | null): string {
  return disposition?.match(/filename="([^"]+)"/)?.[1] ?? "iVAT-company-export.zip";
}

async function waitForCompletedExport(
  companyId: string,
  exportId: string,
): Promise<"completed" | TerminalExportStatus> {
  const deadline = Date.now() + COMPANY_EXPORT_POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const response = await fetch(
      `/companies/${encodeURIComponent(companyId)}/exports/${encodeURIComponent(exportId)}`,
      { cache: "no-store" },
    );
    if (!response.ok) throw new Error("Company export status failed");
    const status = await response.json() as "pending" | "completed" | TerminalExportStatus;
    if (status !== "pending") return status;
    await new Promise((resolve) => setTimeout(resolve, EXPORT_POLL_INTERVAL_MS));
  }
  throw new Error("Company export completion timed out");
}

export function CompanyDeletionForm({ companyId }: { companyId: string }) {
  const t = useTranslations("company");
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<"technical" | TerminalExportStatus | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!window.confirm(t("deleteConfirm"))) return;
    setPending(true);
    setFailure(null);
    try {
      const response = await fetch(`/companies/${companyId}/export`, {
        method: "POST",
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
      const status = await waitForCompletedExport(companyId, exportId);
      if (status !== "completed") {
        setFailure(status);
        setPending(false);
        return;
      }
      const deleted = await fetch(`/companies/${companyId}/delete`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ exportId }),
      });
      if (!deleted.ok) throw new Error("Company deletion failed");
      router.replace("/");
    } catch {
      setFailure("technical");
      setPending(false);
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
