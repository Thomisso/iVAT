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

function isIdentified(party: Party): boolean {
  return [party.name, party.ico, party.vatId].some((value) => value?.trim());
}

/**
 * Company identity, then the narrow receipt fallback, decides the Direction;
 * null when neither does, which leaves a blocking finding for the User.
 */
export function detectDocumentDirection(
  payload: ExtractionPayload,
  company: CompanyIdentity,
): Direction | null {
  const supplierMatches = matchesCompany(payload.supplier, company);
  const customerMatches = matchesCompany(payload.customer, company);
  if (supplierMatches !== customerMatches) return supplierMatches ? "outgoing" : "incoming";
  if (
    !supplierMatches &&
    (payload.documentType === "receipt" || payload.documentType === "simplified_tax_document") &&
    isIdentified(payload.supplier)
  ) return "incoming";
  return null;
}
