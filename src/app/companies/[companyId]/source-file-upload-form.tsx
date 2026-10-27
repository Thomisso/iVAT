"use client";

import { useActionState } from "react";
import { useTranslations } from "next-intl";
import { uploadSourceFileAction } from "@/app/actions";
import { FormError } from "@/components/form-error";
import { DropZone } from "@/components/drop-zone";
import { Button } from "@/components/button";

export function SourceFileUploadForm({ companyId }: { companyId: string }) {
  const t = useTranslations("sourceFiles");
  const [state, action, pending] = useActionState(uploadSourceFileAction, {
    error: null,
    values: {},
  });
  return (
    <form action={action} className="form upload-form">
      <input type="hidden" name="companyId" value={companyId} />
      <DropZone required disabled={pending} />
      <FormError error={state.error} />
      <Button variant="primary" icon="upload" type="submit" disabled={pending}>
        {t("upload")}
      </Button>
    </form>
  );
}
