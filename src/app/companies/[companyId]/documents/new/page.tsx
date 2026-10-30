import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { getCompany } from "@/application/companies";
import { emptyDocumentPayload } from "@/application/extraction-payload";
import { PageLayout } from "@/components/app-shell";
import { CompanyReturnLink } from "@/components/company-return-link";
import { requireUserClient } from "@/lib/supabase/server";
import { CorrectionForm } from "../[documentId]/correction-form";

export default async function NewManualDocumentPage({ params }: PageProps<"/companies/[companyId]/documents/new">) {
  const { companyId } = await params;
  const client = await requireUserClient();
  const [company, t] = await Promise.all([getCompany(client, companyId), getTranslations("review")]);
  if (!company) notFound();
  return <PageLayout className="review manual-document-create" measure="wide">
    <header className="review-header">
      <CompanyReturnLink companyId={companyId} fallback={`/companies/${companyId}/documents`} />
      <h1>{t("createManual")}</h1>
      <p>{t("manualDraftHint")}</p>
    </header>
    <section className="review-data">
      <CorrectionForm companyId={companyId} version={0} payload={emptyDocumentPayload()} findings={[]} editable />
    </section>
  </PageLayout>;
}
