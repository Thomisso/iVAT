import Link from "next/link";
import { getTranslations } from "next-intl/server";
import type { SourceFileReadiness } from "@/application/reporting-period-readiness";
import { withCompanyReturnTo } from "@/application/return-context";

/** Source work has its own identity and resolution, independent of Document counts. */
export async function SourceReadinessList({ companyId, sources, returnTo }: { companyId: string; sources: SourceFileReadiness[]; returnTo?: string }) {
  const t = await getTranslations();
  if (!sources.length) return null;
  return <section>
    <h3>{t("sourceFiles.readinessTitle")}</h3>
    <ul>{sources.map((source) => <li key={source.sourceFileId}>
      <Link href={withCompanyReturnTo(companyId, `/companies/${companyId}/source-files/${source.sourceFileId}`, returnTo)}>{source.fileName}</Link>
      {" · "}{t(`sourceFileStatus.${source.status}`)}{source.exclusionReason && <> · {source.exclusionReason}</>}
    </li>)}</ul>
  </section>;
}
