import type { AppClient } from "./client";
import { listMyCompanies, type CompanySummary } from "./companies";

export type RememberedCompanyContext = {
  userId: string;
  companyId: string;
};

export type CompanyContext =
  | { kind: "company"; companyId: string }
  | { kind: "chooser"; companies: CompanySummary[] };

/**
 * Resolves the operational Company for the current User. The remembered value
 * is only a preference: it is bound to the User and revalidated through RLS on
 * every landing before it can select a Company.
 */
export async function resolveCompanyContext(
  client: AppClient,
  remembered: RememberedCompanyContext | null,
): Promise<CompanyContext> {
  const companies = await listMyCompanies(client);
  if (companies.length === 1) {
    return { kind: "company", companyId: companies[0].id };
  }
  if (remembered) {
    const { data } = await client.auth.getUser();
    if (
      data.user?.id === remembered.userId
      && companies.some((company) => company.id === remembered.companyId)
    ) {
      return { kind: "company", companyId: remembered.companyId };
    }
  }
  return { kind: "chooser", companies };
}
