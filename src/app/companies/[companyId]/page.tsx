import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import Link from "next/link";
import { getCompany } from "@/application/companies";
import { requireUserClient } from "@/lib/supabase/server";
import { PageLayout } from "@/components/app-shell";

export default async function CompanyOverviewPage({ params }: PageProps<"/companies/[companyId]">) {
  const { companyId } = await params;
  const client = await requireUserClient();
  const [company, t] = await Promise.all([
    getCompany(client, companyId),
    getTranslations("shell"),
  ]);
  if (!company) notFound();
  return <PageLayout className="company-workspace" measure="wide">
    <header className="company-page-header"><h1>{t("overviewTitle")}</h1><p>{t("overviewDescription", { company: company.name })}</p></header>
    <section aria-labelledby="overview-work-title" className="company-overview-work">
      <header><h2 id="overview-work-title">{t("overviewWorkTitle")}</h2><p>{t("overviewWorkIntro")}</p></header>
      <div>
        {[
          ["upload", t("uploadTitle"), t("uploadDescription")],
          ["documents", t("documentsTitle"), t("documentsDescription")],
          ["vat", t("vatTitle"), t("vatDescription")],
        ].map(([path, title, description]) => <Link href={`/companies/${companyId}/${path}`} key={path}>
          <strong>{title}</strong><span>{description}</span>
        </Link>)}
      </div>
    </section>
  </PageLayout>;
}
