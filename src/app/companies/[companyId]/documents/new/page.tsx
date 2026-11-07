import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { getCompany, listCompanyReportingYears } from "@/application/companies";
import { reportingPeriodsOf } from "@/application/reporting-periods";
import { emptyDocumentPayload } from "@/application/extraction-payload";
import { PageLayout } from "@/components/app-shell";
import { CompanyReturnLink } from "@/components/company-return-link";
import { requireUserClient } from "@/lib/supabase/server";
import { CorrectionForm } from "../[documentId]/correction-form";

export default async function NewManualDocumentPage({ params }: PageProps<"/companies/[companyId]/documents/new">) {
  const { companyId } = await params;
  const client = await requireUserClient();
  const [company, t, years] = await Promise.all([getCompany(client, companyId), getTranslations("review"), listCompanyReportingYears(client, companyId)]);
  if (!company) notFound();
  return <PageLayout className="review manual-document-create" measure="wide">
    <header className="review-header">
      <CompanyReturnLink companyId={companyId} fallback={`/companies/${companyId}/documents`} />
      <h1>{t("createManual")}</h1>
      <p>{t("manualDraftHint")}</p>
    </header>
    <section className="review-data">
      <CorrectionForm companyId={companyId} version={0} payload={emptyDocumentPayload()} findings={[]} editable claimPeriods={reportingPeriodsOf(years)} />
    </section>
  </PageLayout>;
}
