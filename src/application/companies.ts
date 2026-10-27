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
};

/** The provider and region a Company has consented to send its Documents to; null while AI processing is off. */
export type AiProcessingConsent = { provider: string; region: string } | null;

export type Company = CompanyDetails & { id: string; organizationId: string; aiProcessing: AiProcessingConsent };

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

// Format checks only; checksum and registry checks are added with Document validations (#36).
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

export async function getCompany(client: AppClient, companyId: string): Promise<Company | null> {
  if (!isUuid(companyId)) return null;
  const { data, error } = await client
    .from("company")
    .select("id, organization_id, name, ico, vat_id, street, city, postal_code, ai_processing_enabled, ai_provider, ai_region")
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
    aiProcessing: data.ai_processing_enabled ? { provider: data.ai_provider!, region: data.ai_region! } : null,
  };
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
