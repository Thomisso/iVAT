"use client";

import { useActionState } from "react";
import { useTranslations } from "next-intl";
import { enableAiProcessingAction, type FormState } from "@/app/actions";
import type { AiProviderChoice } from "@/ai";
import { Button } from "@/components/button";
import { FormError } from "@/components/form-error";

export function AiProviderForm({
  companyId,
  providers,
  currentProvider,
}: {
  companyId: string;
  providers: AiProviderChoice[];
  currentProvider: string | null;
}) {
  const [state, action, pending] = useActionState<FormState, FormData>(enableAiProcessingAction, {
    error: null,
    values: {},
  });
  const t = useTranslations("aiProcessing");
  const selected = state.values.provider ?? currentProvider ?? providers[0]?.name ?? "";

  if (providers.length === 0) return <p className="iv-muted">{t("noneAvailable")}</p>;
  return (
    <form action={action} className="form">
      <input type="hidden" name="companyId" value={companyId} />
      <label className="iv-field-label">
        {t("provider")}
        <select name="provider" defaultValue={selected}>
          {providers.map((provider) => (
            <option key={provider.name} value={provider.name}>
              {provider.name} · {provider.region}
            </option>
          ))}
        </select>
      </label>
      <FormError error={state.error} />
      <Button type="submit" variant="ai" icon="marker" disabled={pending}>
        {currentProvider ? t("change") : t("enable")}
      </Button>
    </form>
  );
}
