import { orderedDirectoryLinkRace } from "./counterparty-link-race";

/** Queue real authenticated commands at the Company's existing deletion lock. */
export async function directoryMutationAfterCompanyDeletion(
  companyId: string,
  removeCompany: () => Promise<unknown>,
  mutateDirectory: () => Promise<unknown>,
) {
  return orderedDirectoryLinkRace(companyId,
    { query: "soft_delete_company", run: removeCompany },
    { query: "counterparty", run: mutateDirectory },
  );
}
