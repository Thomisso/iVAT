"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { rejectDocumentAction } from "@/app/actions";
import { Button } from "@/components/button";
import { FormError } from "@/components/form-error";
import { ReviewActions, useReviewWorkspace } from "./review-workspace";
import { useReviewDraft } from "./review-guard";

/** Exclusion resolves unfinished work only after a deliberate, recorded reason. */
export function ExclusionForm({ fields }: { fields: Record<string, string> }) {
  const t = useTranslations("review");
  const draft = useReviewDraft();
  const workspace = useReviewWorkspace();
  const [state, action, pending] = useActionState(rejectDocumentAction, { error: null, values: {} });
  const [open, setOpen] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  useEffect(() => { if (open) dialog.current?.showModal(); else dialog.current?.close(); }, [open]);
  const close = () => { dialog.current?.close(); setOpen(false); trigger.current?.focus(); };
  return <>
    <ReviewActions kind="reject"><Button disabled={workspace?.pending} onClick={event => { trigger.current = event.currentTarget; if (draft) draft.request(() => setOpen(true)); else setOpen(true); }}>{t("reject")}</Button></ReviewActions>
    <dialog ref={dialog} className="review-dialog" aria-labelledby="review-reject-title" onCancel={event => { event.preventDefault(); if (!pending) close(); }}>
      <h2 id="review-reject-title">{t("reject")}</h2>
      <p>{t("rejectHint")}</p>
      <form action={action} className="form">
        {Object.entries(fields).map(([name, value]) => <input key={name} type="hidden" name={name} value={value} />)}
        <label><span>{t("exclusionReason")}</span><textarea autoFocus className="iv-input" name="reason" required maxLength={500} disabled={pending} defaultValue={state.values.reason ?? ""} /></label>
        <FormError error={state.error} />
        <div className="iv-row"><Button type="submit" variant="danger" disabled={pending}>{t("reject")}</Button><Button disabled={pending} onClick={close}>{t("cancelDecision")}</Button></div>
      </form>
    </dialog>
  </>;
}
