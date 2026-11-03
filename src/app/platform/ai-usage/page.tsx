import type { ReactNode } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getFormatter, getTranslations } from "next-intl/server";
import { listAiConfigurations } from "@/application/ai-configurations";
import {
  AI_USAGE_GROUPINGS,
  AI_USAGE_OPERATIONS,
  type AiUsageGrouping,
  type AiUsageOperation,
  type PlatformAiUsageGroup,
  listPlatformAiUsage,
  listPlatformAiUsageModels,
} from "@/application/ai-usage";
import { isUuid } from "@/application/client";
import { listPlatformOrganizationCompanies } from "@/application/platform-administration";
import { AiUsageTable } from "@/components/ai-usage-table";
import { Button } from "@/components/button";
import { DateInput } from "@/components/date-input";
import { Notice } from "@/components/notice";
import { requireUserClient } from "@/lib/supabase/server";
import { PlatformPageLayout } from "../platform-page-layout";

/** The first and last calendar day of the current month in Prague. */
function currentMonth() {
  const today = new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Prague" }).format(new Date());
  const [year, month] = today.split("-").map(Number);
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const prefix = today.slice(0, 8);
  return { from: `${prefix}01`, to: `${prefix}${String(lastDay).padStart(2, "0")}` };
}

function text(value: string | string[] | undefined) {
  return typeof value === "string" ? value : "";
}

function date(value: string | string[] | undefined, fallback: string) {
  const candidate = text(value);
  return /^\d{4}-\d{2}-\d{2}$/.test(candidate) ? candidate : fallback;
}

function uuid(value: string | string[] | undefined) {
  const candidate = text(value);
  return isUuid(candidate) ? candidate : undefined;
}

function oneOf<T extends string>(values: readonly T[], value: string | string[] | undefined): T | undefined {
  const candidate = text(value);
  return (values as readonly string[]).includes(candidate) ? candidate as T : undefined;
}

function FilterSelect({
  label,
  name,
  defaultValue,
  children,
}: {
  label: string;
  name: string;
  defaultValue: string;
  children: ReactNode;
}) {
  return (
    <div className="iv-field">
      <label className="iv-field-label" htmlFor={`ai-usage-${name}`}>{label}</label>
      <select id={`ai-usage-${name}`} className="iv-input" name={name} defaultValue={defaultValue}>
        {children}
      </select>
    </div>
  );
}

export default async function PlatformAiUsagePage({ searchParams }: PageProps<"/platform/ai-usage">) {
  const query = await searchParams;
  const defaults = currentMonth();
  const client = await requireUserClient();
  const [organizations, configurations, models, t, format] = await Promise.all([
    listPlatformOrganizationCompanies(client),
    listAiConfigurations(client),
    listPlatformAiUsageModels(client),
    getTranslations("aiUsage"),
    getFormatter(),
  ]);
  if (!organizations.ok || !configurations.ok || !models.ok) notFound();

  const groupBy: AiUsageGrouping = oneOf(AI_USAGE_GROUPINGS, query.groupBy) ?? "organization";
  const filters = {
    from: date(query.from, defaults.from),
    to: date(query.to, defaults.to),
    groupBy,
    organizationId: uuid(query.organizationId),
    companyId: uuid(query.companyId),
    configurationId: uuid(query.configurationId),
    model: models.value.includes(text(query.model)) ? text(query.model) : undefined,
    operation: oneOf(AI_USAGE_OPERATIONS, query.operation),
  };
  const usage = await listPlatformAiUsage(client, filters);
  if (!usage.ok && usage.error === "forbidden") notFound();
  const groups = usage.ok ? usage.value : [];

  const count = (value: number) => format.number(value);
  const cost = (costUsd: number | null) => costUsd === null
    ? t("unknownCost")
    : format.number(costUsd, { style: "currency", currency: "USD", maximumFractionDigits: 4 });
  const groupLabel = (group: PlatformAiUsageGroup) => {
    if (groupBy === "operation") return t(`operations.${group.key as AiUsageOperation}`);
    if (groupBy === "ai_configuration" && group.key === null) return t("noConfiguration");
    return group.label ?? group.key ?? "";
  };
  const knownCosts = groups.flatMap((group) => group.costUsd === null ? [] : [group.costUsd]);
  const total = {
    requests: groups.reduce((sum, group) => sum + group.requests, 0),
    inputTokens: groups.reduce((sum, group) => sum + group.inputTokens, 0),
    outputTokens: groups.reduce((sum, group) => sum + group.outputTokens, 0),
    costUsd: knownCosts.length === 0 ? null : knownCosts.reduce((sum, value) => sum + value, 0),
    unknownCostEvents: groups.reduce((sum, group) => sum + group.unknownCostEvents, 0),
  };
  const rows = [
    ...groups.map((group) => ({ ...group, id: group.key ?? "none", label: groupLabel(group) })),
    ...(groups.length > 0 ? [{ ...total, id: "total", label: t("total") }] : []),
  ].map((row) => ({
    id: row.id,
    group: row.label,
    requests: count(row.requests),
    inputTokens: count(row.inputTokens),
    outputTokens: count(row.outputTokens),
    cost: cost(row.costUsd),
    unknownCostEvents: count(row.unknownCostEvents),
  }));
  const companies = organizations.value.flatMap((organization) =>
    organization.companies.map((company) => ({ id: company.id, name: `${organization.name} · ${company.name}` })));

  return (
    <PlatformPageLayout title={t("platformTitle")} description={t("platformIntro")}>
      <form className="form settings-form" method="get" aria-label={t("filters")}>
        <DateInput label={t("from")} name="from" defaultValue={filters.from} />
        <DateInput label={t("to")} name="to" defaultValue={filters.to} />
        <FilterSelect label={t("organization")} name="organizationId" defaultValue={filters.organizationId ?? ""}>
          <option value="">{t("all")}</option>
          {organizations.value.map((organization) => (
            <option key={organization.id} value={organization.id}>{organization.name}</option>
          ))}
        </FilterSelect>
        <FilterSelect label={t("company")} name="companyId" defaultValue={filters.companyId ?? ""}>
          <option value="">{t("all")}</option>
          {companies.map((company) => <option key={company.id} value={company.id}>{company.name}</option>)}
        </FilterSelect>
        <FilterSelect label={t("configuration")} name="configurationId" defaultValue={filters.configurationId ?? ""}>
          <option value="">{t("all")}</option>
          {configurations.value.map((configuration) => (
            <option key={configuration.id} value={configuration.id}>{configuration.label}</option>
          ))}
        </FilterSelect>
        <FilterSelect label={t("model")} name="model" defaultValue={filters.model ?? ""}>
          <option value="">{t("all")}</option>
          {models.value.map((model) => <option key={model} value={model}>{model}</option>)}
        </FilterSelect>
        <FilterSelect label={t("operation")} name="operation" defaultValue={filters.operation ?? ""}>
          <option value="">{t("all")}</option>
          {AI_USAGE_OPERATIONS.map((operation) => (
            <option key={operation} value={operation}>{t(`operations.${operation}`)}</option>
          ))}
        </FilterSelect>
        <FilterSelect label={t("groupBy")} name="groupBy" defaultValue={groupBy}>
          {AI_USAGE_GROUPINGS.map((grouping) => (
            <option key={grouping} value={grouping}>{t(`groupings.${grouping}`)}</option>
          ))}
        </FilterSelect>
        <p className="settings-form-actions">
          <Button type="submit" variant="primary">{t("filter")}</Button>
          <Link className="iv-btn iv-btn-ghost iv-btn-md" href="/platform/ai-usage">{t("clear")}</Link>
        </p>
      </form>
      {!usage.ok && <Notice tone="danger">{t("invalidPeriod")}</Notice>}
      <AiUsageTable
        rows={rows}
        labels={{
          caption: t("platformTitle"),
          group: t(`groupings.${groupBy}`),
          requests: t("requests"),
          inputTokens: t("inputTokens"),
          outputTokens: t("outputTokens"),
          cost: t("cost"),
          unknownCostEvents: t("unknownCostEvents"),
          empty: t("empty"),
        }}
      />
    </PlatformPageLayout>
  );
}
