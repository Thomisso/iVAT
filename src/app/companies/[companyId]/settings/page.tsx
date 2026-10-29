import Link from "next/link";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import {
  epoIdentityFindings,
  getCompany,
  getMyCompanyRole,
} from "@/application/companies";
import { getCompanyAiProcessingAllowance } from "@/application/ai-processing-allowance";
import { getCompanyFilingDefaults } from "@/application/company-filing-defaults";
import { requireUserClient } from "@/lib/supabase/server";
import { CompanyForm } from "../../new/company-form";
import { CompanyDataExportForm } from "./company-data-export-form";
import { CompanyDeletionForm } from "./company-deletion-form";
import { FilingDefaultsForm } from "./filing-defaults-form";

export default async function CompanySettingsPage({
  params,
}: PageProps<"/companies/[companyId]/settings">) {
  const { companyId } = await params;
  const client = await requireUserClient();
  const [company, role, filingDefaults, t, ai] = await Promise.all([
    getCompany(client, companyId),
    getMyCompanyRole(client, companyId),
    getCompanyFilingDefaults(client, companyId),
    getTranslations("company"),
    getTranslations("aiProcessing"),
  ]);
  if (!company) notFound();
  const allowance = role === "administrator"
    ? await getCompanyAiProcessingAllowance(client, companyId)
    : null;
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
          {role === "administrator" && <section className="company-settings-section">
            <h2>{t("usersTitle")}</h2>
            <p>{t("usersIntro")}</p>
            <Link href={`/companies/${company.id}/members`}>{t("manageUsers")}</Link>
          </section>}
          {allowance?.ok && <section className="company-settings-section">
            <h2>{ai("title")}</h2>
            <p>{ai("allowanceUsage", {
              used: allowance.value.used,
              allowance: allowance.value.allowance ?? ai("unlimited"),
            })}</p>
            <p className="iv-muted">{ai("waitingDocuments", { count: allowance.value.waitingDocuments })}</p>
          </section>}
          {role === "administrator" && (
            <>
              <CompanyDataExportForm companyId={company.id} />
              <CompanyDeletionForm companyId={company.id} />
            </>
          )}
        </div>
      </main>
  );
}
