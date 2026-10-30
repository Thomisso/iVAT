import { isUuid, type AppClient, type Result } from "./client";
import { epoIdentityFindings } from "./companies";
import { TAX_OFFICES, type ExportDetails } from "./epo-export-details";
import { isEconomicActivity, isTerritorialOffice } from "./epo-catalogues";

export type EpoAddress = NonNullable<ExportDetails["address"]>;
export type ResolvedEpoAddress = {
  address: EpoAddress;
  source: "registered" | "confirmed_override";
};

export type CompanyFilingDefaults = {
  taxOffice: string | null;
  economicActivity: string | null;
  territorialOffice: string | null;
  signatoryFirstName: string | null;
  signatoryLastName: string | null;
  signatoryCapacity: string | null;
  email: string | null;
  phone: string | null;
  epoAddressOverride: EpoAddress | null;
};

export type SaveCompanyFilingDefaultsInput = Omit<CompanyFilingDefaults, "taxOffice" | "economicActivity" | "territorialOffice" | "signatoryFirstName" | "signatoryLastName" | "signatoryCapacity" | "email" | "phone"> & {
  companyId: string;
  taxOffice: string;
  economicActivity?: string;
  territorialOffice?: string;
  signatoryFirstName: string;
  signatoryLastName: string;
  signatoryCapacity: string;
  email: string;
  phone: string;
  epoAddressConfirmed?: boolean;
};

export type CompanyFilingDefaultsError =
  | "forbidden"
  | "invalid_filing_defaults"
  | "epo_override_not_required"
  | "epo_override_confirmation_required";

const optional = (value: string) => value.trim() || null;

/** Resolves the exact address serialized into EPO XML, without truncating registered identity. */
export function resolveEpoAddress(
  registeredAddress: EpoAddress,
  defaults: CompanyFilingDefaults | null,
): Result<ResolvedEpoAddress, "epo_address_required"> {
  if (epoIdentityFindings(registeredAddress).length === 0) {
    return { ok: true, value: { address: registeredAddress, source: "registered" } };
  }
  if (defaults?.epoAddressOverride) {
    return {
      ok: true,
      value: { address: defaults.epoAddressOverride, source: "confirmed_override" },
    };
  }
  return { ok: false, error: "epo_address_required" };
}

function validAddress(address: EpoAddress): boolean {
  return address.streetName.trim().length > 0
    && address.streetName.trim().length <= 38
    && /^\d{1,6}$/.test(address.houseNumber.trim())
    && (!address.orientationNumber || /^\d{1,3}[A-Za-z]?$/.test(address.orientationNumber.trim()))
    && address.city.trim().length > 0
    && address.city.trim().length <= 48
    && /^\d{3} \d{2}$/.test(address.postalCode.trim());
}

function normalize(input: SaveCompanyFilingDefaultsInput) {
  return {
    taxOffice: optional(input.taxOffice),
    economicActivity: optional(input.economicActivity ?? ""),
    territorialOffice: optional(input.territorialOffice ?? ""),
    signatoryFirstName: optional(input.signatoryFirstName),
    signatoryLastName: optional(input.signatoryLastName),
    signatoryCapacity: optional(input.signatoryCapacity),
    email: optional(input.email),
    phone: optional(input.phone),
    epoAddressOverride: input.epoAddressOverride ? {
      streetName: input.epoAddressOverride.streetName.trim(),
      houseNumber: input.epoAddressOverride.houseNumber.trim(),
      orientationNumber: optional(input.epoAddressOverride.orientationNumber ?? ""),
      city: input.epoAddressOverride.city.trim(),
      postalCode: input.epoAddressOverride.postalCode.trim(),
    } : null,
  };
}

function invalidDefaults(input: ReturnType<typeof normalize>): boolean {
  const signatory = [input.signatoryFirstName, input.signatoryLastName, input.signatoryCapacity];
  const hasSignatory = signatory.some(Boolean);
  return (input.taxOffice !== null && !TAX_OFFICES.some((code) => code === input.taxOffice))
    || (input.economicActivity !== null && !isEconomicActivity(input.economicActivity))
    || (input.territorialOffice !== null && !isTerritorialOffice(input.taxOffice ?? "", input.territorialOffice))
    || (hasSignatory && (
      !input.signatoryFirstName || input.signatoryFirstName.length > 20
      || !input.signatoryLastName || input.signatoryLastName.length > 36
      || !input.signatoryCapacity || input.signatoryCapacity.length > 40
    ))
    || (input.email !== null && (
      input.email.length > 255 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.email)
    ))
    || (input.phone !== null && input.phone.length > 14)
    || (input.epoAddressOverride !== null && !validAddress(input.epoAddressOverride));
}

export async function saveCompanyFilingDefaults(
  client: AppClient,
  input: SaveCompanyFilingDefaultsInput,
): Promise<Result<null, CompanyFilingDefaultsError>> {
  if (!isUuid(input.companyId)) return { ok: false, error: "forbidden" };
  const value = normalize(input);
  if (invalidDefaults(value)) return { ok: false, error: "invalid_filing_defaults" };
  if (value.epoAddressOverride && !input.epoAddressConfirmed) {
    return { ok: false, error: "epo_override_confirmation_required" };
  }
  const address = value.epoAddressOverride;
  const { error } = await client.rpc("set_company_filing_defaults", {
    target_company_id: input.companyId,
    new_tax_office: value.taxOffice ?? "",
    new_economic_activity: value.economicActivity ?? "",
    new_territorial_office: value.territorialOffice ?? "",
    new_signatory_first_name: value.signatoryFirstName ?? "",
    new_signatory_last_name: value.signatoryLastName ?? "",
    new_signatory_capacity: value.signatoryCapacity ?? "",
    new_email: value.email ?? "",
    new_phone: value.phone ?? "",
    new_epo_street_name: address?.streetName ?? "",
    new_epo_house_number: address?.houseNumber ?? "",
    new_epo_orientation_number: address?.orientationNumber ?? "",
    new_epo_city: address?.city ?? "",
    new_epo_postal_code: address?.postalCode ?? "",
    epo_address_confirmed: input.epoAddressConfirmed ?? false,
  });
  if (error?.code === "42501") return { ok: false, error: "forbidden" };
  if (error?.code === "P0001" && error.hint === "epo_override_not_required") {
    return { ok: false, error: "epo_override_not_required" };
  }
  if (error?.code === "P0001" && error.hint === "epo_override_confirmation_required") {
    return { ok: false, error: "epo_override_confirmation_required" };
  }
  if (error?.code === "23514" || error?.code === "23503") return { ok: false, error: "invalid_filing_defaults" };
  if (error) throw error;
  return { ok: true, value: null };
}

export async function getCompanyFilingDefaults(
  client: AppClient,
  companyId: string,
): Promise<CompanyFilingDefaults | null> {
  if (!isUuid(companyId)) return null;
  const { data, error } = await client
    .from("company_filing_defaults")
    .select("tax_office, economic_activity, territorial_office, signatory_first_name, signatory_last_name, signatory_capacity, email, phone, epo_street_name, epo_house_number, epo_orientation_number, epo_city, epo_postal_code, epo_address_confirmed_at")
    .eq("company_id", companyId)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  return {
    taxOffice: data.tax_office,
    economicActivity: data.economic_activity,
    territorialOffice: data.territorial_office,
    signatoryFirstName: data.signatory_first_name,
    signatoryLastName: data.signatory_last_name,
    signatoryCapacity: data.signatory_capacity,
    email: data.email,
    phone: data.phone,
    epoAddressOverride: data.epo_address_confirmed_at ? {
      streetName: data.epo_street_name!,
      houseNumber: data.epo_house_number!,
      orientationNumber: data.epo_orientation_number,
      city: data.epo_city!,
      postalCode: data.epo_postal_code!,
    } : null,
  };
}
