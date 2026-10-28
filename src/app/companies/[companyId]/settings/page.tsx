import Link from "next/link";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import {
  getCompany,
  getMyCompanyRole,
  listCompanyFilingFrequencies,
} from "@/application/companies";
import { AppSidebar } from "@/components/app-sidebar";
import { requireUserClient } from "@/lib/supabase/server";
import { CompanyForm } from "../../new/company-form";
import { CompanyDeletionForm } from "./company-deletion-form";

export default async function CompanySettingsPage({
  params,
}: PageProps<"/companies/[companyId]/settings">) {
  const { companyId } = await params;
  const client = await requireUserClient();
  const [company, history, role, t] = await Promise.all([
    getCompany(client, companyId),
    listCompanyFilingFrequencies(client, companyId),
    getMyCompanyRole(client, companyId),
    getTranslations("company"),
  ]);
  if (!company) notFound();
  const current = history.at(-1);
  return (
    <>
      <AppSidebar currentCompanyId={company.id} />
      <main className="company-create">
        <div className="panel">
          <Link href={`/companies/${company.id}`}>{t("backToCompany")}</Link>
          <h1>{t("settingsTitle")}</h1>
          <p>{t("settingsIntro")}</p>
          <CompanyForm
            organizationId={company.organizationId}
            companyId={company.id}
            initialValues={{
              name: company.name,
              ico: company.ico,
              vatId: company.vatId,
              street: company.street,
              city: company.city,
              postalCode: company.postalCode,
              personType: company.personType,
              filingFrequency: current?.frequency ?? "monthly",
              filingFrequencyEffectiveFrom:
                current?.effectiveFrom ??
                new Intl.DateTimeFormat("sv-SE", {
                  timeZone: "Europe/Prague",
                }).format(new Date()),
            }}
          />
          {role === "administrator" && (
            <CompanyDeletionForm companyId={company.id} />
          )}
        </div>
      </main>
    </>
  );
}
