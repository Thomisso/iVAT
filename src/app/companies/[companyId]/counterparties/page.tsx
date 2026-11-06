import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { listCounterparties } from "@/application/counterparties";
import { PageContent, PageHeader, PageLayout } from "@/components/app-shell";
import { DataTable } from "@/components/data-table";
import { requireUserClient } from "@/lib/supabase/server";

export default async function CounterpartiesPage({ params, searchParams }: {
  params: Promise<{ companyId: string }>;
  searchParams: Promise<{ search?: string; role?: string; page?: string }>;
}) {
  const { companyId } = await params;
  const search = await searchParams;
  const role = search.role === "supplier" || search.role === "customer" ? search.role : undefined;
  const client = await requireUserClient();
  const page = await listCounterparties(client, companyId, { search: search.search, role, page: Number(search.page ?? 1) });
  const t = await getTranslations("counterparties");
  const base = `/companies/${companyId}/counterparties`;
  const pageHref = (number: number) => `${base}?${new URLSearchParams({ search: search.search ?? "", role: role ?? "", page: String(number) })}`;
  return <PageLayout className="documents-workspace counterparty-directory" measure="wide">
    <PageHeader title={t("title")} description={t("description")} actions={<Link className="iv-btn iv-btn-primary" href={`${base}/new`}>{t("create")}</Link>} />
    <PageContent measure="wide">
      <form action={base} className="document-queue-filters" aria-label={t("filters")}>
        <label><span>{t("search")}</span><input className="iv-input" name="search" defaultValue={search.search} placeholder={t("searchHint")} /></label>
        <label><span>{t("roles")}</span><select className="iv-input" name="role" defaultValue={role ?? ""}>
          <option value="">{t("allRoles")}</option><option value="supplier">{t("supplier")}</option><option value="customer">{t("customer")}</option>
        </select></label>
        <button className="iv-btn iv-btn-primary" type="submit">{t("filter")}</button>
        <Link href={base}>{t("clear")}</Link>
      </form>
      <p>{t("count", { count: page.total })}</p>
      {page.entries.length ? <DataTable caption={t("title")} rows={page.entries} columns={[
        { key: "name", header: t("name"), render: entry => <Link href={`${base}/${entry.id}`}>{entry.name}</Link> },
        { key: "ico", header: t("ico"), render: entry => entry.ico ?? t("notSet") },
        { key: "vatId", header: t("vatId"), render: entry => entry.vatId ?? t("notSet") },
        { key: "roles", header: t("roles"), render: entry => [entry.supplier && t("supplier"), entry.customer && t("customer")].filter(Boolean).join(", ") },
      ]} /> : <p>{t("empty")}</p>}
      {page.pageCount > 1 && <nav aria-label={t("pagination")}>
        {page.page > 1 && <Link href={pageHref(page.page - 1)}>{t("previous")}</Link>}{" "}
        <span>{t("page", { page: page.page, total: page.pageCount })}</span>{" "}
        {page.page < page.pageCount && <Link href={pageHref(page.page + 1)}>{t("next")}</Link>}
      </nav>}
    </PageContent>
  </PageLayout>;
}
