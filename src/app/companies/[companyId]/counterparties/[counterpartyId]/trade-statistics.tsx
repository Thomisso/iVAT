import Link from "next/link";
import { getTranslations } from "next-intl/server";
import type { AppClient } from "@/application/client";
import { getCounterpartyStatistics, type CounterpartyStatisticsFilters } from "@/application/counterparty-statistics";
import { withCompanyReturnTo } from "@/application/return-context";
import { DataTable } from "@/components/data-table";
import { Money } from "@/components/money";
import { formatDate } from "@/lib/format-date";

export async function TradeStatistics({ client, companyId, counterpartyId, search }: {
  client: AppClient; companyId: string; counterpartyId: string; search: CounterpartyStatisticsFilters;
}) {
  const t = await getTranslations("counterpartyTrade");
  const directory = await getTranslations("counterparties");
  const result = await getCounterpartyStatistics(client, companyId, counterpartyId, search).catch(() => null);
  const base = `/companies/${companyId}/counterparties/${counterpartyId}`;
  if (!result?.ok) return <section aria-label={t("title")}>
    <h2>{t("title")}</h2><p role="status">{t(result && result.error === "invalid_statistics_filter" ? "invalidFilters" : "unavailable")}</p>
    <Link href={base}>{t("reset")}</Link>
  </section>;
  const statistics = result.value;
  function href(changes: Record<string, string | number> = {}) {
    const query = new URLSearchParams({ from: statistics.from, to: statistics.to,
      direction: statistics.direction, currency: statistics.currency, contribution: statistics.contribution,
      page: String(statistics.page), ...Object.fromEntries(Object.entries(changes).map(([key, value]) => [key, String(value)])),
    });
    return `${base}?${query}`;
  }
  function money(value: string | null) {
    return value === null ? t("unavailableAmount") : <Money amount={value} currency="" />;
  }
  return <section aria-label={t("title")}>
    <h2>{t("title")}</h2>
    <p>{t("description")}</p>
    <form action={base} className="document-queue-filters" aria-label={t("yearFilter")}>
      <label><span>{t("year")}</span><input className="iv-input" type="number" min="1" max="9999" name="year" defaultValue={statistics.from.slice(0, 4)} /></label>
      <button className="iv-btn" type="submit">{t("chooseYear")}</button>
    </form>
    <form action={base} className="document-queue-filters" aria-label={t("filters")}>
      <label><span>{t("from")}</span><input className="iv-input" type="date" name="from" defaultValue={statistics.from} required /></label>
      <label><span>{t("to")}</span><input className="iv-input" type="date" name="to" defaultValue={statistics.to} required /></label>
      <label><span>{t("direction")}</span><select className="iv-input" name="direction" defaultValue={statistics.direction}>
        <option value="">{t("allDirections")}</option><option value="incoming">{t("incoming")}</option><option value="outgoing">{t("outgoing")}</option>
      </select></label>
      <label><span>{t("currency")}</span><select className="iv-input" name="currency" defaultValue={statistics.currency}>
        <option value="">{t("allCurrencies")}</option>
        {[...new Set([...statistics.groups.flatMap(group => group.currency ? [group.currency] : []), ...(/^[A-Z]{3}$/.test(statistics.currency) ? [statistics.currency] : [])])].sort().map(currency => <option key={currency} value={currency}>{currency}</option>)}
        <option value="unknown">{t("unknownCurrency")}</option>
      </select></label>
      <label><span>{t("contributions")}</span><select className="iv-input" name="contribution" defaultValue={statistics.contribution}>
        {["dated", "complete", "missing_amounts", "missing_date"].map(value => <option key={value} value={value}>{t(value)}</option>)}
      </select></label>
      <button className="iv-btn iv-btn-primary" type="submit">{directory("filter")}</button>
      <Link href={base}>{t("reset")}</Link>
    </form>
    <p>{t("period", { from: formatDate(statistics.from), to: formatDate(statistics.to) })}</p>
    <ul>{statistics.directions.map(group => <li key={group.direction}>
      <Link href={href({ direction: group.direction, contribution: "dated", page: 1 })}>{t("directionCount", { direction: t(group.direction), count: group.documentCount })}</Link>
    </li>)}</ul>
    <p><Link href={href({ contribution: "missing_date", page: 1 })}>{t("missingDates", { count: statistics.missingDateCount })}</Link></p>
    <p><Link href={href({ contribution: "missing_amounts", page: 1 })}>{t("missingAmounts", { count: statistics.missingAmountCount })}</Link></p>
    {statistics.groups.length ? <DataTable caption={t("summary")} rows={statistics.groups.map((group, index) => ({ ...group, id: index }))} columns={[
      { key: "direction", header: t("direction"), render: row => t(row.direction) },
      { key: "currency", header: t("currency"), render: row => row.currency ?? t("unknownCurrency") },
      { key: "documentCount", header: t("count"), align: "right", render: row => <Link href={href({ direction: row.direction, currency: row.currency ?? "unknown", contribution: "dated", page: 1 })}>{row.documentCount}</Link> },
      ...(["netAmount", "vatAmount", "grossAmount"] as const).map(key => ({ key, header: t(key), align: "right" as const, render: (row: typeof statistics.groups[number]) => row[key] === null ? money(null) : <Link href={href({ direction: row.direction, currency: row.currency ?? "unknown", contribution: "complete", page: 1 })}>{money(row[key])}</Link> })),
      { key: "amountCount", header: t("amountCount"), align: "right", render: row => <Link href={href({ direction: row.direction, currency: row.currency ?? "unknown", contribution: "complete", page: 1 })}>{row.amountCount}</Link> },
    ]} /> : <p>{t("emptySummary")}</p>}
    <h3>{t("documents")}</h3><p>{t("countDocuments", { count: statistics.total })}</p>
    {statistics.entries.length ? <DataTable caption={t("documents")} rows={statistics.entries.map(document => ({ ...document, id: document.documentId }))} columns={[
      { key: "documentNumber", header: t("document"), render: row => <Link href={withCompanyReturnTo(companyId, `/companies/${companyId}/documents/${row.documentId}?version=${row.version}`, href())}>{row.documentNumber ?? directory("unnumberedDocument")}</Link> },
      { key: "taxPointDate", header: t("taxPointDate"), render: row => row.taxPointDate ? formatDate(row.taxPointDate) : t("missingDate") },
      { key: "direction", header: t("direction"), render: row => t(row.direction) },
      { key: "currency", header: t("currency"), render: row => row.currency ?? t("unknownCurrency") },
      ...(["netAmount", "vatAmount", "grossAmount"] as const).map(key => ({ key, header: t(key), align: "right" as const, render: (row: typeof statistics.entries[number]) => money(row[key]) })),
      { key: "notes", header: t("notes"), render: row => <>
        {!row.complete && <p>{t("incomplete")}</p>}
        {row.grossMismatch && <p>{t("grossMismatch")}</p>}
      </> },
    ]} /> : <p>{t("emptyDocuments")}</p>}
    {statistics.pageCount > 1 && <nav aria-label={t("pagination")}>
      {statistics.page > 1 && <Link href={href({ page: statistics.page - 1 })}>{directory("previous")}</Link>}{" "}
      <span>{directory("page", { page: statistics.page, total: statistics.pageCount })}</span>{" "}
      {statistics.page < statistics.pageCount && <Link href={href({ page: statistics.page + 1 })}>{directory("next")}</Link>}
    </nav>}
  </section>;
}
