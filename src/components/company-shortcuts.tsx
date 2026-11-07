"use client";

import { createContext, useCallback, useContext, useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/button";
import { ShellIcon } from "@/components/shell-controls";

const ShortcutsContext = createContext<{
  registerReviewForm: (form: HTMLFormElement) => () => void;
  openGuide: (trigger: HTMLButtonElement) => void;
  dialogId: string;
  open: boolean;
} | null>(null);

export function useCompanyReviewShortcuts() {
  return useContext(ShortcutsContext)?.registerReviewForm;
}

function reviewButton(form: HTMLFormElement | null, intent: "save" | "approve") {
  return form && [...form.elements].find((element): element is HTMLButtonElement =>
    element instanceof HTMLButtonElement && element.name === "intent" && element.value === intent
    && !element.matches(":disabled") && element.isConnected,
  );
}

/** One controller and dialog serve both responsive copies of the shell controls. */
export function CompanyShortcuts({ children }: { children: ReactNode }) {
  const t = useTranslations("companyShortcuts");
  const [reviewForm, setReviewForm] = useState<HTMLFormElement | null>(null);
  const [open, setOpen] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const trigger = useRef<HTMLButtonElement | null>(null);
  const dialogId = useId();
  const titleId = useId();
  const registerReviewForm = useCallback((form: HTMLFormElement) => {
    setReviewForm(form);
    return () => setReviewForm(current => current === form ? null : current);
  }, []);
  const openGuide = useCallback((button: HTMLButtonElement) => {
    if (document.querySelector('dialog[open], [role="dialog"][aria-modal="true"]')) return;
    trigger.current = button;
    setOpen(true);
  }, []);
  useEffect(() => {
    if (!open) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const element = dialog.current;
    element?.showModal();
    element?.querySelector<HTMLButtonElement>("button")?.focus();
    return () => {
      element?.close();
      document.body.style.overflow = previousOverflow;
      trigger.current?.focus();
    };
  }, [open]);
  useEffect(() => {
    let composing = false;
    const compositionStart = () => { composing = true; };
    const compositionEnd = () => { composing = false; };
    const keydown = (event: KeyboardEvent) => {
      if (composing || event.defaultPrevented || event.isComposing || event.keyCode === 229 || event.repeat
        || !reviewForm?.isConnected || document.querySelector('dialog[open], [role="dialog"][aria-modal="true"]')) return;
      const target = event.target;
      if (event.key === "Enter" && !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey
        && target instanceof HTMLInputElement && target.form === reviewForm
        && !["button", "submit", "reset", "checkbox", "radio", "file", "color", "range"].includes(target.type)) {
        event.preventDefault();
        return;
      }
      if (event.altKey || event.shiftKey || !(event.ctrlKey || event.metaKey)) return;
      const intent = event.key.toLowerCase() === "s" ? "save" : event.key === "Enter" ? "approve" : null;
      if (!intent || reviewForm.getAttribute("aria-busy") === "true") return;
      if ((target instanceof HTMLInputElement || target instanceof HTMLSelectElement || target instanceof HTMLTextAreaElement)
        && target.form !== reviewForm
        && !(target.form?.matches(".reporting-assignment-form") && reviewForm.closest(".review-workspace")?.contains(target.form))) return;
      if (target instanceof HTMLElement && target.isContentEditable) return;
      const button = reviewButton(reviewForm, intent);
      if (!button) return;
      event.preventDefault();
      // Keep native validation and ReviewGuard's two-form submit interception.
      reviewForm.requestSubmit(button);
    };
    document.addEventListener("compositionstart", compositionStart);
    document.addEventListener("compositionend", compositionEnd);
    document.addEventListener("keydown", keydown);
    return () => {
      document.removeEventListener("compositionstart", compositionStart);
      document.removeEventListener("compositionend", compositionEnd);
      document.removeEventListener("keydown", keydown);
    };
  }, [reviewForm]);
  const context = useMemo(() => ({ registerReviewForm, openGuide, dialogId, open }), [registerReviewForm, openGuide, dialogId, open]);
  const save = reviewButton(reviewForm, "save");
  const approve = reviewButton(reviewForm, "approve");
  return <ShortcutsContext value={context}>
    {children}
    <dialog ref={dialog} id={dialogId} className="review-dialog company-shortcuts-dialog" aria-labelledby={titleId}
      onCancel={event => { event.preventDefault(); setOpen(false); }}
      onKeyDown={event => {
        // This informational dialog has exactly one interactive control.
        if (event.key === "Tab") {
          event.preventDefault();
          event.currentTarget.querySelector<HTMLButtonElement>("button")?.focus();
        }
      }}>
      <h2 id={titleId}>{t("title")}</h2>
      <p>{t("traversal")}</p>
      {save || approve ? <dl>
        {save && <div><dt>{t("save")}</dt><dd><kbd>{t("saveKeys")}</kbd></dd></div>}
        {approve && <div><dt>{t("approve")}</dt><dd><kbd>{t("approveKeys")}</kbd></dd></div>}
      </dl> : <p>{t("unavailable")}</p>}
      <p>{t("safety")}</p>
      <div className="iv-row"><Button onClick={() => setOpen(false)} aria-label={t("close")}>{t("close")}</Button></div>
    </dialog>
  </ShortcutsContext>;
}

export function CompanyShortcutsTrigger() {
  const t = useTranslations("companyShortcuts");
  const shortcuts = useContext(ShortcutsContext);
  return <button type="button" className="notification-bell company-shortcuts-trigger" aria-label={t("title")}
    aria-haspopup="dialog" aria-controls={shortcuts?.dialogId} aria-expanded={shortcuts?.open ?? false}
    onClick={event => shortcuts?.openGuide(event.currentTarget)}>
    <ShellIcon path="M3 6h18v12H3zM6 9h1m3 0h1m3 0h1m3 0h0M6 12h1m3 0h1m3 0h1m3 0h0M7 15h10" />
  </button>;
}
