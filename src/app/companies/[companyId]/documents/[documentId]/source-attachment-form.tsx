"use client";

import { useActionState, useState } from "react";
import { useTranslations } from "next-intl";
import { attachDocumentSourceAction, reprocessDocumentAction } from "@/app/actions";
import { Button } from "@/components/button";
import { DropZone } from "@/components/drop-zone";
import { FormError } from "@/components/form-error";
import { Notice } from "@/components/notice";

/** The selected original survives a refused action; only explicit submission attaches it. */
export function AttachDocumentSourceForm({ companyId, documentId }: { companyId: string; documentId: string }) {
  const t = useTranslations("review");
  const source = useTranslations("sourceFiles");
  const [file, setFile] = useState<File | null>(null);
  const [sourceFileId, setSourceFileId] = useState("");
  const [state, action, pending] = useActionState(async (previous: { error: string | null; values: Record<string, string> }, data: FormData) => {
    const selected = data.get("file");
    if (file && (!(selected instanceof File) || selected.size === 0)) data.set("file", file);
    return attachDocumentSourceAction(previous, data);
  }, { error: null, values: {} });
  const workbook = /\.(xlsx|xls)$/i.test(file?.name ?? "");
  return <form action={action} className="form">
    <input type="hidden" name="companyId" value={companyId} /><input type="hidden" name="documentId" value={documentId} />
    <input type="hidden" name="sourceFileId" value={sourceFileId} /><input type="hidden" name="rangeKind" value={workbook ? "workbook" : "pages"} />
    <fieldset disabled={pending}>
      <legend>{t("attachSourceTitle")}</legend>
      <p>{t("attachSourceHint")}</p>
      <DropZone required={!file} onFiles={event => { setFile(event.currentTarget.files?.[0] ?? null); setSourceFileId(crypto.randomUUID()); }} />
      {file && <p className="iv-mono" style={{ overflowWrap: "anywhere" }}>{file.name}</p>}
      <p>{workbook ? t("attachRowsHint") : t("attachPagesHint")}</p>
      <div className="fields">
        {workbook ? <>
          <label><span>{source("sheetName")}</span><input className="iv-input" name="sheetName" required defaultValue={state.values.sheetName ?? ""} /></label>
          <label><span>{source("firstRow")}</span><input className="iv-input" name="firstRow" type="number" min={1} step={1} required defaultValue={state.values.firstRow ?? ""} /></label>
          <label><span>{source("lastRow")}</span><input className="iv-input" name="lastRow" type="number" min={1} step={1} required defaultValue={state.values.lastRow ?? ""} /></label>
        </> : <>
          <label><span>{source("firstPage")}</span><input className="iv-input" name="firstPage" type="number" min={1} step={1} defaultValue={state.values.firstPage ?? ""} /></label>
          <label><span>{source("lastPage")}</span><input className="iv-input" name="lastPage" type="number" min={1} step={1} defaultValue={state.values.lastPage ?? ""} /></label>
        </>}
      </div>
    </fieldset>
    <FormError error={state.error} />
    <Button type="submit" disabled={pending}>{t("attachSource")}</Button>
  </form>;
}

export function DocumentAiReplacementForm({ companyId, documentId }: { companyId: string; documentId: string }) {
  const t = useTranslations("review");
  const [state, action, pending] = useActionState(reprocessDocumentAction, { error: null, values: {} });
  return <form action={action} className="form" data-review-departure>
    <input type="hidden" name="companyId" value={companyId} /><input type="hidden" name="documentId" value={documentId} />
    <Notice tone="warning" title={t("aiReplacementTitle")}>{t("aiReplacementWarning")}</Notice>
    <label className="iv-checkbox-row"><input type="checkbox" name="confirmed" required defaultChecked={state.values.confirmed === "on"} disabled={pending} /><span>{t("aiReplacementConfirm")}</span></label>
    <FormError error={state.error} />
    <Button type="submit" variant="ai" icon="marker" disabled={pending}>{t("aiReplacementStart")}</Button>
  </form>;
}
