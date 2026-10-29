"use client";

import { useActionState } from "react";
import { useTranslations } from "next-intl";
import { assignCompanyAiConfigurationAction, type FormState } from "@/app/actions";
import type { AiConfigurationSummary } from "@/application/ai-configurations";
import { Button } from "@/components/button";
import { FormError } from "@/components/form-error";

export function AiConfigurationAssignmentForm({
  companyId,
  configurations,
}: {
  companyId: string;
  configurations: AiConfigurationSummary[];
}) {
  const [state, action, pending] = useActionState<FormState, FormData>(assignCompanyAiConfigurationAction, {
    error: null,
    values: {},
  });
  const t = useTranslations("platformAi");
  const assigned = configurations.find((configuration) => configuration.assignedCompanyIds.includes(companyId));

  return (
    <form action={action} className="ai-configuration-assignment-actions">
      <input type="hidden" name="companyId" value={companyId} />
      <select
        name="configurationId"
        className="iv-input"
        defaultValue={state.values.configurationId ?? assigned?.id ?? configurations[0]?.id}
        aria-label={t("configuration")}
      >
        {configurations.map((configuration) => (
          <option key={configuration.id} value={configuration.id}>{configuration.label}</option>
        ))}
      </select>
      <Button type="submit" size="sm" disabled={pending}>{t("assignConfiguration")}</Button>
      <FormError error={state.error} />
    </form>
  );
}
