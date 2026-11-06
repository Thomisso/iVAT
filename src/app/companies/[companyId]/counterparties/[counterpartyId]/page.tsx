import Link from "next/link";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { getCounterparty } from "@/application/counterparties";
import { PageContent, PageHeader, PageLayout } from "@/components/app-shell";
import { requireUserClient } from "@/lib/supabase/server";
import { CounterpartyForm } from "../counterparty-form";

export default async function CounterpartyPage({ params, searchParams }: {
  params: Promise<{ companyId: string; counterpartyId: string }>;
  searchParams: Promise<{ saved?: string }>;
}) {
  const { companyId, counterpartyId } = await params;
  const client = await requireUserClient();
  const entry = await getCounterparty(client, companyId, counterpartyId);
  if (!entry) notFound();
  const t = await getTranslations("counterparties");
  const search = await searchParams;
  return <PageLayout measure="narrow">
    <PageHeader title={entry.name}><Link href={`/companies/${companyId}/counterparties`}>{t("back")}</Link></PageHeader>
    <PageContent measure="narrow">
      {search.saved === "1" && <p role="status">{t("saved")}</p>}
      {entry.archivedAt && <p>{t("archived")}</p>}
      <CounterpartyForm companyId={companyId} entry={entry} />
    </PageContent>
  </PageLayout>;
}
