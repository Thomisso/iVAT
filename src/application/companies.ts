import { isUuid, type AppClient, type Result } from "./client";
import { currentReportingYear, reportingPeriodsOf } from "./reporting-periods";

export type CompanyDetails = {
  name: string;
  firstName: string | null;
  lastName: string | null;
  ico: string;
  vatId: string;
  streetName: string;
  houseNumber: string;
  orientationNumber: string | null;
  city: string;
  postalCode: string;
  personType: PersonType;
};

export type CompanyIdentityInput = {
  name: string;
  firstName?: string | null;
  lastName?: string | null;
  ico: string;
  vatId: string;
  streetName?: string;
  houseNumber?: string;
  orientationNumber?: string | null;
  city: string;
  postalCode: string;
  personType: PersonType;
};
type NormalizedCompanyIdentity = Omit<CompanyIdentityInput, "firstName" | "lastName" | "streetName" | "houseNumber" | "orientationNumber"> & {
  firstName: string;
  lastName: string;
  streetName: string;
  houseNumber: string;
  orientationNumber: string;
};

export const PERSON_TYPES = ["legal", "natural"] as const;
export type PersonType = (typeof PERSON_TYPES)[number];
export const FILING_FREQUENCIES = ["monthly", "quarterly"] as const;
export type FilingFrequency = (typeof FILING_FREQUENCIES)[number];
/** One calendar year of a Company with one filing frequency, starting in `firstMonth` (ADR-0013). */
export type ReportingYear = {
  year: number;
  frequency: FilingFrequency;
  firstMonth: number;
};

export type CompanySetupStep = "identity" | "filing_frequency" | "filing_defaults" | "ai_processing";
export type CompanySetupItem = { step: CompanySetupStep; state: "completed" | "skipped" | "blocking" };

export type Company = CompanyDetails & {
  id: string;
  organizationId: string;
  /** Formatted for display only. Statutory outputs use the structured address fields. */
  street: string;
  /** Generic processing state; provider/configuration details are platform-only. */
  aiProcessingEnabled: boolean;
};

export type CompanySummary = { id: string; organizationId: string; name: string };

export type CompanySettingsInput = CompanyIdentityInput & {
  filingFrequency: FilingFrequency;
  /** Defaults to the current year; callers that must not depend on the clock pass it. */
  reportingYear?: number;
};

export type CreateCompanyInput = CompanySettingsInput & { organizationId: string };
export type UpdateCompanyInput = CompanySettingsInput & { companyId: string };

export type CompanyDetailsError =
  | "name_required"
  | "name_too_long"
  | "first_name_required"
  | "first_name_too_long"
  | "last_name_required"
  | "last_name_too_long"
  | "invalid_ico"
  | "invalid_vat_id"
  | "address_required"
  | "invalid_house_number"
  | "invalid_orientation_number"
  | "invalid_postal_code"
  | "invalid_person_type"
  | "invalid_filing_frequency"
  | "invalid_reporting_year";

export type SetCurrentReportingYearError =
  | "invalid_filing_frequency"
  | "invalid_reporting_year"
  | "reporting_year_in_use"
  | "forbidden";

export type CreateCompanyError = CompanyDetailsError | "ico_taken" | "forbidden";
export type UpdateCompanyError = CreateCompanyError | SetCurrentReportingYearError;

export type EpoIdentityFinding = {
  field: "streetName" | "orientationNumber" | "city";
  code: "epo_street_name_too_long" | "epo_orientation_number_too_long" | "epo_city_too_long";
};

export function registeredAddressLine(address: Pick<CompanyDetails, "streetName" | "houseNumber" | "orientationNumber">) {
  return `${address.streetName} ${address.houseNumber}${address.orientationNumber ? `/${address.orientationNumber}` : ""}`;
}

export function normalizeCompanyIdentity(details: CompanyIdentityInput): NormalizedCompanyIdentity {
  const digits = (value: string) => value.replace(/\s+/g, "");
  const postalCode = digits(details.postalCode);
  const firstName = details.firstName?.trim() ?? "";
  const lastName = details.lastName?.trim() ?? "";
  return {
    name: details.personType === "natural" ? `${firstName} ${lastName}`.trim() : details.name.trim(),
    firstName,
    lastName,
    ico: digits(details.ico),
    vatId: digits(details.vatId).toUpperCase(),
    streetName: details.streetName?.trim() ?? "",
    houseNumber: details.houseNumber?.trim() ?? "",
    orientationNumber: details.orientationNumber?.trim() ?? "",
    city: details.city.trim(),
    postalCode: /^\d{5}$/.test(postalCode) ? `${postalCode.slice(0, 3)} ${postalCode.slice(3)}` : postalCode,
    personType: details.personType,
  };
}

// Format checks only; checksum and registry checks are added with Document validations (#36).
function validateCompanyIdentity(details: CompanyIdentityInput): CompanyDetailsError | null {
  if (details.personType === "legal" && !details.name) return "name_required";
  if (details.personType === "legal" && details.name.length > 255) return "name_too_long";
  if (details.personType === "natural" && !details.firstName) return "first_name_required";
  if (details.personType === "natural" && (details.firstName?.length ?? 0) > 30) return "first_name_too_long";
  if (details.personType === "natural" && !details.lastName) return "last_name_required";
  if (details.personType === "natural" && (details.lastName?.length ?? 0) > 36) return "last_name_too_long";
  if (!/^\d{8}$/.test(details.ico)) return "invalid_ico";
  if (!/^CZ\d{8,10}$/.test(details.vatId)) return "invalid_vat_id";
  if (!details.streetName || !details.city) return "address_required";
  if (!/^\d{1,6}$/.test(details.houseNumber ?? "")) return "invalid_house_number";
  if (details.orientationNumber && !/^\d{1,3}[A-Za-z]?$/.test(details.orientationNumber)) {
    return "invalid_orientation_number";
  }
  if (!/^\d{3} \d{2}$/.test(details.postalCode)) return "invalid_postal_code";
  if (!PERSON_TYPES.some((personType) => personType === details.personType)) return "invalid_person_type";
  return null;
}

/** EPO schema limits do not change the registered identity and are never truncated. */
export function epoIdentityFindings(
  details: Pick<CompanyIdentityInput, "streetName" | "orientationNumber" | "city">,
): EpoIdentityFinding[] {
  const findings: EpoIdentityFinding[] = [];
  if ((details.streetName?.length ?? 0) > 38) {
    findings.push({ field: "streetName", code: "epo_street_name_too_long" });
  }
  if ((details.orientationNumber?.length ?? 0) > 4) {
    findings.push({ field: "orientationNumber", code: "epo_orientation_number_too_long" });
  }
  if (details.city.length > 48) {
    findings.push({ field: "city", code: "epo_city_too_long" });
  }
  return findings;
}

function validateCompanySettings(input: CompanySettingsInput): CompanyDetailsError | null {
  const invalid = validateCompanyIdentity(input);
  if (invalid) return invalid;
  if (!FILING_FREQUENCIES.some((frequency) => frequency === input.filingFrequency)) {
    return "invalid_filing_frequency";
  }
  if (input.reportingYear !== undefined && !validReportingYear(input.reportingYear)) {
    return "invalid_reporting_year";
  }
  return null;
}

export async function createCompanyIdentity(
  client: AppClient,
  input: CompanyIdentityInput & { organizationId: string },
): Promise<Result<{ id: string }, CreateCompanyError>> {
  const identity = normalizeCompanyIdentity(input);
  const invalid = validateCompanyIdentity(identity);
  if (invalid) return { ok: false, error: invalid };
  const { data, error } = await client.rpc("create_company_identity", {
    target_organization_id: input.organizationId,
    company_name: identity.name,
    company_first_name: identity.firstName,
    company_last_name: identity.lastName,
    company_ico: identity.ico,
    company_vat_id: identity.vatId,
    company_street_name: identity.streetName,
    company_house_number: identity.houseNumber,
    company_orientation_number: identity.orientationNumber,
    company_city: identity.city,
    company_postal_code: identity.postalCode,
    company_person_type: identity.personType,
  });
  if (error) {
    if (error.code === "42501") return { ok: false, error: "forbidden" };
    if (error.code === "23505") return { ok: false, error: "ico_taken" };
    throw error;
  }
  return { ok: true, value: { id: data } };
}

const validReportingYear = (year: number) => Number.isInteger(year) && year >= 2000 && year <= 2099;

/** Onboarding and filing settings: creates or updates the current Reporting Year with the chosen frequency. */
export async function setCurrentReportingYear(
  client: AppClient,
  input: { companyId: string; filingFrequency: FilingFrequency; year?: number },
): Promise<Result<null, SetCurrentReportingYearError>> {
  if (!isUuid(input.companyId)) return { ok: false, error: "forbidden" };
  if (!FILING_FREQUENCIES.some((frequency) => frequency === input.filingFrequency)) {
    return { ok: false, error: "invalid_filing_frequency" };
  }
  const year = input.year ?? currentReportingYear();
  if (!validReportingYear(year)) return { ok: false, error: "invalid_reporting_year" };
  const { error } = await client.rpc("set_company_reporting_year", {
    target_company_id: input.companyId,
    target_year: year,
    new_frequency: input.filingFrequency,
  });
  if (error) {
    if (error.code === "42501") return { ok: false, error: "forbidden" };
    if (error.code === "P0001" && (error.hint === "invalid_reporting_year" || error.hint === "reporting_year_in_use")) {
      return { ok: false, error: error.hint };
    }
    throw error;
  }
  return { ok: true, value: null };
}

export async function createCompany(
  client: AppClient,
  input: CreateCompanyInput,
): Promise<Result<{ id: string }, CreateCompanyError>> {
  const details = normalizeCompanyIdentity(input);
  const normalized = { ...input, ...details };
  const invalid = validateCompanySettings(normalized);
  if (invalid) return { ok: false, error: invalid };
  const created = await createCompanyIdentity(client, { organizationId: input.organizationId, ...details });
  if (!created.ok) return created;
  const filing = await setCurrentReportingYear(client, {
    companyId: created.value.id,
    filingFrequency: input.filingFrequency,
    year: input.reportingYear,
  });
  if (!filing.ok) {
    if (filing.error === "reporting_year_in_use") throw new Error("A new Company has no VAT Reports");
    return { ok: false, error: filing.error };
  }
  return created;
}

export async function updateCompanyIdentity(
  client: AppClient,
  input: CompanyIdentityInput & { companyId: string },
): Promise<Result<null, CreateCompanyError>> {
  if (!isUuid(input.companyId)) return { ok: false, error: "forbidden" };
  const identity = normalizeCompanyIdentity(input);
  const invalid = validateCompanyIdentity(identity);
  if (invalid) return { ok: false, error: invalid };
  const { error } = await client.rpc("update_company_identity", {
    target_company_id: input.companyId,
    company_name: identity.name,
    company_first_name: identity.firstName,
    company_last_name: identity.lastName,
    company_ico: identity.ico,
    company_vat_id: identity.vatId,
    company_street_name: identity.streetName,
    company_house_number: identity.houseNumber,
    company_orientation_number: identity.orientationNumber,
    company_city: identity.city,
    company_postal_code: identity.postalCode,
    company_person_type: identity.personType,
  });
  if (error) {
    if (error.code === "42501") return { ok: false, error: "forbidden" };
    if (error.code === "23505") return { ok: false, error: "ico_taken" };
    throw error;
  }
  return { ok: true, value: null };
}

export async function updateCompany(
  client: AppClient,
  input: UpdateCompanyInput,
): Promise<Result<null, UpdateCompanyError>> {
  if (!isUuid(input.companyId)) return { ok: false, error: "forbidden" };
  const details = normalizeCompanyIdentity(input);
  const normalized = { ...input, ...details };
  const invalid = validateCompanySettings(normalized);
  if (invalid) return { ok: false, error: invalid };
  const updated = await updateCompanyIdentity(client, { companyId: input.companyId, ...details });
  if (!updated.ok) return updated;
  return setCurrentReportingYear(client, {
    companyId: input.companyId,
    filingFrequency: input.filingFrequency,
    year: input.reportingYear,
  });
}

export async function getCompany(client: AppClient, companyId: string): Promise<Company | null> {
  if (!isUuid(companyId)) return null;
  const { data, error } = await client
    .from("company")
    .select("id, organization_id, name, first_name, last_name, ico, vat_id, street, street_name, house_number, orientation_number, city, postal_code, person_type, ai_processing_enabled")
    .eq("id", companyId)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  return {
    id: data.id,
    organizationId: data.organization_id,
    name: data.name,
    firstName: data.first_name,
    lastName: data.last_name,
    ico: data.ico,
    vatId: data.vat_id,
    street: registeredAddressLine({
      streetName: data.street_name ?? data.street,
      houseNumber: data.house_number ?? "",
      orientationNumber: data.orientation_number,
    }),
    streetName: data.street_name ?? data.street,
    houseNumber: data.house_number ?? "",
    orientationNumber: data.orientation_number,
    city: data.city,
    postalCode: data.postal_code,
    personType: data.person_type,
    aiProcessingEnabled: data.ai_processing_enabled,
  };
}

export async function listCompanyReportingYears(
  client: AppClient,
  companyId: string,
): Promise<ReportingYear[]> {
  if (!isUuid(companyId)) return [];
  const { data, error } = await client
    .from("reporting_year")
    .select("year, frequency, first_month")
    .eq("company_id", companyId)
    .order("year");
  if (error) throw error;
  return data.map((entry) => ({
    year: entry.year,
    frequency: entry.frequency,
    firstMonth: entry.first_month,
  }));
}

/** Read-only setup state. Missing required steps block; optional future steps remain visible as skipped. */
export async function getCompanySetupChecklist(
  client: AppClient,
  companyId: string,
): Promise<CompanySetupItem[]> {
  if (!isUuid(companyId)) return [];
  const { data, error } = await client
    .from("company_setup_step_state")
    .select("step, state")
    .eq("company_id", companyId);
  if (error) throw error;
  const state = new Map(data.map((item) => [item.step, item.state]));
  return (["identity", "filing_frequency", "filing_defaults", "ai_processing"] as const).map((step) => ({
    step,
    state: state.get(step) ?? (step === "identity" || step === "filing_frequency" ? "blocking" : "skipped"),
  }));
}

/** The frequency of a Reporting Period's year, or null when the period is not in a generated Reporting Year. */
export async function getReportingPeriodFrequency(
  client: AppClient,
  companyId: string,
  period: string,
): Promise<FilingFrequency | null> {
  const year = Number(period.slice(0, 4));
  if (!isUuid(companyId) || !/^20\d{2}-/.test(period)) return null;
  const { data, error } = await client
    .from("reporting_year")
    .select("year, frequency, first_month")
    .eq("company_id", companyId)
    .eq("year", year)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  const reportingYear = { year: data.year, frequency: data.frequency, firstMonth: data.first_month };
  return reportingPeriodsOf([reportingYear]).includes(period) ? data.frequency : null;
}

/** Companies the current user can access, directly or as Organization Administrator. */
export async function listMyCompanies(client: AppClient): Promise<CompanySummary[]> {
  const { data, error } = await client.from("company").select("id, organization_id, name").order("name");
  if (error) throw error;
  return data.map((c) => ({ id: c.id, organizationId: c.organization_id, name: c.name }));
}

/** The current user's effective Role in a Company, including Organization administration. */
export async function getMyCompanyRole(client: AppClient, companyId: string): Promise<"administrator" | "user" | null> {
  if (!isUuid(companyId)) return null;
  const [{ data: auth }, company] = await Promise.all([client.auth.getUser(), getCompany(client, companyId)]);
  if (!auth.user || !company) return null;
  const { data, error } = await client
    .from("membership")
    .select("company_id, role")
    .eq("user_id", auth.user.id)
    .eq("organization_id", company.organizationId);
  if (error) throw error;
  if (data.some((membership) => membership.company_id === null && membership.role === "administrator")) {
    return "administrator";
  }
  return data.find((membership) => membership.company_id === companyId)?.role ?? null;
}
