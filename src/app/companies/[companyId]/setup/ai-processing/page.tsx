import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import {
  getCompany,
  getMyCompanyRole,
  listCompanyAiOptions,
} from "@/application/companies";
import { requireUserClient } from "@/lib/supabase/server";
import { AiProviderForm, DisableAiProcessingForm } from "../../ai-provider-form";
import { PageLayout } from "@/components/app-shell";

export default async function AiProcessingSetupPage({
  params,
}: PageProps<"/companies/[companyId]/setup/ai-processing">) {
  const { companyId } = await params;
  const client = await requireUserClient();
  const [company, role, options, t] = await Promise.all([
    getCompany(client, companyId),
    getMyCompanyRole(client, companyId),
    listCompanyAiOptions(client, companyId),
    getTranslations("aiProcessing"),
  ]);
  if (!company || role !== "administrator") notFound();
  return <PageLayout className="company-workspace" measure="narrow">
    <header className="company-page-header">
      <h1>{t("setupTitle")}</h1>
      <p>{t("setupIntro")}</p>
    </header>
    <section className="panel company-setup-panel">
      <AiProviderForm companyId={companyId} options={options} current={company.aiProcessing} setup />
      <DisableAiProcessingForm companyId={companyId} setup />
    </section>
  </PageLayout>;
}
