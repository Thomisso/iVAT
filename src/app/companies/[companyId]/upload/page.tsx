import Link from "next/link";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { getCompany, getMyCompanyRole } from "@/application/companies";
import { requireUserClient } from "@/lib/supabase/server";

export default async function UploadPage({ params }: PageProps<"/companies/[companyId]/upload">) {
  const { companyId } = await params;
  const client = await requireUserClient();
  const [company, role, t, ai] = await Promise.all([
    getCompany(client, companyId),
    getMyCompanyRole(client, companyId),
    getTranslations("shell"),
    getTranslations("aiProcessing"),
  ]);
  if (!company) notFound();
  return <main className="company-workspace">
    <header className="company-page-header"><h1>{t("uploadTitle")}</h1><p>{t("uploadDescription")}</p></header>
    {!company.aiProcessing && <section className="panel" role="status">
      <h2>{ai("waitingTitle")}</h2>
      <p>{ai("waitingReason")}</p>
      {role === "administrator" && <Link href={`/companies/${companyId}/settings`}>{ai("configureAction")}</Link>}
    </section>}
    <section className="company-workspace-empty"><span aria-hidden="true" /><p>{t("workspaceComing")}</p></section>
  </main>;
}
