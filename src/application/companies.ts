import type { AiProvider } from "./ai-provider";
import { isUuid, type AppClient, type Result } from "./client";
import { extractJob, splitJob, type JobQueue } from "./processing";

export type CompanyDetails = {
  name: string;
  ico: string;
  vatId: string;
  street: string;
  city: string;
  postalCode: string;
  personType: PersonType;
};

export const PERSON_TYPES = ["legal", "natural"] as const;
export type PersonType = (typeof PERSON_TYPES)[number];
export const FILING_FREQUENCIES = ["monthly", "quarterly"] as const;
export type FilingFrequency = (typeof FILING_FREQUENCIES)[number];
export type FilingFrequencyHistoryEntry = {
  frequency: FilingFrequency;
  effectiveFrom: string;
};

/** The provider and region a Company has consented to send its Documents to; null while AI processing is off. */
export type AiProcessingConsent = { provider: string; region: string } | null;

export type Company = CompanyDetails & { id: string; organizationId: string; aiProcessing: AiProcessingConsent };

export type CompanySummary = { id: string; organizationId: string; name: string };

export type CompanySettingsInput = CompanyDetails & {
  filingFrequency: FilingFrequency;
  filingFrequencyEffectiveFrom: string;
};

export type CreateCompanyInput = CompanySettingsInput & { organizationId: string };
export type UpdateCompanyInput = CompanySettingsInput & { companyId: string };

export type CompanyDetailsError =
  | "name_required"
  | "invalid_ico"
  | "invalid_vat_id"
  | "address_required"
  | "invalid_postal_code"
  | "invalid_person_type"
  | "invalid_filing_frequency"
  | "invalid_effective_from";

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
    personType: details.personType,
  };
}

// Format checks only; checksum and registry checks are added with Document validations (#36).
function validateCompanyDetails(details: CompanyDetails): CompanyDetailsError | null {
  if (!details.name) return "name_required";
  if (!/^\d{8}$/.test(details.ico)) return "invalid_ico";
  if (!/^CZ\d{8,10}$/.test(details.vatId)) return "invalid_vat_id";
  if (!details.street || !details.city) return "address_required";
  if (!/^\d{3} \d{2}$/.test(details.postalCode)) return "invalid_postal_code";
  if (!PERSON_TYPES.some((personType) => personType === details.personType)) return "invalid_person_type";
  return null;
}

function validEffectiveFrom(value: string): boolean {
  if (!/^20\d{2}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === value;
}

function validateCompanySettings(input: CompanySettingsInput): CompanyDetailsError | null {
  const invalid = validateCompanyDetails(input);
  if (invalid) return invalid;
  if (!FILING_FREQUENCIES.some((frequency) => frequency === input.filingFrequency)) {
    return "invalid_filing_frequency";
  }
  if (!validEffectiveFrom(input.filingFrequencyEffectiveFrom)) return "invalid_effective_from";
  return null;
}

export async function createCompany(
  client: AppClient,
  input: CreateCompanyInput,
): Promise<Result<{ id: string }, CreateCompanyError>> {
  const details = normalizeCompanyDetails(input);
  const normalized = { ...input, ...details };
  const invalid = validateCompanySettings(normalized);
  if (invalid) return { ok: false, error: invalid };

  const { data, error } = await client.rpc("create_company", {
    target_organization_id: input.organizationId,
    company_name: details.name,
    company_ico: details.ico,
    company_vat_id: details.vatId,
    company_street: details.street,
    company_city: details.city,
    company_postal_code: details.postalCode,
    company_person_type: details.personType,
    initial_filing_frequency: input.filingFrequency,
    filing_frequency_effective_from: input.filingFrequencyEffectiveFrom,
  });
  if (error) {
    if (error.code === "42501") return { ok: false, error: "forbidden" };
    if (error.code === "23505") return { ok: false, error: "ico_taken" };
    throw error;
  }
  return { ok: true, value: { id: data } };
}

export async function updateCompany(
  client: AppClient,
  input: UpdateCompanyInput,
): Promise<Result<null, CreateCompanyError>> {
  if (!isUuid(input.companyId)) return { ok: false, error: "forbidden" };
  const details = normalizeCompanyDetails(input);
  const normalized = { ...input, ...details };
  const invalid = validateCompanySettings(normalized);
  if (invalid) return { ok: false, error: invalid };
  const { error } = await client.rpc("update_company", {
    target_company_id: input.companyId,
    company_name: details.name,
    company_ico: details.ico,
    company_vat_id: details.vatId,
    company_street: details.street,
    company_city: details.city,
    company_postal_code: details.postalCode,
    company_person_type: details.personType,
    new_filing_frequency: input.filingFrequency,
    filing_frequency_effective_from: input.filingFrequencyEffectiveFrom,
  });
  if (error) {
    if (error.code === "42501") return { ok: false, error: "forbidden" };
    if (error.code === "23505") return { ok: false, error: "ico_taken" };
    throw error;
  }
  return { ok: true, value: null };
}

export async function getCompany(client: AppClient, companyId: string): Promise<Company | null> {
  if (!isUuid(companyId)) return null;
  const { data, error } = await client
    .from("company")
    .select("id, organization_id, name, ico, vat_id, street, city, postal_code, person_type, ai_processing_enabled, ai_provider, ai_region")
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
    personType: data.person_type,
    aiProcessing: data.ai_processing_enabled ? { provider: data.ai_provider!, region: data.ai_region! } : null,
  };
}

export async function listCompanyFilingFrequencies(
  client: AppClient,
  companyId: string,
): Promise<FilingFrequencyHistoryEntry[]> {
  if (!isUuid(companyId)) return [];
  const pageSize = 1_000;
  const history: { frequency: FilingFrequency; effective_from: string }[] = [];
  for (let offset = 0; ; offset += pageSize) {
    const { data, error } = await client
      .from("company_filing_frequency")
      .select("frequency, effective_from")
      .eq("company_id", companyId)
      .order("effective_from")
      .range(offset, offset + pageSize - 1);
    if (error) throw error;
    history.push(...data);
    if (data.length < pageSize) break;
  }
  return history.map((entry) => ({
    frequency: entry.frequency,
    effectiveFrom: entry.effective_from,
  }));
}

function reportingPeriodStart(period: string): string | null {
  const month = /^(20\d{2})-(0[1-9]|1[0-2])$/.exec(period);
  if (month) return `${period}-01`;
  const quarter = /^(20\d{2})-Q([1-4])$/.exec(period);
  if (!quarter) return null;
  const firstMonth = (Number(quarter[2]) - 1) * 3 + 1;
  return `${quarter[1]}-${String(firstMonth).padStart(2, "0")}-01`;
}

/** The filing frequency in force on the first day of a Reporting Period. */
export async function getFilingFrequencyForPeriod(
  client: AppClient,
  companyId: string,
  period: string,
): Promise<FilingFrequency | null> {
  const start = reportingPeriodStart(period);
  if (!isUuid(companyId) || !start) return null;
  const { data, error } = await client
    .from("company_filing_frequency")
    .select("frequency")
    .eq("company_id", companyId)
    .lte("effective_from", start)
    .order("effective_from", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data?.frequency ?? null;
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

/**
 * Consents to sending the Company's Documents to the provider, in its region
 * (ADR-0006), and starts the processing that waited for it. Administrators only;
 * the database audits the change.
 */
export async function enableAiProcessing(
  client: AppClient,
  jobs: JobQueue,
  input: { companyId: string; provider: Pick<AiProvider, "name" | "region"> },
): Promise<Result<null, "forbidden">> {
  const consent = { ai_processing_enabled: true, ai_provider: input.provider.name, ai_region: input.provider.region };
  const updated = await updateAiProcessing(client, input.companyId, consent);
  if (!updated.ok) return updated;

  const [sourceFiles, documents] = await Promise.all([
    client.from("source_file").select("id").eq("company_id", input.companyId).in("status", ["uploaded", "processing"]),
    client.from("document").select("id").eq("company_id", input.companyId).in("status", ["uploaded", "processing"]),
  ]);
  if (sourceFiles.error) throw sourceFiles.error;
  if (documents.error) throw documents.error;
  for (const file of sourceFiles.data) await jobs.send(splitJob(file.id));
  for (const document of documents.data) await jobs.send(extractJob(document.id));
  return updated;
}

/** Withdraws the consent; no further Document is sent to an AI provider. Administrators only. */
export async function disableAiProcessing(client: AppClient, companyId: string): Promise<Result<null, "forbidden">> {
  return updateAiProcessing(client, companyId, { ai_processing_enabled: false, ai_provider: null, ai_region: null });
}

async function updateAiProcessing(
  client: AppClient,
  companyId: string,
  consent: { ai_processing_enabled: boolean; ai_provider: string | null; ai_region: string | null },
): Promise<Result<null, "forbidden">> {
  if (!isUuid(companyId)) return { ok: false, error: "forbidden" };
  // RLS turns a refused update into one that matches no row.
  const { data, error } = await client.from("company").update(consent).eq("id", companyId).select("id");
  if (error) {
    if (error.code === "42501") return { ok: false, error: "forbidden" };
    throw error;
  }
  if (data.length === 0) return { ok: false, error: "forbidden" };
  return { ok: true, value: null };
}
