"use client";

import { createContext, useCallback, useContext, useState, type ReactNode } from "react";
import { useTranslations } from "next-intl";
import type { ExtractionPayload } from "@/application/extraction-payload";
import { Icon } from "@/components/icon";

const SourceContext = createContext<{
  payload: ExtractionPayload; version: number; versionId: string;
  selection: number; acceptBase: (payload: ExtractionPayload, version: number, versionId: string) => void;
  selectedField: string | null; selectField: (field: string, focus?: boolean) => void;
} | null>(null);

/** The reference belongs to the same mounted draft base as the financial form. */
export function SourceEvidenceProvider({ payload, version, versionId, children }: {
  payload: ExtractionPayload; version: number; versionId: string; children: ReactNode;
}) {
  const [base, setBase] = useState({ payload, version, versionId });
  const [selectedField, setSelectedField] = useState<string | null>(null);
  const [selection, setSelection] = useState(0);
  const acceptBase = useCallback((payload: ExtractionPayload, version: number, versionId: string) => setBase({ payload, version, versionId }), []);
  function selectField(field: string, focus = false) {
    setSelectedField(field);
    setSelection((value) => value + 1);
    if (focus) {
      const wrapper = [...document.querySelectorAll<HTMLElement>("[data-source-field]")].find((node) => node.dataset.sourceField === field);
      const input = wrapper?.querySelector<HTMLElement>("input:not([type=hidden]):not(:disabled),select:not(:disabled)");
      (input ?? wrapper)?.focus({ preventScroll: true });
      wrapper?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }
  }
  return <SourceContext value={{ ...base, selectedField, selectField, selection, acceptBase }}>{children}</SourceContext>;
}

export const useSourceEvidence = () => useContext(SourceContext);

export function useSourceFieldLabel() {
  const t = useTranslations("review");
  return (field: string) => {
    const leaf = field.split(".").at(-1)!;
    const key = field.startsWith("totals.") ? ({ netAmount: "totalNet", vatAmount: "totalVat", grossAmount: "totalGross" }[leaf] ?? leaf) : leaf;
    return t(`fields.${key}`);
  };
}

export function SourceField({ field, children }: { field: string; children: ReactNode }) {
  const source = useSourceEvidence();
  const t = useTranslations("review");
  const label = useSourceFieldLabel();
  const reference = source?.payload.sourceEvidence?.fields[field];
  return <div data-source-field={field} tabIndex={0}
    className={`source-field ${source?.selectedField === field ? "is-selected" : ""}`}
    onFocusCapture={() => source?.selectField(field)}>
    {children}
    {reference && <button type="button" className="source-field-link" aria-label={t("sourceFor", { field: label(field) })}
      onClick={() => source?.selectField(field)}><Icon name="marker" /></button>}
    {reference?.origin === "manual" && <small className="source-manual">{t("sourceManual")} · {t("sourceOriginalValue", { value: reference.originalValue })}</small>}
  </div>;
}
