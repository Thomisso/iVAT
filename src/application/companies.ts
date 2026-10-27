import type { AppClient, Result } from "./client";

export type CompanyDetails = {
  name: string;
  ico: string;
  vatId: string;
  street: string;
  city: string;
  postalCode: string;
};

export type Company = CompanyDetails & { id: string; organizationId: string };

export type CompanySummary = { id: string; organizationId: string; name: string };

export type CreateCompanyInput = CompanyDetails & { organizationId: string };

export type CompanyDetailsError =
  | "name_required"
  | "invalid_ico"
  | "invalid_vat_id"
  | "address_required"
  | "invalid_postal_code";

export type CreateCompanyError = CompanyDetailsError | "ico_taken" | "forbidden";

function normalizeCompanyDetails(details: CompanyDetails): CompanyDetails {
  const digits = (value: string) => value.replace(/\s+/g, "");
  const postalCode = digits(details.postalCode);
  return {
    name: details.name.trim(),
    ico: digits(details.ico),
    vatId: digits(details.vatId).toUpperCase(),
    street: details.street.trim(),
    city: details.city.trim(),
    postalCode: /^\d{5}$/.test(postalCode) ? `${postalCode.slice(0, 3)} ${postalCode.slice(3)}` : postalCode,
  };
}

// Format checks only; registry and checksum validation belong to the Validation module.
function validateCompanyDetails(details: CompanyDetails): CompanyDetailsError | null {
  if (!details.name) return "name_required";
  if (!/^\d{8}$/.test(details.ico)) return "invalid_ico";
  if (!/^CZ\d{8,10}$/.test(details.vatId)) return "invalid_vat_id";
  if (!details.street || !details.city) return "address_required";
  if (!/^\d{3} \d{2}$/.test(details.postalCode)) return "invalid_postal_code";
  return null;
}

export async function createCompany(
  client: AppClient,
  input: CreateCompanyInput,
): Promise<Result<{ id: string }, CreateCompanyError>> {
  const details = normalizeCompanyDetails(input);
  const invalid = validateCompanyDetails(details);
  if (invalid) return { ok: false, error: invalid };

  const { data, error } = await client
    .from("company")
    .insert({
      organization_id: input.organizationId,
      name: details.name,
      ico: details.ico,
      vat_id: details.vatId,
      street: details.street,
      city: details.city,
      postal_code: details.postalCode,
    })
    .select("id")
    .single();
  if (error) {
    if (error.code === "42501") return { ok: false, error: "forbidden" };
    if (error.code === "23505") return { ok: false, error: "ico_taken" };
    throw error;
  }
  return { ok: true, value: { id: data.id } };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function getCompany(client: AppClient, companyId: string): Promise<Company | null> {
  if (!UUID.test(companyId)) return null;
  const { data, error } = await client
    .from("company")
    .select("id, organization_id, name, ico, vat_id, street, city, postal_code")
    .eq("id", companyId)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  return {
    id: data.id,
    organizationId: data.organization_id,
    name: data.name,
    ico: data.ico,
    vatId: data.vat_id,
    street: data.street,
    city: data.city,
    postalCode: data.postal_code,
  };
}

/** Companies the current user can access, directly or as Organization Administrator. */
export async function listMyCompanies(client: AppClient): Promise<CompanySummary[]> {
  const { data, error } = await client.from("company").select("id, organization_id, name").order("name");
  if (error) throw error;
  return data.map((c) => ({ id: c.id, organizationId: c.organization_id, name: c.name }));
}
