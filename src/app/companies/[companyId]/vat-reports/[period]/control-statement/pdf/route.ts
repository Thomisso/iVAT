import { getTranslations } from "next-intl/server";
import {
  exportControlStatementPdf,
  type ControlStatementPdfCopy,
} from "@/application/control-statement-pdf";
import { downloadResponse, refusalResponse } from "@/lib/route-responses";
import { requireUserClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

export async function GET(
  _request: Request,
  context: RouteContext<
    "/companies/[companyId]/vat-reports/[period]/control-statement/pdf"
  >,
) {
  const { companyId, period } = await context.params;
  const [client, t] = await Promise.all([
    requireUserClient(),
    getTranslations("vatReports.controlStatementPdf"),
  ]);
  const copy = {
    title: t("title"),
    vatId: t("vatId"),
    ico: t("ico"),
    address: t("address"),
    reportingPeriod: t("reportingPeriod"),
    document: t("document"),
    counterpartyVatId: t("counterpartyVatId"),
    counterpartyCountry: t("counterpartyCountry"),
    taxPointDate: t("taxPointDate"),
    supplyCode: t("supplyCode"),
    section: t("section"),
    rate: t("rate"),
    taxBaseCzk: t("taxBaseCzk"),
    vatCzk: t("vatCzk"),
    sectionTotals: t("sectionTotals"),
    noEntries: t("noEntries"),
    statementTotals: t("statementTotals"),
    subject: t("subject"),
  } satisfies ControlStatementPdfCopy;
  const result = await exportControlStatementPdf(
    client,
    { companyId, period },
    copy,
  );
  if (!result.ok) {
    const t = await getTranslations("errors");
    return refusalResponse(result.error, {
      status: 404,
      message: t(result.error),
    });
  }
  return downloadResponse(result.value);
}
