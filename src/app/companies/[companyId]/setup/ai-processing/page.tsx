import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import {
  getCompany,
  getMyCompanyRole,
} from "@/application/companies";
import { PageLayout } from "@/components/app-shell";
import { requireUserClient } from "@/lib/supabase/server";

export default async function AiProcessingSetupPage({
  params,
}: PageProps<"/companies/[companyId]/setup/ai-processing">) {
  const { companyId } = await params;
  const client = await requireUserClient();
  const [company, role, t] = await Promise.all([
    getCompany(client, companyId),
    getMyCompanyRole(client, companyId),
    getTranslations("aiProcessing"),
  ]);
  if (!company || role !== "administrator") notFound();
  return <PageLayout className="company-workspace" measure="narrow">
    <header className="company-page-header">
      <h1>{t("setupTitle")}</h1>
      <p>{t("setupIntro")}</p>
    </header>
    <section className="panel company-setup-panel">
      <p>{t("platformManaged")}</p>
    </section>
  </PageLayout>;
}
