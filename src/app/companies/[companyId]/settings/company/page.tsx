import { notFound, redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { getCompany, getMyCompanyRole } from "@/application/companies";
import { requireUserClient } from "@/lib/supabase/server";
import { CompanyForm } from "../../../new/company-form";

export default async function CompanyDetailsSettingsPage({ params }: { params: Promise<{ companyId: string }> }) {
  const { companyId } = await params;
  const client = await requireUserClient();
  const [company, role, t] = await Promise.all([
    getCompany(client, companyId),
    getMyCompanyRole(client, companyId),
    getTranslations("company"),
  ]);
  if (!company) notFound();
  if (role !== "administrator") redirect(`/companies/${company.id}/settings`);

  return <section className="company-settings-section">
    <header><h2>{t("companyDetails")}</h2><p>{t("profileIntro")}</p></header>
    <CompanyForm
      layout="settings"
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
  </section>;
}
