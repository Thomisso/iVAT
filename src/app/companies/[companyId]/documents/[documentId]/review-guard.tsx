"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { Button } from "@/components/button";
import { isInitialReviewDocument, listenToReviewTraversal } from "@/components/review-history-bridge";

type ReviewForm = "correction" | "reporting";
type RegisteredDraft = { form: HTMLFormElement; baseline: string; discard: () => void };
const DraftContext = createContext<{
  register: (form: HTMLFormElement, discard: () => void) => () => void;
  registerReporting: (form: HTMLFormElement, discard: () => void) => () => void;
  settled: (saved: boolean) => void;
  reportingSettled: (saved: boolean) => void;
  pending: boolean;
  setPending: (kind: ReviewForm, pending: boolean) => void;
  request: (intent: () => void) => void;
} | null>(null);
export const useReviewDraft = () => useContext(DraftContext);

// Read actual form owners, including disabled controls and visible Czech dates.
// Operation receipts, framework metadata and directory searches are not edits.
function snapshot(form: HTMLFormElement) {
  const metadata = new Set(["companyId", "documentId", "basedOnVersion", "requestId", "displayedBankAccountCheckId", "displayedReviewContext", "acknowledgement", "nextDocumentId", "queueQuery", "returnTo"]);
  return JSON.stringify([...form.elements]
    .filter((input): input is HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement => input instanceof HTMLInputElement || input instanceof HTMLSelectElement || input instanceof HTMLTextAreaElement)
    .filter(input => !metadata.has(input.name) && !input.name.startsWith("$ACTION") && input.id !== "counterparty-search")
    .map((input, index) => [input.name || input.id || index, input.value, input instanceof HTMLInputElement && ["checkbox", "radio"].includes(input.type) ? input.checked : null]));
}

type HistoryEntry = { key: string };
type BrowserNavigation = EventTarget & {
  currentEntry: HistoryEntry | null;
  entries: () => HistoryEntry[];
  traverseTo: (key: string) => { finished: Promise<unknown> };
};

export function ReviewGuard({ children }: { children: ReactNode }) {
  const t = useTranslations("review.departure");
  const router = useRouter();
  const drafts = useRef<Record<ReviewForm, RegisteredDraft | null>>({ correction: null, reporting: null });
  const intent = useRef<(() => void) | null>(null);
  const trigger = useRef<HTMLElement | null>(null);
  const bypass = useRef(false);
  const approvedUnload = useRef(false);
  const savingRef = useRef(false);
  const saveQueue = useRef<ReviewForm[] | null>(null);
  const activeSave = useRef<ReviewForm | null>(null);
  const scope = useRef<"all" | "reporting">("all");
  const [reportingApproval, setReportingApproval] = useState(false);
  const [pendingForms, setPendingForms] = useState({ correction: false, reporting: false });
  const [saveRevision, setSaveRevision] = useState(0);
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const pending = pendingForms.correction || pendingForms.reporting;
  const setPending = useCallback((kind: ReviewForm, value: boolean) => {
    setPendingForms(previous => previous[kind] === value ? previous : { ...previous, [kind]: value });
  }, []);
  const dirtyForms = useCallback((onlyReporting = false): ReviewForm[] =>
    (onlyReporting ? ["reporting"] as const : ["correction", "reporting"] as const).filter(kind => {
      const draft = drafts.current[kind];
      return draft !== null && snapshot(draft.form) !== draft.baseline;
    }), []);
  const busy = useCallback(() => savingRef.current || Object.values(drafts.current).some(draft => draft?.form.getAttribute("aria-busy") === "true"), []);
  const requestDeparture = useCallback((next: () => void, onlyReporting = false) => {
    if (busy()) return;
    if (!dirtyForms(onlyReporting).length) { next(); return; }
    intent.current = next;
    scope.current = onlyReporting ? "reporting" : "all";
    setReportingApproval(onlyReporting);
    if (!dialog.current?.open) trigger.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setFailed(false);
    setOpen(true);
  }, [busy, dirtyForms]);
  const request = useCallback((next: () => void) => requestDeparture(next), [requestDeparture]);
  const registerForm = useCallback((kind: ReviewForm, form: HTMLFormElement, discard: () => void) => {
    const draft = { form, baseline: snapshot(form), discard };
    drafts.current[kind] = draft;
    return () => { if (drafts.current[kind] === draft) drafts.current[kind] = null; };
  }, []);
  const register = useCallback((form: HTMLFormElement, discard: () => void) => registerForm("correction", form, discard), [registerForm]);
  const registerReporting = useCallback((form: HTMLFormElement, discard: () => void) => registerForm("reporting", form, discard), [registerForm]);
  const formSettled = useCallback((kind: ReviewForm, saved: boolean) => {
    const draft = drafts.current[kind];
    if (saved && draft) draft.baseline = snapshot(draft.form);
    if (activeSave.current !== kind) return;
    activeSave.current = null;
    if (!saved) {
      saveQueue.current = null;
      savingRef.current = false;
      setSaving(false);
      setFailed(true);
      return;
    }
    saveQueue.current?.shift();
    setSaveRevision(previous => previous + 1);
  }, []);
  const settled = useCallback((saved: boolean) => formSettled("correction", saved), [formSettled]);
  const reportingSettled = useCallback((saved: boolean) => formSettled("reporting", saved), [formSettled]);
  useEffect(() => {
    if (!saveQueue.current || activeSave.current || pending) return;
    const kind = saveQueue.current[0];
    if (!kind) {
      saveQueue.current = null;
      savingRef.current = false;
      setSaving(false);
      const next = intent.current;
      intent.current = null;
      dialog.current?.close();
      setOpen(false);
      if (next) queueMicrotask(next);
      return;
    }
    const form = drafts.current[kind]?.form;
    const button = form && [...form.elements].find(element => element instanceof HTMLButtonElement && (kind === "reporting" ? element.type === "submit" : element.name === "intent" && element.value === "save")) as HTMLButtonElement | undefined;
    if (!form || !button) { saveQueue.current = null; savingRef.current = false; setSaving(false); setFailed(true); return; }
    activeSave.current = kind;
    form.requestSubmit(button);
  }, [saveRevision, pending]);
  useEffect(() => {
    const navigation = (window as Window & { navigation?: BrowserNavigation }).navigation;
    if (!navigation?.currentEntry) {
      if (!isInitialReviewDocument() && !dirtyForms().length && !busy()) location.replace(location.href);
      return listenToReviewTraversal(() => {});
    }
    let source = navigation.currentEntry.key;
    let restoring = false;
    let destination: string | null = null;
    let allowed: string | null = null;
    const replay = (key: string) => {
      if (!navigation.entries().some(entry => entry.key === key)) return;
      allowed = key;
      navigation.traverseTo(key).finished.catch(() => { if (allowed === key) allowed = null; });
    };
    const currentEntryChanged = (event: Event) => {
      if ((event as Event & { navigationType: string }).navigationType !== "traverse" && !restoring) source = navigation.currentEntry?.key ?? source;
    };
    const stop = listenToReviewTraversal(event => {
      const key = navigation.currentEntry?.key;
      if (!key) return;
      if (key === allowed) { allowed = null; source = key; return; }
      allowed = null;
      const savingNow = busy();
      if (!restoring && !dirtyForms().length && !savingNow) { source = key; return; }
      event.stopImmediatePropagation();
      if (key === source) {
        restoring = false;
        const target = destination;
        destination = null;
        if (target && !savingNow) request(() => replay(target));
        return;
      }
      if (!savingNow) destination = key;
      restoring = true;
      navigation.traverseTo(source).finished.catch(() => { /* A rapid request can supersede compensation; its popstate restores the same source. */ });
    });
    navigation.addEventListener("currententrychange", currentEntryChanged);
    return () => { stop(); navigation.removeEventListener("currententrychange", currentEntryChanged); };
  }, [request, busy, dirtyForms]);
  useEffect(() => {
    const click = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const link = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>("a[href]") : null;
      if (!link || link.hasAttribute("download") || link.target && link.target !== "_self") return;
      const destination = new URL(link.href, location.href);
      if (!["http:", "https:"].includes(destination.protocol)) return;
      if (destination.href === location.href || destination.pathname === location.pathname && destination.search === location.search && destination.hash) return;
      const nativeHistory = !(window as Window & { navigation?: unknown }).navigation;
      if (!nativeHistory && !dirtyForms().length && !busy()) return;
      event.preventDefault(); event.stopPropagation();
      request(() => {
        if (!nativeHistory && destination.origin === location.origin) router.push(destination.pathname + destination.search + destination.hash);
        else { approvedUnload.current = true; location.assign(destination.href); }
      });
    };
    const submit = (event: SubmitEvent) => {
      if (bypass.current || !(event.target instanceof HTMLFormElement)) return;
      const form = event.target;
      const correction = drafts.current.correction?.form;
      const reporting = drafts.current.reporting?.form;
      if (form === correction || form === reporting) {
        const kind = form === correction ? "correction" : "reporting";
        if (activeSave.current === kind) return;
        if (busy()) { event.preventDefault(); event.stopPropagation(); return; }
        if (kind === "correction" && event.submitter instanceof HTMLButtonElement && event.submitter.value === "approve" && dirtyForms(true).length) {
          event.preventDefault(); event.stopPropagation();
          requestDeparture(() => {
            const current = drafts.current.correction?.form;
            const approve = current && [...current.elements].find(element => element instanceof HTMLButtonElement && element.name === "intent" && element.value === "approve") as HTMLButtonElement | undefined;
            if (current && approve) { bypass.current = true; try { current.requestSubmit(approve); } finally { bypass.current = false; } }
          }, true);
        }
        return;
      }
      if (!form.matches('[data-review-departure], .company-shell-menu form') || !dirtyForms().length && !busy()) return;
      event.preventDefault(); event.stopPropagation();
      const submitter = event.submitter;
      request(() => {
        bypass.current = true;
        try { form.requestSubmit(submitter instanceof HTMLButtonElement || submitter instanceof HTMLInputElement ? submitter : undefined); }
        finally { bypass.current = false; }
      });
    };
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (approvedUnload.current || !dirtyForms().length && !busy()) return;
      event.preventDefault(); event.returnValue = "";
    };
    const resumed = () => { approvedUnload.current = false; };
    window.addEventListener("pageshow", resumed);
    document.addEventListener("click", click, true);
    document.addEventListener("submit", submit, true);
    window.addEventListener("beforeunload", beforeUnload);
    return () => {
      window.removeEventListener("pageshow", resumed);
      document.removeEventListener("click", click, true);
      document.removeEventListener("submit", submit, true);
      window.removeEventListener("beforeunload", beforeUnload);
    };
  }, [request, requestDeparture, router, busy, dirtyForms]);
  useEffect(() => { if (open) dialog.current?.showModal(); else dialog.current?.close(); }, [open]);
  const stay = () => { intent.current = null; dialog.current?.close(); setOpen(false); trigger.current?.focus(); };
  return <DraftContext value={{ register, registerReporting, settled, reportingSettled, pending, setPending, request }}>
    {children}
    <dialog ref={dialog} className="review-dialog" aria-labelledby="review-departure-title" onCancel={event => { event.preventDefault(); if (!saving) stay(); }}>
      <h2 id="review-departure-title">{t(reportingApproval ? "reportingTitle" : "title")}</h2>
      <p>{t(reportingApproval ? "reportingExplanation" : "explanation")}</p>
      {failed && <p role="alert">{t("notSaved")}</p>}
      <div className="iv-row">
        <Button variant="primary" disabled={saving} onClick={() => {
          if (busy()) return;
          const changed = dirtyForms(scope.current === "reporting");
          if (changed.some(kind => !drafts.current[kind]?.form.checkValidity())) { setFailed(true); return; }
          savingRef.current = true;
          setSaving(true);
          saveQueue.current = changed;
          setSaveRevision(previous => previous + 1);
        }}>{t(reportingApproval ? "reportingSave" : "save")}</Button>
        <Button disabled={saving} onClick={() => {
          for (const kind of dirtyForms(scope.current === "reporting")) drafts.current[kind]?.discard();
          const next = intent.current;
          intent.current = null;
          dialog.current?.close();
          setOpen(false);
          next?.();
        }}>{t(reportingApproval ? "reportingDiscard" : "discard")}</Button>
        <Button autoFocus disabled={saving} onClick={stay}>{t("stay")}</Button>
      </div>
    </dialog>
  </DraftContext>;
}
