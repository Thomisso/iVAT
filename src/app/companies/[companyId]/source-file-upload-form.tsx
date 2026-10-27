"use client";

import { useActionState } from "react";
import { useTranslations } from "next-intl";
import { uploadSourceFileAction } from "@/app/actions";
import { FormError } from "@/components/form-error";

export function SourceFileUploadForm({ companyId }: { companyId: string }) {
  const t = useTranslations("sourceFiles");
  const [state, action, pending] = useActionState(uploadSourceFileAction, { error: null, values: {} });
  return (
    <form action={action} className="form upload-form">
      <input type="hidden" name="companyId" value={companyId} />
      <label>
        {t("file")}
        <input type="file" name="file" accept=".pdf,.png,.jpg,.jpeg" required />
        <small>{t("fileHint")}</small>
      </label>
      <FormError error={state.error} />
      <button type="submit" disabled={pending}>
        {t("upload")}
      </button>
    </form>
  );
}
