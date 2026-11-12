import Link from "next/link";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { getCounterparty, listCounterpartyDocuments } from "@/application/counterparties";
import { PageContent, PageHeader, PageLayout } from "@/components/app-shell";
import { requireUserClient } from "@/lib/supabase/server";
import { DeleteCounterpartyForm } from "../delete-counterparty-form";
import { CommandButton } from "@/components/command-button";
import { archiveCounterpartyAction, restoreCounterpartyAction } from "../actions";
import { CounterpartyForm } from "../counterparty-form";
import { TradeStatistics } from "./trade-statistics";
import type { CounterpartyStatisticsFilters } from "@/application/counterparty-statistics";

export default async function CounterpartyPage({ params, searchParams }: {
  params: Promise<{ companyId: string; counterpartyId: string }>;
  searchParams: Promise<{ saved?: string; documentsPage?: string } & CounterpartyStatisticsFilters>;
}) {
  const { companyId, counterpartyId } = await params;
  const client = await requireUserClient();
  const entry = await getCounterparty(client, companyId, counterpartyId);
  if (!entry) notFound();
  const t = await getTranslations("counterparties");
  const search = await searchParams;
  const documents = await listCounterpartyDocuments(client, companyId, counterpartyId, Number(search.documentsPage ?? 1));
  return <PageLayout measure="narrow">
    <PageHeader title={entry.name}><Link href={`/companies/${companyId}/counterparties`}>{t("back")}</Link></PageHeader>
    <PageContent measure="narrow">
      {search.saved === "1" && <p role="status">{t("saved")}</p>}
      {entry.archivedAt && <p>{t("archived")}</p>}
      <TradeStatistics client={client} companyId={companyId} counterpartyId={counterpartyId} search={search} />
      <CounterpartyForm companyId={companyId} entry={entry} />
      <CommandButton action={entry.archivedAt ? restoreCounterpartyAction : archiveCounterpartyAction} fields={{ companyId, id: entry.id }}>{t(entry.archivedAt ? "restore" : "archive")}</CommandButton>
      <DeleteCounterpartyForm companyId={companyId} id={entry.id} />
      <section aria-label={t("linkedDocuments")}>
        <h2>{t("linkedDocuments")}</h2>
        <p>{t("historicalLinks")}</p>
        <p>{t("linkedCount", { count: documents.total })}</p>
        <ul>{documents.entries.map(document => <li key={document.documentId}>
          <Link href={`/companies/${companyId}/documents/${document.documentId}?version=${document.version}`}>
            {document.documentNumber ?? t("unnumberedDocument")}
          </Link>
        </li>)}</ul>
        {documents.total === 0 && <p>{t("noLinkedDocuments")}</p>}
        {documents.pageCount > 1 && <nav aria-label={t("documentPages")}>
          {documents.page > 1 && <Link href={`?documentsPage=${documents.page - 1}`}>{t("previous")}</Link>}
          <span>{t("page", { page: documents.page, total: documents.pageCount })}</span>
          {documents.page < documents.pageCount && <Link href={`?documentsPage=${documents.page + 1}`}>{t("next")}</Link>}
        </nav>}
      </section>
    </PageContent>
  </PageLayout>;
}
