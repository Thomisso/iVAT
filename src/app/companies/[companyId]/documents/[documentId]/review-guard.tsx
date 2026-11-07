"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { Button } from "@/components/button";
import { isInitialReviewDocument, listenToReviewTraversal } from "@/components/review-history-bridge";

const DraftContext = createContext<{
  register: (form: HTMLFormElement, discard: () => void) => () => void;
  settled: (saved: boolean) => void;
  request: (intent: () => void) => void;
} | null>(null);
export const useReviewDraft = () => useContext(DraftContext);

// Read DOM values, including disabled controls and the visible Czech date.
// Auxiliary directory searches and operation receipts are not accounting edits.
function snapshot(form: HTMLFormElement) {
  const metadata = new Set(["companyId", "documentId", "basedOnVersion", "requestId", "displayedBankAccountCheckId", "displayedReviewContext", "acknowledgement", "nextDocumentId", "queueQuery", "returnTo"]);
  return JSON.stringify([...form.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>("input,select,textarea")]
    .filter(input => !metadata.has(input.name) && input.id !== "counterparty-search")
    .map((input, index) => [input.name || input.id || index, input.value, input instanceof HTMLInputElement && ["checkbox", "radio"].includes(input.type) ? input.checked : null]));
}

// Only public Navigation API identities are used; Next owns history.state.
type HistoryEntry = { key: string };
type BrowserNavigation = EventTarget & {
  currentEntry: HistoryEntry | null;
  entries: () => HistoryEntry[];
  traverseTo: (key: string) => { finished: Promise<unknown> };
};

export function ReviewGuard({ children }: { children: ReactNode }) {
  const t = useTranslations("review.departure");
  const router = useRouter();
  const form = useRef<HTMLFormElement | null>(null);
  const baseline = useRef("");
  const discardDraft = useRef<(() => void) | null>(null);
  const dirty = useRef(false);
  const intent = useRef<(() => void) | null>(null);
  const trigger = useRef<HTMLElement | null>(null);
  const bypass = useRef(false);
  const approvedUnload = useRef(false);
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);

  const request = useCallback((next: () => void) => {
    if (form.current?.getAttribute("aria-busy") === "true") return;
    if (form.current) dirty.current = snapshot(form.current) !== baseline.current;
    if (!dirty.current) { next(); return; }
    intent.current = next;
    trigger.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setFailed(false);
    setOpen(true);
  }, []);
  const register = useCallback((element: HTMLFormElement, discard: () => void) => {
    discardDraft.current = discard;
    form.current = element;
    baseline.current = snapshot(element);
    dirty.current = false;
    let frame = 0;
    const update = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => { dirty.current = snapshot(element) !== baseline.current; });
    };
    element.addEventListener("input", update);
    element.addEventListener("change", update);
    element.addEventListener("click", update);
    return () => {
      cancelAnimationFrame(frame);
      element.removeEventListener("input", update);
      element.removeEventListener("change", update);
      element.removeEventListener("click", update);
      if (form.current === element) { form.current = null; discardDraft.current = null; }
    };
  }, []);
  const settled = useCallback((saved: boolean) => {
    setSaving(false);
    if (!saved) { setFailed(true); return; }
    if (form.current) baseline.current = snapshot(form.current);
    dirty.current = false;
    const next = intent.current;
    intent.current = null;
    setOpen(false);
    if (next) queueMicrotask(next);
  }, []);
  useEffect(() => {
    const navigation = (window as Window & { navigation?: BrowserNavigation }).navigation;
    if (!navigation?.currentEntry) {
      // An imperative SPA redirect may bypass the root's incoming Link guard.
      // Establish the document boundary only before this draft has changed.
      if (!isInitialReviewDocument() && (!form.current || snapshot(form.current) === baseline.current) && form.current?.getAttribute("aria-busy") !== "true") location.replace(location.href);
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
      // A push/replace belongs to the rendered page. A traversal is only
      // accepted below, after deciding whether Next may replace that page.
      if ((event as Event & { navigationType: string }).navigationType !== "traverse" && !restoring) {
        source = navigation.currentEntry?.key ?? source;
      }
    };
    const stop = listenToReviewTraversal(event => {
      const key = navigation.currentEntry?.key;
      if (!key) return;
      if (key === allowed) { allowed = null; source = key; return; }
      allowed = null;
      if (form.current) dirty.current = snapshot(form.current) !== baseline.current;
      const busy = form.current?.getAttribute("aria-busy") === "true";
      if (!restoring && !dirty.current && !busy) { source = key; return; }
      event.stopImmediatePropagation();
      if (key === source) {
        restoring = false;
        const target = destination;
        destination = null;
        if (target && !busy) request(() => replay(target));
        return;
      }
      // A busy save keeps its existing departure intent. Otherwise the last
      // real browser request wins, including a second Back during rollback.
      if (!busy) destination = key;
      restoring = true;
      navigation.traverseTo(source).finished.catch(() => {
        // A rapid traversal can supersede compensation. Its popstate will
        // restore the same source; never authorize an unrelated destination.
      });
    });
    navigation.addEventListener("currententrychange", currentEntryChanged);
    return () => {
      stop();
      navigation.removeEventListener("currententrychange", currentEntryChanged);
    };
  }, [request]);
  useEffect(() => {
    const click = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const link = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>("a[href]") : null;
      if (!link || link.hasAttribute("download") || link.target && link.target !== "_self") return;
      const destination = new URL(link.href, location.href);
      if (!["http:", "https:"].includes(destination.protocol)) return;
      if (destination.href === location.href || destination.pathname === location.pathname && destination.search === location.search && destination.hash) return;
      if (form.current) dirty.current = snapshot(form.current) !== baseline.current;
      const nativeHistory = !(window as Window & { navigation?: unknown }).navigation;
      if (!nativeHistory && !dirty.current && form.current?.getAttribute("aria-busy") !== "true") return;
      event.preventDefault();
      event.stopPropagation();
      request(() => {
        if (!nativeHistory && destination.origin === location.origin) router.push(destination.pathname + destination.search + destination.hash);
        else { approvedUnload.current = true; location.assign(destination.href); }
      });
    };
    const submit = (event: SubmitEvent) => {
      if (bypass.current || event.target === form.current || !(event.target instanceof HTMLFormElement)) return;
      const other = event.target;
      if (!other.matches('[data-review-departure], .company-shell-menu form')) return;
      if (form.current) dirty.current = snapshot(form.current) !== baseline.current;
      if (!dirty.current && form.current?.getAttribute("aria-busy") !== "true") return;
      event.preventDefault();
      event.stopPropagation();
      const submitter = event.submitter;
      request(() => {
        bypass.current = true;
        try { other.requestSubmit(submitter instanceof HTMLButtonElement || submitter instanceof HTMLInputElement ? submitter : undefined); }
        finally { bypass.current = false; }
      });
    };
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (approvedUnload.current) return;
      if (form.current) dirty.current = snapshot(form.current) !== baseline.current;
      if (!dirty.current && form.current?.getAttribute("aria-busy") !== "true") return;
      event.preventDefault();
      event.returnValue = "";
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
  }, [request, router]);
  useEffect(() => {
    if (open) dialog.current?.showModal();
    else dialog.current?.close();
  }, [open]);
  const stay = () => {
    intent.current = null;
    dialog.current?.close();
    setOpen(false);
    trigger.current?.focus();
  };
  return <DraftContext value={{ register, settled, request }}>
    {children}
    <dialog ref={dialog} className="review-dialog" aria-labelledby="review-departure-title" onCancel={event => { event.preventDefault(); if (!saving) stay(); }}>
      <h2 id="review-departure-title">{t("title")}</h2>
      <p>{t("explanation")}</p>
      {failed && <p role="alert">{t("notSaved")}</p>}
      <div className="iv-row">
        <Button variant="primary" disabled={saving} onClick={() => {
          const current = form.current;
          if (!current || current.getAttribute("aria-busy") === "true") return;
          if (!current.checkValidity()) { setFailed(true); return; }
          const save = [...current.elements].find(element => element instanceof HTMLButtonElement && element.name === "intent" && element.value === "save") as HTMLButtonElement | undefined;
          if (save) { setSaving(true); current.requestSubmit(save); }
        }}>{t("save")}</Button>
        <Button disabled={saving} onClick={() => {
          discardDraft.current?.();
          dirty.current = false;
          const next = intent.current;
          intent.current = null;
          setOpen(false);
          next?.();
        }}>{t("discard")}</Button>
        <Button autoFocus disabled={saving} onClick={stay}>{t("stay")}</Button>
      </div>
    </dialog>
  </DraftContext>;
}
