"use client";

import { useActionState, useState } from "react";
import { useTranslations } from "next-intl";
import { defineSourceDocumentsAction, excludeSourceFileAction } from "@/app/actions";
import { Button } from "@/components/button";
import { FormError } from "@/components/form-error";
import type { WorkbookRowSet } from "@/application/workbooks";

/** Boundaries reference real pages; structured accounting fields belong to each Document. */
export function ManualSourceForm({ companyId, sourceFileId, pageCount }: { companyId: string; sourceFileId: string; pageCount: number }) {
  const t = useTranslations("sourceFiles");
  const [state, action, pending] = useActionState(defineSourceDocumentsAction, { error: null, values: {} });
  const [rows, setRows] = useState([{ id: 0, firstPage: "1", lastPage: String(pageCount) }]);
  const [nextId, setNextId] = useState(1);
  const submitted = state.values.ranges ? JSON.parse(state.values.ranges) as { firstPage: string; lastPage: string }[] : null;
  return <form action={action} className="form">
    <input type="hidden" name="companyId" value={companyId} />
    <input type="hidden" name="sourceFileId" value={sourceFileId} />
    <fieldset>
      <legend>{t("manualTitle")}</legend>
      <p>{t("manualHint", { count: pageCount })}</p>
      {rows.map((row, index) => <div className="fields" key={row.id}>
        <label><span>{t("firstPage")}</span><input className="iv-input" type="number" name="firstPage" required min={1} max={pageCount} step={1} defaultValue={submitted?.[index]?.firstPage ?? row.firstPage} /></label>
        <label><span>{t("lastPage")}</span><input className="iv-input" type="number" name="lastPage" required min={1} max={pageCount} step={1} defaultValue={submitted?.[index]?.lastPage ?? row.lastPage} /></label>
        {rows.length > 1 && <Button type="button" disabled={pending} onClick={() => setRows(rows.filter((candidate) => candidate.id !== row.id))}>{t("removeRange")}</Button>}
      </div>)}
      <Button type="button" disabled={pending} onClick={() => { setRows([...rows, { id: nextId, firstPage: "", lastPage: "" }]); setNextId(nextId + 1); }}>{t("addRange")}</Button>
    </fieldset>
    <FormError error={state.error} />
    <Button type="submit" variant="primary" disabled={pending}>{t("defineDocuments")}</Button>
  </form>;
}

/** Sheets and their bounds come from the stored workbook, never invented page images. */
export function ManualWorkbookForm({ companyId, sourceFileId, sheets }: { companyId: string; sourceFileId: string; sheets: WorkbookRowSet[] }) {
  const t = useTranslations("sourceFiles");
  const [state, action, pending] = useActionState(defineSourceDocumentsAction, { error: null, values: {} });
  const [rows, setRows] = useState([{ id: 0, sheetName: sheets[0].sheetName, firstRow: String(sheets[0].firstRow), lastRow: String(sheets[0].lastRow) }]);
  const [nextId, setNextId] = useState(1);
  const submitted = state.values.ranges ? JSON.parse(state.values.ranges) as { sheetName: string; firstRow: string; lastRow: string }[] : null;
  return <form action={action} className="form" key={JSON.stringify(state.values)}>
    <input type="hidden" name="companyId" value={companyId} /><input type="hidden" name="sourceFileId" value={sourceFileId} />
    <fieldset>
      <legend>{t("manualWorkbookTitle")}</legend>
      <p>{t("manualWorkbookHint")}</p>
      {rows.map((row, index) => <div className="fields" key={row.id}>
        <label><span>{t("sheetName")}</span><select className="iv-input" name="sheetName" required defaultValue={submitted?.[index]?.sheetName ?? row.sheetName}>
          <option value="">{t("chooseSheet")}</option>
          {sheets.map((sheet) => <option key={sheet.sheetName} value={sheet.sheetName}>{t("sheetBounds", { sheet: sheet.sheetName, first: sheet.firstRow, last: sheet.lastRow })}</option>)}
        </select></label>
        <label><span>{t("firstRow")}</span><input className="iv-input" type="number" name="firstRow" required min={1} step={1} defaultValue={submitted?.[index]?.firstRow ?? row.firstRow} /></label>
        <label><span>{t("lastRow")}</span><input className="iv-input" type="number" name="lastRow" required min={1} step={1} defaultValue={submitted?.[index]?.lastRow ?? row.lastRow} /></label>
        {rows.length > 1 && <Button type="button" disabled={pending} onClick={() => setRows(rows.filter((candidate) => candidate.id !== row.id))}>{t("removeRange")}</Button>}
      </div>)}
      <Button type="button" disabled={pending} onClick={() => { setRows([...rows, { id: nextId, sheetName: "", firstRow: "", lastRow: "" }]); setNextId(nextId + 1); }}>{t("addRange")}</Button>
    </fieldset>
    <FormError error={state.error} />
    <Button type="submit" variant="primary" disabled={pending}>{t("defineDocuments")}</Button>
  </form>;
}

export function SourceExclusionForm({ companyId, sourceFileId }: { companyId: string; sourceFileId: string }) {
  const t = useTranslations();
  const [state, action, pending] = useActionState(excludeSourceFileAction, { error: null, values: {} });
  return <form action={action} className="form">
    <input type="hidden" name="companyId" value={companyId} /><input type="hidden" name="sourceFileId" value={sourceFileId} />
    <label><span>{t("review.exclusionReason")}</span><textarea className="iv-input" name="reason" required maxLength={500} defaultValue={state.values.reason ?? ""} /></label>
    <FormError error={state.error} />
    <Button type="submit" variant="danger" disabled={pending}>{t("sourceFiles.exclude")}</Button>
  </form>;
}
