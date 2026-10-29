"use client";

import { useState, type FormEvent } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/button";
import { Notice } from "@/components/notice";

function downloadName(disposition: string | null): string {
  return disposition?.match(/filename="([^"]+)"/)?.[1] ?? "iVAT-company-export.zip";
}

export function CompanyDataExportForm({ companyId }: { companyId: string }) {
  const t = useTranslations("company");
  const [status, setStatus] = useState<"idle" | "pending" | "downloaded" | "failed">("idle");

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setStatus("pending");
    try {
      const response = await fetch(`/companies/${encodeURIComponent(companyId)}/export`, {
        method: "POST",
      });
      if (!response.ok) throw new Error("Company data export failed");
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = downloadName(response.headers.get("Content-Disposition"));
      anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 0);
      setStatus("downloaded");
    } catch {
      setStatus("failed");
    }
  }

  return (
    <section className="company-settings-section">
      <h2>{t("dataExportTitle")}</h2>
      <p>{t("dataExportIntro")}</p>
      <form method="post" action={`/companies/${companyId}/export`} onSubmit={submit}>
        <Button type="submit" disabled={status === "pending"}>
          {t(status === "pending" ? "dataExportPreparing" : "dataExportButton")}
        </Button>
      </form>
      {status === "downloaded" && <Notice tone="success">{t("dataExportDownloaded")}</Notice>}
      {status === "failed" && <Notice tone="danger">{t("dataExportFailed")}</Notice>}
    </section>
  );
}
