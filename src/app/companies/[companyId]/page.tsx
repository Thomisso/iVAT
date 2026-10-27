import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { getCompany } from "@/application/companies";
import { AppHeader } from "@/components/app-header";
import { requireUserClient } from "@/lib/supabase/server";

export default async function CompanyDashboardPage({ params }: PageProps<"/companies/[companyId]">) {
  const { companyId } = await params;
  const client = await requireUserClient();
  const company = await getCompany(client, companyId);
  if (!company) notFound();
  const t = await getTranslations();

  return (
    <>
      <AppHeader currentCompanyId={company.id} />
      <main className="dashboard">
        <header>
          <h1>{company.name}</h1>
          <p className="muted">
            {t("company.ico")} {company.ico} · {t("company.vatId")} {company.vatId} · {company.street},{" "}
            {company.postalCode} {company.city}
          </p>
        </header>
        <section>
          <h2>{t("dashboard.documents")}</h2>
          <p className="empty">{t("dashboard.noDocuments")}</p>
        </section>
      </main>
    </>
  );
}
