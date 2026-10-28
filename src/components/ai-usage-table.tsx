import { DataTable, type DataTableColumn } from "./data-table";
import { EmptyState } from "./empty-state";

export type AiUsageTableRow = {
  id: string;
  owner: string;
  provider: string;
  model: string;
  requests: number;
  inputTokens: number;
  outputTokens: number;
};

export function AiUsageTable({
  rows,
  labels,
}: {
  rows: AiUsageTableRow[];
  labels: {
    caption: string;
    owner: string;
    provider: string;
    model: string;
    requests: string;
    inputTokens: string;
    outputTokens: string;
    empty: string;
  };
}) {
  if (rows.length === 0) return <EmptyState icon="clock" title={labels.empty} />;
  const columns: DataTableColumn<AiUsageTableRow>[] = [
    { key: "owner", header: labels.owner },
    { key: "provider", header: labels.provider },
    { key: "model", header: labels.model, mono: true },
    { key: "requests", header: labels.requests, align: "right" },
    { key: "inputTokens", header: labels.inputTokens, align: "right" },
    { key: "outputTokens", header: labels.outputTokens, align: "right" },
  ];
  return <DataTable caption={labels.caption} rows={rows} columns={columns} />;
}
