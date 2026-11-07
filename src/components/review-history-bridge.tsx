"use client";

import { useLayoutEffect } from "react";

type TraversalListener = (event: PopStateEvent) => void;
let listener: TraversalListener | null = null;
let initialDocumentUrl: string | null = null;

export function isInitialReviewDocument() {
  if (!initialDocumentUrl) return true;
  const initial = new URL(initialDocumentUrl);
  return initial.pathname === location.pathname && initial.search === location.search;
}

export function listenToReviewTraversal(next: TraversalListener) {
  listener = next;
  return () => { if (listener === next) listener = null; };
}

/** Register before App Router, including when a review is opened by a Link.
 * In the verified Next/Chromium runtime a late capture listener ran after Next's
 * target listener: rollback restored the URL after the form was already lost.
 */
export function ReviewHistoryBridge() {
  useLayoutEffect(() => {
    initialDocumentUrl ??= location.href;
    const enterReview = (event: MouseEvent) => {
      // Without entry keys, make review entries separate documents so browser
      // traversal uses beforeunload. The mounted review owns its own choices.
      if ((window as Window & { navigation?: unknown }).navigation || listener) return;
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const link = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>("a[href]") : null;
      if (!link || link.hasAttribute("download") || link.target && link.target !== "_self") return;
      const destination = new URL(link.href, location.href);
      if (destination.origin !== location.origin || !/^\/companies\/[^/]+\/documents\/[^/]+$/.test(destination.pathname)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      location.assign(destination.href);
    };
    const traverse = (event: PopStateEvent) => listener?.(event);
    window.addEventListener("popstate", traverse, true);
    window.addEventListener("click", enterReview, true);
    return () => {
      window.removeEventListener("popstate", traverse, true);
      window.removeEventListener("click", enterReview, true);
    };
  }, []);
  return null;
}
