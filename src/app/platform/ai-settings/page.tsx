import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import {
  setDefaultAiConfigurationAction,
  setOrganizationPlatformAiAccessAction,
} from "@/app/actions";
import { listAiConfigurations } from "@/application/ai-configurations";
import { listPlatformAiProcessingAllowances } from "@/application/ai-processing-allowance";
import { listPlatformOrganizationCompanies } from "@/application/platform-administration";
import {
  listPlatformAiProviders,
  listPlatformOrganizations,
} from "@/application/platform-ai";
import { CommandButton } from "@/components/command-button";
import { requireUserClient } from "@/lib/supabase/server";
import { PlatformAiProviderForm } from "./platform-ai-provider-form";
import { AiConfigurationForm } from "./ai-configuration-form";
import { AiConfigurationAssignmentForm } from "./ai-configuration-assignment-form";
import { AiProcessingAllowanceForm } from "./ai-processing-allowance-form";

export default async function PlatformAiSettingsPage() {
  const client = await requireUserClient();
  const [settings, configurations, organizationCompanies, allowances] = await Promise.all([
    listPlatformAiProviders(client),
    listAiConfigurations(client),
    listPlatformOrganizationCompanies(client),
    listPlatformAiProcessingAllowances(client),
  ]);
  if (!settings.ok || !configurations.ok || !organizationCompanies.ok || !allowances.ok) notFound();
  const t = await getTranslations("platformAi");
  const providerNames = settings.value.map(({ provider }) => provider);
  const companies = organizationCompanies.value.flatMap((organization) =>
    organization.companies.map((company) => ({ ...company, organizationName: organization.name })),
  );
  const companyNames = new Map(companies.map((company) => [company.id, company.name]));
  const allowanceByCompany = new Map(allowances.value.map((allowance) => [allowance.companyId, allowance]));
  const providers = await Promise.all(settings.value.map(async (provider) => ({
    provider,
    organizations: await listPlatformOrganizations(client, provider.provider),
  })));

  return (
    <>
      <main className="dashboard platform-page">
        <header>
          <h1>{t("title")}</h1>
          <p className="iv-muted">{t("intro")}</p>
        </header>
        <section className="panel platform-provider">
          <h2>{t("configurations")}</h2>
          <p className="iv-muted">{t("configurationsIntro")}</p>
          <AiConfigurationForm providers={providerNames} />
          <div className="ai-configurations">
            {configurations.value.map((configuration) => (
              <article key={configuration.id} className="panel ai-configuration">
                <header className="ai-configuration-summary">
                  <div>
                    <h3>{configuration.label}</h3>
                    <p className="iv-muted">
                      {configuration.provider} · {t("credentialSuffix", { lastFour: configuration.credentialLastFour })}
                    </p>
                  </div>
                  {configuration.isDefault ? (
                    <span>{t("defaultConfiguration")}</span>
                  ) : (
                    <CommandButton
                      action={setDefaultAiConfigurationAction}
                      fields={{ configurationId: configuration.id }}
                      size="sm"
                    >
                      {t("makeDefault")}
                    </CommandButton>
                  )}
                </header>
                <p className="iv-muted">
                  {t("assignedCompanies", { count: configuration.assignedCompanyIds.length })}
                  {configuration.assignedCompanyIds.length > 0
                    ? `: ${configuration.assignedCompanyIds.map((id) => companyNames.get(id) ?? id).join(", ")}`
                    : ""}
                </p>
                <details>
                  <summary>{t("updateConfiguration")}</summary>
                  <AiConfigurationForm providers={providerNames} configuration={configuration} />
                </details>
              </article>
            ))}
          </div>
          {configurations.value.length > 0 && (
            <div className="platform-organizations">
              <h3>{t("companyAssignments")}</h3>
              {companies.map((company) => (
                <div key={company.id} className="platform-organization">
                  <div>
                    <strong>{company.organizationName} · {company.name}</strong>
                    {allowanceByCompany.get(company.id) && <p className="iv-muted">
                      {t("allowanceUsage", {
                        used: allowanceByCompany.get(company.id)!.used,
                        allowance: allowanceByCompany.get(company.id)!.allowance ?? t("unlimited"),
                        waiting: allowanceByCompany.get(company.id)!.waitingDocuments,
                      })}
                    </p>}
                  </div>
                  <AiConfigurationAssignmentForm
                    companyId={company.id}
                    configurations={configurations.value}
                  />
                  <AiProcessingAllowanceForm
                    companyId={company.id}
                    allowance={allowanceByCompany.has(company.id)
                      ? allowanceByCompany.get(company.id)!.allowance
                      : 50}
                  />
                </div>
              ))}
            </div>
          )}
        </section>
        <h2>{t("legacyProviderSettings")}</h2>
        {providers.map(({ provider, organizations }) => (
          <section key={provider.provider} className="panel platform-provider">
            <h2>{provider.provider}</h2>
            <PlatformAiProviderForm settings={provider} />
            <h3>{t("organizationAccess")}</h3>
            {organizations.ok && (
              <div className="platform-organizations">
                {organizations.value.map((organization) => (
                  <div key={organization.id} className="platform-organization">
                    <span>{organization.name}</span>
                    <CommandButton
                      action={setOrganizationPlatformAiAccessAction}
                      fields={{
                        organizationId: organization.id,
                        provider: provider.provider,
                        enabled: String(!organization.platformKeyEnabled),
                      }}
                      variant={organization.platformKeyEnabled ? "danger" : "secondary"}
                      size="sm"
                    >
                      {organization.platformKeyEnabled ? t("disableForOrganization") : t("enableForOrganization")}
                    </CommandButton>
                  </div>
                ))}
              </div>
            )}
          </section>
        ))}
      </main>
    </>
  );
}
