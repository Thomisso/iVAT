"use client";

import { useActionState } from "react";
import { useTranslations } from "next-intl";
import { deleteUploadBatchAction } from "@/app/actions";
import type { UploadBatchDeletionPreview } from "@/application/upload-batches";
import { Button } from "@/components/button";
import { FormError } from "@/components/form-error";
import { Notice } from "@/components/notice";

/** Confirms an all-or-nothing Upload Batch deletion with the counts it removes. */
export function BatchDeletionForm({
  companyId,
  preview,
}: {
  companyId: string;
  preview: UploadBatchDeletionPreview;
}) {
  const t = useTranslations("uploadWorkspace");
  const [state, action, pending] = useActionState(deleteUploadBatchAction, { error: null, values: {} });
  return <section className="panel upload-batch-deletion" aria-labelledby="batch-deletion-title">
    <h2 id="batch-deletion-title">{t("deleteTitle")}</h2>
    <p>{t("deleteHint")}</p>
    <dl className="finalization-summary">
      <div><dt>{t("deleteSourceFiles")}</dt><dd>{preview.sourceFileCount}</dd></div>
      <div><dt>{t("deleteDocuments")}</dt><dd>{preview.documentCount}</dd></div>
      <div><dt>{t("deleteApprovedDocuments")}</dt><dd>{preview.approvedDocumentCount}</dd></div>
    </dl>
    {preview.refusal ? <Notice tone="warning">{t(`deleteRefused.${preview.refusal}`)}</Notice> : <form action={action} className="form">
      <input type="hidden" name="companyId" value={companyId} />
      <input type="hidden" name="batchId" value={preview.batchId} />
      <label className="period-lock-confirmation">
        <input type="checkbox" name="confirmed" required defaultChecked={state.values.confirmed === "on"} />
        <span>{t("deleteConfirmation")}</span>
      </label>
      <Button type="submit" variant="danger" disabled={pending}>{t("deleteAction")}</Button>
      <FormError error={state.error} />
    </form>}
  </section>;
}
