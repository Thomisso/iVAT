"use client";

import { useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import type { WorkbookRows } from "@/application/workbooks";
import type { SourceWorkbookLocation } from "@/application/source-locations";
import { Icon } from "@/components/icon";
import { useSourceEvidence, useSourceFieldLabel } from "./source-evidence-context";

type CellRange = Omit<SourceWorkbookLocation, "fieldPath">;
const containsCell = (range: CellRange, row: number, column: number) => row >= range.firstRow && row <= range.lastRow
  && column >= range.firstColumn && column <= range.lastColumn;

/** Spreadsheet evidence remains real worksheet rows/cells, at every display scale. */
export function WorkbookSourceViewer({ rows, label }: { rows: WorkbookRows; label: string }) {
  const t = useTranslations("review");
  const source = useSourceEvidence();
  const fieldLabel = useSourceFieldLabel();
  const [zoom, setZoom] = useState(1);
  const [inspect, setInspect] = useState(false);
  const original = useRef<HTMLDivElement>(null);
  const evidence = source?.payload.sourceEvidence;
  const reference = source?.selectedField ? evidence?.fields[source.selectedField] : undefined;
  const location = reference?.locations[source?.selectedLocation ?? 0];
  const selected = location?.kind === "workbook" && location.sheetName === rows.sheetName ? location : undefined;
  const locations = Object.entries(evidence?.fields ?? {}).flatMap(([field, entry]) => entry.locations.flatMap((range, index) =>
    range.kind === "workbook" && range.sheetName === rows.sheetName ? [{ field, index, range }] : []));
  useEffect(() => {
    if (!selected) return;
    original.current?.querySelector(`[data-workbook-row="${selected.firstRow}"] [data-workbook-column="${selected.firstColumn}"]`)
      ?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [selected, source?.selection]);
  useEffect(() => {
    if (!inspect) return;
    const close = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !document.querySelector('dialog[open],[role="dialog"][aria-modal="true"]')) setInspect(false);
    };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [inspect]);
  function table(magnified: boolean) {
    const columns = rows.columns.filter(column => !magnified || selected && column.number >= selected.firstColumn && column.number <= selected.lastColumn);
    const visibleRows = rows.rows.filter(row => !magnified || row.context || selected && row.number >= selected.firstRow && row.number <= selected.lastRow);
    return <table className="workbook-source-table" style={{ fontSize: `${magnified ? 1.5 : zoom}em` }}>
      <caption>{t("rowRange", { sheet: rows.sheetName, first: rows.firstRow, last: rows.lastRow })}</caption>
      <thead><tr><th scope="col" aria-label={t("rowRange", { sheet: rows.sheetName, first: rows.firstRow, last: rows.lastRow })} />{columns.map(column => <th key={column.number} scope="col">{column.label}</th>)}</tr></thead>
      <tbody>{visibleRows.map(row => <tr key={row.number} data-workbook-row={row.number} data-context={row.context}>
        <th scope="row">{row.number}</th>
        {columns.map(column => {
          const cell = row.cells.find(cell => cell.column === column.number)!;
          const references = locations.filter(entry => containsCell(entry.range, row.number, cell.column));
          const active = selected && containsCell(selected, row.number, cell.column);
          return <td key={cell.address} data-workbook-cell={cell.address} data-workbook-column={cell.column}
            className={`${references.length ? "has-evidence" : ""} ${active ? "is-selected" : ""}`}>
            <span>{cell.text}</span>
            {!magnified && references.map(entry => <button type="button" key={`${entry.field}-${entry.index}`} data-source-region={entry.field}
              aria-label={t("sourceFor", { field: fieldLabel(entry.field) })} aria-pressed={source?.selectedField === entry.field && source.selectedLocation === entry.index}
              onClick={() => source?.selectField(entry.field, true, entry.index)}><Icon name="marker" /></button>)}
          </td>;
        })}
      </tr>)}</tbody>
    </table>;
  }
  return <section className="iv-viewer pdf-source-viewer workbook-source-viewer" aria-label={label} data-evidence-version={source?.versionId}>
    <div className="pdf-source-toolbar">
      <label>{t("sourceZoom")} <select aria-label={t("sourceZoom")} value={zoom} onChange={event => setZoom(Number(event.target.value))}>
        {[0.75, 1, 1.25, 1.5, 2].map(scale => <option key={scale} value={scale}>{t("sourceZoomValue", { percent: scale * 100 })}</option>)}
      </select></label>
      <button type="button" data-source-inspect-toggle aria-pressed={inspect} disabled={!inspect && !selected}
        onClick={() => setInspect(value => !value)}><Icon name="search" />{t("sourceInspect")}</button>
    </div>
    {inspect && selected && <aside className="pdf-source-inspect workbook-source-inspect" data-source-inspect-crop aria-label={t("sourceInspectCrop")}>{table(true)}</aside>}
    {source?.selectedField && !selected && <p role="status">{t("sourceNoLocation")}</p>}
    <div className="pdf-source-scroll" ref={original} data-source-workbook-original>{table(false)}</div>
  </section>;
}
