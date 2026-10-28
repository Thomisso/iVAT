import Link from "next/link";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import {
  getCompany,
  getMyCompanyRole,
} from "@/application/companies";
import { requireUserClient } from "@/lib/supabase/server";
import { CompanyForm } from "../../new/company-form";
import { CompanyDeletionForm } from "./company-deletion-form";

export default async function CompanySettingsPage({
  params,
}: PageProps<"/companies/[companyId]/settings">) {
  const { companyId } = await params;
  const client = await requireUserClient();
  const [company, role, t] = await Promise.all([
    getCompany(client, companyId),
    getMyCompanyRole(client, companyId),
    getTranslations("company"),
  ]);
  if (!company) notFound();
  return (
      <main className="company-workspace company-create">
        <div className="panel">
          <Link href={`/companies/${company.id}`}>{t("backToCompany")}</Link>
          <h1>{t("settingsTitle")}</h1>
          <p>{t("settingsIntro")}</p>
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
          {role === "administrator" && (
            <CompanyDeletionForm companyId={company.id} />
          )}
        </div>
      </main>
  );
}
