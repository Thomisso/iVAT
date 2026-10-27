import type { Result } from "./client";

export type AresCompanyDetails = {
  name: string;
  ico: string;
  vatId: string;
  street: string;
  city: string;
  postalCode: string;
};

export type AresLookupError = "ares_company_not_found" | "ares_unavailable";

/** External registry seam; application tests inject a deterministic fake. */
export interface AresRegistry {
  findByIco(ico: string): Promise<Result<AresCompanyDetails, AresLookupError>>;
}

export async function prefillCompanyFromAres(
  registry: AresRegistry,
  rawIco: string,
): Promise<Result<AresCompanyDetails, AresLookupError | "invalid_ico">> {
  const ico = rawIco.replace(/\s+/g, "");
  if (!/^\d{8}$/.test(ico)) return { ok: false, error: "invalid_ico" };
  return registry.findByIco(ico);
}
