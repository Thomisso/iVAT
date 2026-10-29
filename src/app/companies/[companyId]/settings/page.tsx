import Link from "next/link";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import {
  epoIdentityFindings,
  getCompany,
  getMyCompanyRole,
  listCompanyAiOptions,
} from "@/application/companies";
import { getCompanyFilingDefaults } from "@/application/company-filing-defaults";
import { listMyOrganizations } from "@/application/organizations";
import { requireUserClient } from "@/lib/supabase/server";
import { CompanyForm } from "../../new/company-form";
import { CompanyDeletionForm } from "./company-deletion-form";
import { AiProviderForm, DisableAiProcessingForm } from "../ai-provider-form";
import { FilingDefaultsForm } from "./filing-defaults-form";

export default async function CompanySettingsPage({
  params,
}: PageProps<"/companies/[companyId]/settings">) {
  const { companyId } = await params;
  const client = await requireUserClient();
  const [company, role, organizations, filingDefaults, t, ai] = await Promise.all([
    getCompany(client, companyId),
    getMyCompanyRole(client, companyId),
    listMyOrganizations(client),
    getCompanyFilingDefaults(client, companyId),
    getTranslations("company"),
    getTranslations("aiProcessing"),
  ]);
  if (!company) notFound();
  const options = role === "administrator" ? await listCompanyAiOptions(client, companyId) : [];
  const organizationAdministrator = organizations.some((organization) =>
    organization.id === company.organizationId && organization.role === "administrator"
  );
  return (
      <main className="company-workspace company-create">
        <div className="panel">
          <Link href={`/companies/${company.id}`}>{t("backToCompany")}</Link>
          <h1>{t("settingsTitle")}</h1>
          <p>{t("settingsIntro")}</p>
          <section className="company-settings-section">
            <h2>{t("profileTitle")}</h2>
            <p>{t("profileIntro")}</p>
            <CompanyForm
              organizationId={company.organizationId}
              companyId={company.id}
              initialValues={{
                name: company.name,
                firstName: company.firstName ?? "",
                lastName: company.lastName ?? "",
                ico: company.ico,
                vatId: company.vatId,
                streetName: company.streetName ?? "",
                houseNumber: company.houseNumber ?? "",
                orientationNumber: company.orientationNumber ?? "",
                city: company.city,
                postalCode: company.postalCode,
                personType: company.personType,
              }}
            />
            <Link href={`/companies/${company.id}/setup/filing-frequency`}>{t("editFilingFrequency")}</Link>
          </section>
          <section className="company-settings-section" id="filing-defaults">
            <h2>{t("filingDefaultsTitle")}</h2>
            <p>{t("filingDefaultsIntro")}</p>
            {role === "administrator" ? <FilingDefaultsForm
              companyId={company.id}
              defaults={filingDefaults}
              personType={company.personType}
              epoOverrideRequired={epoIdentityFindings(company).length > 0}
            /> : <p className="iv-muted">{ai("administratorOnly")}</p>}
          </section>
          <section className="company-settings-section">
            <h2>{ai("title")}</h2>
            <p>{company.aiProcessing
              ? ai("on", { provider: company.aiProcessing.provider, region: company.aiProcessing.region })
              : ai("off")}</p>
            {company.aiProcessing && <p className="iv-muted">
              {ai(`source.${company.aiProcessing.credentialSource}`)}
            </p>}
            {role === "administrator" ? <>
              <p>{ai("consent")}</p>
              <AiProviderForm
                key={company.aiProcessing
                  ? `${company.aiProcessing.credentialSource}:${company.aiProcessing.provider}:${company.aiProcessing.region}`
                  : "off"}
                companyId={company.id}
                options={options}
                current={company.aiProcessing}
              />
              {company.aiProcessing && <DisableAiProcessingForm companyId={company.id} />}
              {organizationAdministrator && <Link href={`/organizations/${company.organizationId}/ai-settings`}>
                {ai("manageOrganizationKeys")}
              </Link>}
            </> : <p className="iv-muted">{ai("administratorOnly")}</p>}
          </section>
          {role === "administrator" && (
            <CompanyDeletionForm companyId={company.id} />
          )}
        </div>
      </main>
  );
}
