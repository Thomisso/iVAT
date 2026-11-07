"use client";

import { useActionState, useId, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/button";
import { FormError } from "@/components/form-error";
import { deleteCounterpartyAction } from "./actions";

export function DeleteCounterpartyForm({ companyId, id }: { companyId: string; id: string }) {
  const t = useTranslations("counterparties");
  const [state, action, pending] = useActionState(deleteCounterpartyAction, { error: null, values: {} });
  const [confirming, setConfirming] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const confirmationId = useId();
  function keep() { setConfirming(false); trigger.current?.focus(); }
  return <section className="command" aria-label={t("deleteTitle")}>
    <Button type="button" variant="danger" disabled={pending} aria-expanded={confirming}
      aria-controls={confirming ? confirmationId : undefined}
      onClick={event => { trigger.current = event.currentTarget; setConfirming(true); }}>{t("delete")}</Button>
    {confirming && <fieldset id={confirmationId} className="form" onKeyDown={event => {
      if (event.key === "Escape" && !pending) { event.preventDefault(); keep(); }
    }}>
      <legend>{t("deleteTitle")}</legend>
      <p>{t("deleteHint")}</p>
      <form action={action} className="form-row">
        <input type="hidden" name="companyId" value={companyId} />
        <input type="hidden" name="id" value={id} />
        <Button type="submit" variant="danger" disabled={pending}>{t("confirmDelete")}</Button>
        <Button type="button" disabled={pending} onClick={keep}>{t("keep")}</Button>
      </form>
    </fieldset>}
    <FormError error={state.error} />
  </section>;
}
