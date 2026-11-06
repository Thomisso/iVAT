"use client";

import { createContext, useContext, useState, type ReactNode } from "react";

type CurrentExportContext = {
  details: Record<string, string>;
  update: (values: Record<string, string>) => void;
  reset: () => void;
};
const ExportContext = createContext<CurrentExportContext | null>(null);

/** Each statutory output owns request-only edits, shared by its XML, PDF and
 * thumbnail controls. Nothing here persists into Company filing defaults. */
export function ExportContextProvider({ preparedOn, children }: { preparedOn: string; children: ReactNode }) {
  const [details, setDetails] = useState<Record<string, string>>({ preparedOn });
  return <ExportContext value={{
    details,
    update: values => setDetails(current => ({ ...current, ...values })),
    reset: () => setDetails(current => ({ preparedOn: current.preparedOn })),
  }}>{children}</ExportContext>;
}

export function useCurrentExportContext() {
  return useContext(ExportContext);
}
