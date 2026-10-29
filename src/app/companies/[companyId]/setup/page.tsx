import { notFound, redirect } from "next/navigation";
import { getCompany, getCompanySetupChecklist } from "@/application/companies";
import { requireUserClient } from "@/lib/supabase/server";

/** Resumes an interrupted setup at its first required incomplete step. */
export default async function CompanySetupPage({ params }: PageProps<"/companies/[companyId]/setup">) {
  const { companyId } = await params;
  const client = await requireUserClient();
  const [company, checklist] = await Promise.all([
    getCompany(client, companyId),
    getCompanySetupChecklist(client, companyId),
  ]);
  if (!company) notFound();
  const firstBlocking = checklist.find((item) => item.state === "blocking");
  if (firstBlocking?.step === "identity") redirect(`/companies/${companyId}/settings`);
  if (firstBlocking?.step === "filing_frequency") redirect(`/companies/${companyId}/setup/filing-frequency`);
  redirect(`/companies/${companyId}`);
}
