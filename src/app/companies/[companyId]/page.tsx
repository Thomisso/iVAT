import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { getCompany } from "@/application/companies";
import { requireUserClient } from "@/lib/supabase/server";

export default async function CompanyOverviewPage({ params }: PageProps<"/companies/[companyId]">) {
  const { companyId } = await params;
  const [company, t] = await Promise.all([
    getCompany(await requireUserClient(), companyId),
    getTranslations("shell"),
  ]);
  if (!company) notFound();
  return <main className="company-workspace">
    <header className="company-page-header"><h1>{t("overviewTitle")}</h1><p>{t("overviewDescription", { company: company.name })}</p></header>
    <section className="company-workspace-empty"><span aria-hidden="true" /><p>{t("workspaceComing")}</p></section>
  </main>;
}
