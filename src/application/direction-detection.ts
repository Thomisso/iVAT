import type { Direction, ExtractionPayload, Party } from "./extraction-payload";

export type CompanyIdentity = { ico: string; vatId: string };

const normalizedIco = (value: string | null) => value?.replace(/\s+/g, "") ?? "";
const normalizedVatId = (value: string | null) =>
  value?.replace(/\s+/g, "").toUpperCase() ?? "";

function matchesCompany(party: Party, company: CompanyIdentity): boolean {
  const ico = normalizedIco(party.ico);
  const vatId = normalizedVatId(party.vatId);
  return (
    (ico !== "" && ico === normalizedIco(company.ico)) ||
    (vatId !== "" && vatId === normalizedVatId(company.vatId))
  );
}

/** Upload intent wins; otherwise exactly one party must match the Company. */
export function detectDocumentDirection(
  payload: ExtractionPayload,
  company: CompanyIdentity,
  preselectedDirection: Direction | null,
): Direction | null {
  if (preselectedDirection) return preselectedDirection;
  const supplierMatches = matchesCompany(payload.supplier, company);
  const customerMatches = matchesCompany(payload.customer, company);
  if (supplierMatches === customerMatches) return null;
  return supplierMatches ? "outgoing" : "incoming";
}
