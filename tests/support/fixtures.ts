import { createCompany, type CompanyDetails } from "@/application/companies";
import { signedUpUser } from "./clients";

let icoCounter = 0;

/** A random but well-formed set of Company details. */
export function companyDetails(overrides: Partial<CompanyDetails> = {}): CompanyDetails {
  const ico = String(10_000_000 + ((Date.now() + icoCounter++) % 89_999_999)).slice(0, 8);
  return {
    name: "Novák s.r.o.",
    ico,
    vatId: `CZ${ico}`,
    street: "Vinohradská 12",
    city: "Praha",
    postalCode: "120 00",
    ...overrides,
  };
}

/** A signed-up Organization Administrator whose Organization holds one Company. */
export async function administratorWithCompany(organizationName = "Test Organization") {
  const user = await signedUpUser(organizationName);
  const result = await createCompany(user.client, { organizationId: user.organizationId, ...companyDetails() });
  if (!result.ok) throw new Error(`Company creation failed: ${result.error}`);
  return { ...user, companyId: result.value.id };
}
