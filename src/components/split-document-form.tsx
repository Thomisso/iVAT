"use client";

import { useActionState } from "react";
import { useTranslations } from "next-intl";
import { splitDocumentAction, type FormState } from "@/app/actions";
import { Button } from "./button";
import { FormError } from "./form-error";

export function SplitDocumentForm({
  companyId,
  documentId,
  firstPage,
  lastPage,
}: {
  companyId: string;
  documentId: string;
  firstPage: number;
  lastPage: number;
}) {
  const t = useTranslations("documents");
  const [state, action, pending] = useActionState<FormState, FormData>(splitDocumentAction, {
    error: null,
    values: {},
  });
  return (
    <form action={action} className="split-correction-form">
      <input type="hidden" name="companyId" value={companyId} />
      <input type="hidden" name="documentId" value={documentId} />
      <label>
        <span>{t("splitAfter")}</span>
        <select
          className="iv-input"
          name="splitAfterPage"
          defaultValue={state.values.splitAfterPage ?? String(firstPage)}
        >
          {Array.from({ length: lastPage - firstPage }, (_, index) => firstPage + index).map((page) => (
            <option key={page} value={page}>
              {page}
            </option>
          ))}
        </select>
      </label>
      <Button type="submit" size="sm" disabled={pending}>
        {t("split")}
      </Button>
      <FormError error={state.error} />
    </form>
  );
}
