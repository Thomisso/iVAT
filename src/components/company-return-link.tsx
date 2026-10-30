import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { companyReturnDestination, safeCompanyReturnTo } from "@/application/return-context";

export async function CompanyReturnLink({ companyId, returnTo, fallback }: { companyId: string; returnTo?: unknown; fallback: string }) {
  const href = safeCompanyReturnTo(companyId, returnTo) ?? fallback;
  const destination = companyReturnDestination(companyId, href) ?? "documents";
  const t = await getTranslations("returnContext");
  return <Link href={href}>{t(destination)}</Link>;
}
