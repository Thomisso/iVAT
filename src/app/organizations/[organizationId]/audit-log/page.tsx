import Link from "next/link";
import { notFound } from "next/navigation";
import { getFormatter, getTranslations } from "next-intl/server";
import {
  listAuditActors,
  listAuditCompanies,
  listAuditEventPage,
  type AuditEventFilters,
} from "@/application/audit";
import { listMyOrganizations } from "@/application/organizations";
import { PageContent, PageHeader, PageLayout } from "@/components/app-shell";
import { Button } from "@/components/button";
import { DataTable } from "@/components/data-table";
import { EmptyState } from "@/components/empty-state";
import { requireUserClient } from "@/lib/supabase/server";

function single(value: string | string[] | undefined): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function date(value: string | string[] | undefined): string | undefined {
  const candidate = single(value);
  if (!candidate || !/^20\d{2}-\d{2}-\d{2}$/.test(candidate)) return undefined;
  const parsed = new Date(`${candidate}T00:00:00.000Z`);
  return Number.isNaN(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== candidate
    ? undefined
    : candidate;
}

function pageNumber(value: string | string[] | undefined): number {
  const parsed = Number(single(value));
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 1;
}

function auditLogHref(organizationId: string, filters: AuditEventFilters, page: number): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) {
    if (value) query.set(key, value);
  }
  if (page > 1) query.set("page", String(page));
  const suffix = query.toString();
  return `/organizations/${organizationId}/audit-log${suffix ? `?${suffix}` : ""}`;
}

export default async function OrganizationAuditLogPage({
  params,
  searchParams,
}: PageProps<"/organizations/[organizationId]/audit-log">) {
  const { organizationId } = await params;
  const query = await searchParams;
  const client = await requireUserClient();
  const [organizations, companies, t, format] = await Promise.all([
    listMyOrganizations(client),
    listAuditCompanies(client, organizationId),
    getTranslations("auditLog"),
    getFormatter(),
  ]);
  const organization = organizations.find((item) => item.id === organizationId && item.role === "administrator");
  if (!organization) notFound();

  const actors = await listAuditActors(client, organizationId);
  const requestedCompanyId = single(query.companyId);
  const requestedActorUserId = single(query.actorUserId);
  const filters: AuditEventFilters = {
    companyId: companies.some((company) => company.id === requestedCompanyId) ? requestedCompanyId : undefined,
    actorUserId: actors.some((actor) => actor.userId === requestedActorUserId) ? requestedActorUserId : undefined,
    action: single(query.action)?.trim().slice(0, 120) || undefined,
    from: date(query.from),
    to: date(query.to),
  };
  const page = await listAuditEventPage(client, organizationId, { ...filters, page: pageNumber(query.page) });
  const companyNames = new Map(companies.map((company) => [company.id, company.name]));
  const actorNames = new Map(actors.map((actor) => [actor.userId, actor.email]));

  const rows = page.events.map((event) => ({
    id: event.id,
    occurredAt: event.occurredAt,
    actor: event.actorUserId ? actorNames.get(event.actorUserId) ?? event.actorUserId : t("systemActor"),
    company: event.companyId ? companyNames.get(event.companyId) ?? event.companyId : t("organizationScope"),
    action: event.action,
    target: event.targetId ? `${event.targetType} · ${event.targetId}` : event.targetType,
    payload: event.payload,
  }));

  return <PageLayout className="audit-log" measure="wide">
    <PageHeader
      description={t("intro")}
      title={t("title", { organization: organization.name })}
    />
    <PageContent measure="wide">
        <form className="form filters" method="get" aria-label={t("filters") }>
          <label className="iv-field-label">
            {t("from")}
            <input className="iv-input" type="date" name="from" defaultValue={filters.from ?? ""} />
          </label>
          <label className="iv-field-label">
            {t("to")}
            <input className="iv-input" type="date" name="to" defaultValue={filters.to ?? ""} />
          </label>
          <label className="iv-field-label">
            {t("company")}
            <select className="iv-input" name="companyId" defaultValue={filters.companyId ?? ""}>
              <option value="">{t("allCompanies")}</option>
              {companies.map((company) => <option key={company.id} value={company.id}>{company.name}</option>)}
            </select>
          </label>
          <label className="iv-field-label">
            {t("user")}
            <select className="iv-input" name="actorUserId" defaultValue={filters.actorUserId ?? ""}>
              <option value="">{t("allUsers")}</option>
              {actors.map((actor) => <option key={actor.userId} value={actor.userId}>{actor.email}</option>)}
            </select>
          </label>
          <label className="iv-field-label">
            {t("action")}
            <input
              className="iv-input"
              type="text"
              name="action"
              maxLength={120}
              defaultValue={filters.action ?? ""}
              placeholder={t("actionPlaceholder")}
            />
          </label>
          <Button type="submit">{t("filter")}</Button>
          <Link className="iv-btn iv-btn-ghost iv-btn-md" href={`/organizations/${organizationId}/audit-log`}>
            {t("clear")}
          </Link>
        </form>
        {rows.length > 0 ? (
          <DataTable
            caption={t("title", { organization: organization.name })}
            rows={rows}
            columns={[
              {
                key: "occurredAt",
                header: t("occurredAt"),
                render: (row) => (
                  <time dateTime={row.occurredAt}>
                    {format.dateTime(new Date(row.occurredAt), { dateStyle: "medium", timeStyle: "short" })}
                  </time>
                ),
              },
              { key: "actor", header: t("user") },
              { key: "company", header: t("company") },
              { key: "action", header: t("action"), mono: true },
              { key: "target", header: t("target"), mono: true },
              {
                key: "payload",
                header: t("details"),
                render: (row) => (
                  <details className="audit-details">
                    <summary>{t("showDetails")}</summary>
                    <pre tabIndex={0}>{JSON.stringify(row.payload, null, 2)}</pre>
                  </details>
                ),
              },
            ]}
          />
        ) : (
          <EmptyState title={t("empty")} />
        )}
        <nav className="pagination" aria-label={t("pagination") }>
          {page.page > 1 ? (
            <Link className="iv-btn iv-btn-ghost iv-btn-md" href={auditLogHref(organizationId, filters, page.page - 1)}>
              {t("previous")}
            </Link>
          ) : <span />}
          <span>{t("pageSummary", { page: page.page, pageCount: page.pageCount, total: page.total })}</span>
          {page.page < page.pageCount ? (
            <Link className="iv-btn iv-btn-ghost iv-btn-md" href={auditLogHref(organizationId, filters, page.page + 1)}>
              {t("next")}
            </Link>
          ) : <span />}
        </nav>
    </PageContent>
  </PageLayout>;
}
