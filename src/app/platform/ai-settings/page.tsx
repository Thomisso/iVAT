import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { setDefaultAiConfigurationAction } from "@/app/actions";
import { listAiConfigurationProviders, listAiConfigurations } from "@/application/ai-configurations";
import { listPlatformAiProcessingAllowances } from "@/application/ai-processing-allowance";
import { listPlatformOrganizationCompanies } from "@/application/platform-administration";
import { CommandButton } from "@/components/command-button";
import { requireUserClient } from "@/lib/supabase/server";
import { AiConfigurationForm } from "./ai-configuration-form";
import { AiConfigurationAssignmentForm } from "./ai-configuration-assignment-form";
import { AiProcessingAllowanceForm } from "./ai-processing-allowance-form";

export default async function PlatformAiSettingsPage() {
  const client = await requireUserClient();
  const [providers, configurations, organizationCompanies, allowances] = await Promise.all([
    listAiConfigurationProviders(client),
    listAiConfigurations(client),
    listPlatformOrganizationCompanies(client),
    listPlatformAiProcessingAllowances(client),
  ]);
  if (!providers.ok || !configurations.ok || !organizationCompanies.ok || !allowances.ok) notFound();
  const t = await getTranslations("platformAi");
  const companies = organizationCompanies.value.flatMap((organization) =>
    organization.companies.map((company) => ({ ...company, organizationName: organization.name })),
  );
  const companyNames = new Map(companies.map((company) => [company.id, company.name]));
  const allowanceByCompany = new Map(allowances.value.map((allowance) => [allowance.companyId, allowance]));

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
          <AiConfigurationForm providers={providers.value} />
          <div className="ai-configurations">
            {configurations.value.map((configuration) => (
              <article
                key={configuration.id}
                id={`configuration-${configuration.id}`}
                className="panel ai-configuration"
              >
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
                  <AiConfigurationForm providers={providers.value} configuration={configuration} />
                </details>
              </article>
            ))}
          </div>
          {configurations.value.length > 0 && (
            <div className="platform-organizations">
              <h3>{t("companyAssignments")}</h3>
              {companies.map((company) => (
                <div key={company.id} id={`company-${company.id}`} className="platform-organization">
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
      </main>
    </>
  );
}
