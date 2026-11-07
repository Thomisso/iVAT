"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useTranslations } from "next-intl";
import { Button } from "@/components/button";

const WorkspaceContext = createContext<{ target: HTMLDivElement | null; showData: () => void } | null>(null);
export const useReviewWorkspace = () => useContext(WorkspaceContext);

export function ReviewActions({ children, kind }: { children: ReactNode; kind: "approve" | "reject" | "save" }) {
  const workspace = useReviewWorkspace();
  const content = <div className={`review-action-${kind}`}>{children}</div>;
  return workspace?.target ? createPortal(content, workspace.target) : content;
}

export function ReviewWorkspace({ children }: { children: ReactNode }) {
  const t = useTranslations("review.workspace");
  const [target, setTarget] = useState<HTMLDivElement | null>(null);
  const [view, setView] = useState("data");
  const [ratio, setRatio] = useState(50);
  const frame = useRef<HTMLElement>(null);
  const bounds = useRef({ min: 30, max: 70 });
  const showData = useCallback(() => setView("data"), []);
  useEffect(() => {
    if (!frame.current) return;
    const observer = new ResizeObserver(([entry]) => {
      const width = entry.contentRect.width - 12;
      const min = Math.min(50, 360 / width * 100);
      const max = Math.max(50, 100 - 420 / width * 100);
      bounds.current = { min, max };
      setRatio(current => Math.min(max, Math.max(min, current)));
    });
    observer.observe(frame.current);
    return () => observer.disconnect();
  }, []);
  const adjust = (value: number) => setRatio(Math.min(bounds.current.max, Math.max(bounds.current.min, value)));
  return <WorkspaceContext value={{ target, showData }}>
    <main ref={frame} className="app-page app-page-wide review review-workspace" data-mobile-view={view} style={{ "--review-columns": `minmax(0, ${ratio}fr) 12px minmax(0, ${100 - ratio}fr)` } as CSSProperties}>
      {children}
      <div className="review-mobile-tabs" role="group" aria-label={t("view")}>
        <Button aria-pressed={view === "source"} onClick={() => setView("source")}>{t("source")}</Button>
        <Button aria-pressed={view === "data"} onClick={showData}>{t("data")}</Button>
      </div>
      <div className="review-splitter" role="separator" tabIndex={0} aria-label={t("resize")} aria-orientation="vertical" aria-valuemin={Math.round(bounds.current.min)} aria-valuemax={Math.round(bounds.current.max)} aria-valuenow={Math.round(ratio)}
        onPointerDown={event => { event.preventDefault(); event.currentTarget.focus(); event.currentTarget.setPointerCapture(event.pointerId); }}
        onPointerMove={event => {
          if (!event.currentTarget.hasPointerCapture(event.pointerId) || !frame.current) return;
          const box = frame.current.getBoundingClientRect();
          const padding = Number.parseFloat(getComputedStyle(frame.current).paddingLeft);
          adjust((event.clientX - box.left - padding) / (box.width - padding * 2 - 12) * 100);
        }}
        onPointerUp={event => { if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); }}
        onKeyDown={event => {
          const next = event.key === "ArrowLeft" ? ratio - 2 : event.key === "ArrowRight" ? ratio + 2 : event.key === "Home" ? bounds.current.min : event.key === "End" ? bounds.current.max : null;
          if (next !== null) { event.preventDefault(); adjust(next); }
        }} />
      <div ref={setTarget} className="review-actions" role="group" aria-label={t("decisions")} />
    </main>
  </WorkspaceContext>;
}
