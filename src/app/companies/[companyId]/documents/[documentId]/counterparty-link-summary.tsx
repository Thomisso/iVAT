"use client";

import Link from "next/link";
import { useTranslations } from "next-intl";
import type { ExtractionPayload } from "@/application/extraction-payload";

/** Recorded details belong to this Version, even when the directory changes. */
export function CounterpartyLinkSummary({ companyId, link }: { companyId: string; link: ExtractionPayload["counterpartyLink"] }) {
  const t = useTranslations("review");
  if (!link?.recorded) return <p>{t("directory.notRecorded")}</p>;
  return <section aria-label={t("directory.recorded")}>
    <h3>{t("directory.recorded")}</h3>
    <Link href={`/companies/${companyId}/counterparties/${link.id}`}>{t("directory.open")}</Link>
    <dl>{Object.entries(link.recorded).map(([field, value]) => <div key={field}>
      <dt>{t(`fields.${field}`)}</dt><dd>{value || t("notSet")}</dd>
    </div>)}</dl>
  </section>;
}
