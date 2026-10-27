"use client";

import { useActionState } from "react";
import { useTranslations } from "next-intl";
import { configurePlatformAiProviderAction, type FormState } from "@/app/actions";
import type { PlatformAiProviderSettings } from "@/application/platform-ai";
import { Button } from "@/components/button";
import { FormError } from "@/components/form-error";
import { TextField } from "@/components/text-field";

export function PlatformAiProviderForm({ settings }: { settings: PlatformAiProviderSettings }) {
  const [state, action, pending] = useActionState<FormState, FormData>(configurePlatformAiProviderAction, {
    error: null,
    values: {},
  });
  const t = useTranslations("platformAi");
  return (
    <form action={action} className="form">
      <input type="hidden" name="provider" value={settings.provider} />
      <label className="iv-checkbox">
        <input
          type="checkbox"
          name="available"
          defaultChecked={(state.values.available ?? (settings.available ? "on" : "")) === "on"}
        />
        {t("available")}
      </label>
      <TextField
        name="splitModel"
        label={t("splitModel")}
        defaultValue={state.values.splitModel ?? settings.splitModel}
        required
        mono
      />
      <TextField
        name="extractModel"
        label={t("extractModel")}
        defaultValue={state.values.extractModel ?? settings.extractModel}
        required
        mono
      />
      <TextField
        name="apiKey"
        type="password"
        label={t("platformKey")}
        hint={settings.hasPlatformKey ? t("keyStored", { lastFour: settings.platformKeyLastFour ?? "????" }) : t("keyMissing")}
        autoComplete="new-password"
      />
      <FormError error={state.error} />
      <Button type="submit" variant="primary" disabled={pending}>{t("save")}</Button>
    </form>
  );
}
