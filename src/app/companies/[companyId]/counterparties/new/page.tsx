import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { PageContent, PageHeader, PageLayout } from "@/components/app-shell";
import { CounterpartyForm } from "../counterparty-form";

export default async function NewCounterpartyPage({ params }: { params: Promise<{ companyId: string }> }) {
  const { companyId } = await params;
  const t = await getTranslations("counterparties");
  return <PageLayout measure="narrow">
    <PageHeader title={t("create")}><Link href={`/companies/${companyId}/counterparties`}>{t("back")}</Link></PageHeader>
    <PageContent measure="narrow"><CounterpartyForm companyId={companyId} /></PageContent>
  </PageLayout>;
}
