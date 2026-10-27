import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { listOrganizationAiUsage } from "@/application/ai-usage";
import { listMyCompanies } from "@/application/companies";
import { listMyOrganizations } from "@/application/organizations";
import { AiUsageTable } from "@/components/ai-usage-table";
import { AppSidebar } from "@/components/app-sidebar";
import { Button } from "@/components/button";
import { requireUserClient } from "@/lib/supabase/server";

function currentMonth() {
  const now = new Date();
  const from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const to = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  return { from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10) };
}

function date(value: string | string[] | undefined, fallback: string) {
  const candidate = typeof value === "string" ? value : "";
  return /^20\d{2}-\d{2}-\d{2}$/.test(candidate) ? candidate : fallback;
}

export default async function OrganizationAiUsagePage({
  params,
  searchParams,
}: PageProps<"/organizations/[organizationId]/ai-usage">) {
  const { organizationId } = await params;
  const query = await searchParams;
  const defaults = currentMonth();
  const from = date(query.from, defaults.from);
  const to = date(query.to, defaults.to);
  const client = await requireUserClient();
  const [organizations, allCompanies, t] = await Promise.all([
    listMyOrganizations(client),
    listMyCompanies(client),
    getTranslations("aiUsage"),
  ]);
  const organization = organizations.find((item) => item.id === organizationId && item.role === "administrator");
  if (!organization) notFound();
  const companies = allCompanies.filter((company) => company.organizationId === organizationId);
  const requestedCompanyId = typeof query.companyId === "string" ? query.companyId : undefined;
  const companyId = companies.some((company) => company.id === requestedCompanyId) ? requestedCompanyId : undefined;
  const usage = await listOrganizationAiUsage(client, { organizationId, companyId, from, to });
  if (!usage.ok) notFound();

  return (
    <>
      <AppSidebar />
      <main className="dashboard">
        <header>
          <h1>{t("organizationTitle", { organization: organization.name })}</h1>
          <p className="iv-muted">{t("organizationIntro")}</p>
        </header>
        <form className="form filters" method="get" aria-label={t("filters") }>
          <label className="iv-field-label">
            {t("from")}
            <input className="iv-input" type="date" name="from" defaultValue={from} />
          </label>
          <label className="iv-field-label">
            {t("to")}
            <input className="iv-input" type="date" name="to" defaultValue={to} />
          </label>
          <label className="iv-field-label">
            {t("company")}
            <select className="iv-input" name="companyId" defaultValue={companyId ?? ""}>
              <option value="">{t("allCompanies")}</option>
              {companies.map((company) => <option key={company.id} value={company.id}>{company.name}</option>)}
            </select>
          </label>
          <Button type="submit">{t("filter")}</Button>
        </form>
        <AiUsageTable
          rows={usage.value.map((row) => ({
            id: `${row.companyId}:${row.provider}:${row.model}`,
            owner: row.companyName,
            provider: row.provider,
            model: row.model,
            requests: row.requests,
            inputTokens: row.inputTokens,
            outputTokens: row.outputTokens,
          }))}
          labels={{
            caption: t("organizationTitle", { organization: organization.name }),
            owner: t("company"),
            provider: t("provider"),
            model: t("model"),
            requests: t("requests"),
            inputTokens: t("inputTokens"),
            outputTokens: t("outputTokens"),
            empty: t("empty"),
          }}
        />
      </main>
    </>
  );
}
