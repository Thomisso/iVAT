"use client";

import { useState, type FormEvent } from "react";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { Button } from "@/components/button";
import { Notice } from "@/components/notice";

function downloadName(disposition: string | null): string {
  return disposition?.match(/filename="([^"]+)"/)?.[1] ?? "iVAT-company-export.zip";
}

export function CompanyDeletionForm({ companyId }: { companyId: string }) {
  const t = useTranslations("company");
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!window.confirm(t("deleteConfirm"))) return;
    setPending(true);
    setFailed(false);
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
      const deleted = await fetch(`/companies/${companyId}/delete`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ exportId }),
      });
      if (!deleted.ok) throw new Error("Company deletion failed");
      router.replace("/");
    } catch {
      setFailed(true);
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
      {failed && <Notice tone="danger">{t("deleteFailed")}</Notice>}
    </section>
  );
}
