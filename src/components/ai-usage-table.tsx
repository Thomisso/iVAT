import { DataTable, type DataTableColumn } from "./data-table";
import { EmptyState } from "./empty-state";

export type AiUsageTableRow = {
  id: string;
  group: string;
  /** Formatted for display, like every value below. */
  requests: string;
  inputTokens: string;
  outputTokens: string;
  /** The known cost, or the unknown-cost wording. */
  cost: string;
  unknownCostEvents: string;
};

export function AiUsageTable({
  rows,
  labels,
}: {
  rows: AiUsageTableRow[];
  labels: {
    caption: string;
    group: string;
    requests: string;
    inputTokens: string;
    outputTokens: string;
    cost: string;
    unknownCostEvents: string;
    empty: string;
  };
}) {
  if (rows.length === 0) return <EmptyState icon="clock" title={labels.empty} />;
  const columns: DataTableColumn<AiUsageTableRow>[] = [
    { key: "group", header: labels.group },
    { key: "requests", header: labels.requests, align: "right" },
    { key: "inputTokens", header: labels.inputTokens, align: "right" },
    { key: "outputTokens", header: labels.outputTokens, align: "right" },
    { key: "cost", header: labels.cost, align: "right" },
    { key: "unknownCostEvents", header: labels.unknownCostEvents, align: "right" },
  ];
  return <DataTable caption={labels.caption} rows={rows} columns={columns} />;
}
