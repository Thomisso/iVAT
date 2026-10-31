import cs from "../../messages/cs.json";
import en from "../../messages/en.json";
import type { ReportingPeriodWorkbookCopy } from "@/application/reporting-period-excel";

export function reportingWorkbookCopy(locale: "cs" | "en" = "en"): ReportingPeriodWorkbookCopy {
  const messages = locale === "cs" ? cs : en;
  const workbook = messages.reportingWorkbook;
  const reporting = messages.documentReporting;
  return {
    ...workbook,
    reasons: reporting.reasons, details: reporting.details, unknownReasons: reporting.unknownReasons,
  };
}
