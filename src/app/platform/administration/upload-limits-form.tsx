"use client";

import { useActionState } from "react";
import { useTranslations } from "next-intl";
import { setPlatformUploadLimitsAction, type FormState } from "@/app/actions";
import type { PlatformUploadLimits } from "@/application/platform-administration";
import { Button } from "@/components/button";
import { FormError } from "@/components/form-error";
import { TextField } from "@/components/text-field";

export function UploadLimitsForm({ limits }: { limits: PlatformUploadLimits }) {
  const [state, action, pending] = useActionState<FormState, FormData>(setPlatformUploadLimitsAction, {
    error: null,
    values: {},
  });
  const t = useTranslations("platformAdministration");
  return (
    <form action={action} className="form">
      <TextField
        name="maxFileBytes"
        type="number"
        min="1"
        step="1"
        required
        label={t("maxFileBytes")}
        defaultValue={state.values.maxFileBytes ?? limits.maxFileBytes}
      />
      <TextField
        name="maxFilePages"
        type="number"
        min="1"
        step="1"
        required
        label={t("maxFilePages")}
        defaultValue={state.values.maxFilePages ?? limits.maxFilePages}
      />
      <TextField
        name="maxBatchFiles"
        type="number"
        min="1"
        step="1"
        required
        label={t("maxBatchFiles")}
        defaultValue={state.values.maxBatchFiles ?? limits.maxBatchFiles}
      />
      <FormError error={state.error} />
      <Button type="submit" variant="primary" disabled={pending}>{t("saveLimits")}</Button>
    </form>
  );
}
