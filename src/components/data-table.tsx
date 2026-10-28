import type { ReactNode } from "react";

export interface DataTableColumn<Row> {
  key: string;
  header: string;
  align?: "left" | "right";
  mono?: boolean;
  muted?: boolean;
  render?: (row: Row) => ReactNode;
}
export interface DataTableProps<Row extends { id: string | number }> {
  columns: DataTableColumn<Row>[];
  rows: Row[];
  selectedId?: Row["id"];
  caption?: string;
  rowId?: (row: Row) => string;
}
export function DataTable<Row extends { id: string | number }>({
  columns,
  rows,
  selectedId,
  caption,
  rowId,
}: DataTableProps<Row>) {
  return (
    <div className="iv-table-wrap">
      <table className="iv-table">
        {caption && <caption className="sr-only">{caption}</caption>}
        <thead>
          <tr>
            {columns.map((column) => (
              <th
                key={column.key}
                scope="col"
                className={column.align === "right" ? "is-num" : undefined}
              >
                {column.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr
              key={row.id}
              id={rowId?.(row)}
              className={row.id === selectedId ? "is-selected" : undefined}
            >
              {columns.map((column) => (
                <td
                  key={column.key}
                  className={[
                    column.align === "right" && "is-num",
                    column.mono && "iv-mono",
                    column.muted && "iv-muted",
                  ]
                    .filter(Boolean)
                    .join(" ")}
                >
                  {column.render
                    ? column.render(row)
                    : ((row as Record<string, unknown>)[
                        column.key
                      ] as ReactNode)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
