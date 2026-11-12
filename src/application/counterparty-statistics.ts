import { isUuid, type AppClient, type Result } from "./client";
import { halers } from "./money";

export type CounterpartyStatisticsFilters = {
  year?: string; from?: string; to?: string; direction?: string; currency?: string;
  contribution?: string; page?: string;
};
export type CounterpartyTradeGroup = {
  direction: "incoming" | "outgoing"; currency: string | null;
  documentCount: number; amountCount: number; missingAmountCount: number;
  netAmount: string | null; vatAmount: string | null; grossAmount: string | null;
};
export type CounterpartyTradeDocument = {
  documentId: string; version: number; documentNumber: string | null; taxPointDate: string | null;
  direction: "incoming" | "outgoing"; currency: string | null; complete: boolean;
  netAmount: string | null; vatAmount: string | null; grossAmount: string | null;
  grossMismatch: boolean;
};
type StatisticsData = { groups: CounterpartyTradeGroup[]; entries: Omit<CounterpartyTradeDocument, "grossMismatch">[];
  total: number; missingDateCount: number; missingAmountCount: number };
export type CounterpartyStatistics = Omit<StatisticsData, "entries"> & {
  entries: CounterpartyTradeDocument[];
  directions: { direction: "incoming" | "outgoing"; documentCount: number }[];
  from: string; to: string; direction: string; currency: string; contribution: string;
  page: number; pageCount: number;
};

function validDate(value: string) {
  return /^(?!0000)\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value))
    && new Date(value).toISOString().slice(0, 10) === value;
}

/** Full original trade, independent of VAT eligibility and directory role flags. */
export async function getCounterpartyStatistics(client: AppClient, companyId: string, counterpartyId: string,
  input: CounterpartyStatisticsFilters = {},
): Promise<Result<CounterpartyStatistics, "forbidden" | "invalid_statistics_filter">> {
  if (!isUuid(companyId) || !isUuid(counterpartyId)) return { ok: false, error: "forbidden" };
  const year = input.year || new Intl.DateTimeFormat("en", { timeZone: "Europe/Prague", year: "numeric" }).format(new Date());
  const from = input.from || `${year}-01-01`;
  const to = input.to || `${year}-12-31`;
  const direction = input.direction ?? "";
  const currency = input.currency ?? "";
  const contribution = input.contribution ?? "dated";
  const page = Number(input.page ?? "1");
  if (!/^\d{4}$/.test(year) || !validDate(from) || !validDate(to) || from > to
    || !["", "incoming", "outgoing"].includes(direction) || (currency !== "unknown" && !/^([A-Z]{3})?$/.test(currency))
    || !["dated", "complete", "missing_amounts", "missing_date"].includes(contribution)
    || !Number.isSafeInteger(page) || page < 1 || page > 2147483647) return { ok: false, error: "invalid_statistics_filter" };
  const { data, error } = await client.rpc("counterparty_statistics", {
    target_company_id: companyId, target_counterparty_id: counterpartyId,
    date_from: from, date_to: to, trade_direction: direction, original_currency: currency,
    contribution, page_number: page,
  });
  if (error?.code === "42501") return { ok: false, error: "forbidden" };
  if (error?.hint === "invalid_statistics_filter") return { ok: false, error: "invalid_statistics_filter" };
  if (error) throw error;
  const statistics = data as unknown as StatisticsData;
  const directions = (["incoming", "outgoing"] as const).filter(value => !direction || value === direction).map(direction => ({ direction,
    documentCount: statistics.groups.filter(group => group.direction === direction).reduce((count, group) => count + group.documentCount, 0),
  }));
  const entries = statistics.entries.map(document => ({ ...document, grossMismatch: document.netAmount !== null
    && document.vatAmount !== null && document.grossAmount !== null
    && halers(document.netAmount) + halers(document.vatAmount) !== halers(document.grossAmount) }));
  return { ok: true, value: { ...statistics, directions, entries, from, to, direction, currency, contribution,
    page, pageCount: Math.max(1, Math.ceil(statistics.total / 50)) } };
}
