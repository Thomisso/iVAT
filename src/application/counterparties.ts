import { isUuid, type AppClient, type Result } from "./client";
import type { Database } from "@/lib/database.types";

type Row = Database["public"]["Tables"]["counterparty"]["Row"];
export type Counterparty = {
  id: string; organizationId: string; companyId: string; name: string;
  ico: string | null; vatId: string | null; street: string; city: string;
  postalCode: string; countryCode: string; supplier: boolean; customer: boolean;
  archivedAt: string | null;
};
export type CounterpartyInput = {
  name: string; ico?: string | null; vatId?: string | null; street?: string; city?: string;
  postalCode?: string; countryCode?: string; supplier: boolean; customer: boolean;
};
export type CounterpartyError = "name_required" | "name_too_long" | "invalid_ico" | "counterparty_invalid_vat_id"
  | "invalid_country_code" | "counterparty_role_required" | "counterparty_identity_taken" | "forbidden";
function counterparty(row: Row): Counterparty {
  return { id: row.id, organizationId: row.organization_id, companyId: row.company_id,
    name: row.name, ico: row.ico, vatId: row.vat_id, street: row.street, city: row.city,
    postalCode: row.postal_code, countryCode: row.country_code, supplier: row.supplier,
    customer: row.customer, archivedAt: row.archived_at };
}
function normalizedIdentifiers(input: Pick<CounterpartyInput, "ico" | "vatId">) {
  return { ico: input.ico?.replace(/\s/g, "") || null,
    vatId: input.vatId?.replace(/\s/g, "").toUpperCase() || null };
}
function validIco(value: string | null): value is string {
  return value !== null && /^\d{8}$/.test(value);
}
function validVatId(value: string | null): value is string {
  return value !== null && /^[A-Z]{2}[A-Z0-9]{2,14}$/.test(value);
}
function normalized(input: CounterpartyInput) {
  const identifiers = normalizedIdentifiers(input);
  return { name: input.name.trim(), ico: identifiers.ico, vat_id: identifiers.vatId,
    street: input.street?.trim() ?? "", city: input.city?.trim() ?? "",
    postal_code: input.postalCode?.trim() ?? "", country_code: input.countryCode?.trim().toUpperCase() ?? "",
    supplier: input.supplier, customer: input.customer };
}
function invalid(input: ReturnType<typeof normalized>): CounterpartyError | null {
  if (!input.name) return "name_required";
  if (input.name.length > 255) return "name_too_long";
  if (input.ico && !validIco(input.ico)) return "invalid_ico";
  if (input.vat_id && !validVatId(input.vat_id)) return "counterparty_invalid_vat_id";
  if (input.country_code && !/^[A-Z]{2}$/.test(input.country_code)) return "invalid_country_code";
  if (!input.supplier && !input.customer) return "counterparty_role_required";
  return null;
}
export async function createCounterparty(client: AppClient, input: CounterpartyInput & { companyId: string }): Promise<Result<{ id: string }, CounterpartyError>> {
  if (!isUuid(input.companyId)) return { ok: false, error: "forbidden" };
  const values = normalized(input);
  const refusal = invalid(values);
  if (refusal) return { ok: false, error: refusal };
  const { data, error } = await client.rpc("create_counterparty", {
    target_company_id: input.companyId, counterparty_name: values.name,
    counterparty_ico: values.ico ?? "", counterparty_vat_id: values.vat_id ?? "",
    counterparty_street: values.street, counterparty_city: values.city,
    counterparty_postal_code: values.postal_code, counterparty_country_code: values.country_code,
    counterparty_supplier: values.supplier, counterparty_customer: values.customer,
  });
  if (error?.code === "42501") return { ok: false, error: "forbidden" };
  if (error?.code === "23505") return { ok: false, error: "counterparty_identity_taken" };
  if (error) throw error;
  return { ok: true, value: { id: data } };
}
export async function getCounterparty(client: AppClient, companyId: string, id: string): Promise<Counterparty | null> {
  if (!isUuid(companyId) || !isUuid(id)) return null;
  const { data, error } = await client.from("counterparty").select("*").eq("company_id", companyId).eq("id", id).maybeSingle();
  if (error) throw error;
  return data ? counterparty(data) : null;
}
export type CounterpartyFilters = { identifiers?: { ico?: string; vatId?: string }; state?: "active" | "archived"; search?: string; role?: "supplier" | "customer"; page?: number; pageSize?: number };
export type CounterpartyPage = { entries: Counterparty[]; total: number; page: number; pageSize: number; pageCount: number };
export async function listCounterparties(client: AppClient, companyId: string, input: CounterpartyFilters = {}): Promise<CounterpartyPage> {
  const page = Number.isFinite(input.page) ? Math.max(1, Math.trunc(input.page!)) : 1;
  const pageSize = Number.isFinite(input.pageSize) ? Math.min(100, Math.max(1, Math.trunc(input.pageSize!))) : 50;
  if (!isUuid(companyId)) return { entries: [], total: 0, page, pageSize, pageCount: 1 };
  const from = (page - 1) * pageSize;
  const { ico, vatId } = normalizedIdentifiers(input.identifiers ?? {});
  // Only validated identifier characters enter PostgREST's OR expression.
  const identifiers = [
    validIco(ico) ? `ico.eq.${ico}` : null,
    validVatId(vatId) ? `vat_id.eq.${vatId}` : null,
  ].filter((value): value is string => value !== null);
  if (input.identifiers && identifiers.length === 0) return { entries: [], total: 0, page, pageSize, pageCount: 1 };
  let query = client.rpc("search_counterparties", {
    directory_state: input.state ?? "active", target_company_id: companyId, search_text: input.search?.trim() ?? "", directory_role: input.role ?? "",
  }, { count: "exact" });
  if (identifiers.length) query = query.or(identifiers.join(","));
  const { data, error, count } = await query.order("name").order("id").range(from, from + pageSize - 1);
  if (error) throw error;
  const total = count ?? 0;
  return { entries: data.map(counterparty), total, page, pageSize, pageCount: Math.max(1, Math.ceil(total / pageSize)) };
}

export async function updateCounterparty(client: AppClient, input: CounterpartyInput & { companyId: string; id: string }): Promise<Result<null, CounterpartyError>> {
  if (!isUuid(input.companyId) || !isUuid(input.id)) return { ok: false, error: "forbidden" };
  const values = normalized(input);
  const refusal = invalid(values);
  if (refusal) return { ok: false, error: refusal };
  const { data, error } = await client.from("counterparty").update(values).eq("company_id", input.companyId).eq("id", input.id).select("id").maybeSingle();
  if (error?.code === "42501") return { ok: false, error: "forbidden" };
  if (error?.code === "23505") return { ok: false, error: "counterparty_identity_taken" };
  if (error) throw error;
  return data ? { ok: true, value: null } : { ok: false, error: "forbidden" };
}

export async function listCounterpartyDocuments(client: AppClient, companyId: string, id: string, page = 1) {
  page = Number.isFinite(page) ? Math.max(1, Math.trunc(page)) : 1;
  const pageSize = 50;
  if (!isUuid(companyId) || !isUuid(id)) return { entries: [], total: 0, page, pageCount: 1 };
  const { data, error, count } = await client.rpc("counterparty_documents", { target_company_id: companyId, target_counterparty_id: id }, { count: "exact" })
    .order("document_id").range((page - 1) * pageSize, page * pageSize - 1);
  if (error) throw error;
  return { entries: data.map(row => ({ documentId: row.document_id, version: row.version, documentNumber: row.document_number })),
    total: count ?? 0, page, pageCount: Math.max(1, Math.ceil((count ?? 0) / pageSize)) };
}


type CounterpartyTarget = { companyId: string; id: string };
type CounterpartyLifecycleOperation = "archive_counterparty" | "restore_counterparty" | "delete_counterparty";

async function changeCounterpartyLifecycle(client: AppClient, input: CounterpartyTarget, operation: "delete_counterparty"): Promise<Result<null, "forbidden" | "counterparty_in_use">>;
async function changeCounterpartyLifecycle(client: AppClient, input: CounterpartyTarget, operation: "archive_counterparty" | "restore_counterparty"): Promise<Result<null, "forbidden">>;
async function changeCounterpartyLifecycle(client: AppClient, input: CounterpartyTarget, operation: CounterpartyLifecycleOperation): Promise<Result<null, "forbidden" | "counterparty_in_use">> {
  if (!isUuid(input.companyId) || !isUuid(input.id)) return { ok: false, error: "forbidden" };
  const { error } = await client.rpc(operation, {
    target_company_id: input.companyId, target_counterparty_id: input.id,
  });
  if (error?.code === "42501") return { ok: false, error: "forbidden" };
  if (operation === "delete_counterparty" && error?.code === "P0001" && error.hint === "counterparty_in_use") return { ok: false, error: "counterparty_in_use" };
  if (error) throw error;
  return { ok: true, value: null };
}

export async function archiveCounterparty(client: AppClient, input: CounterpartyTarget): Promise<Result<null, "forbidden">> {
  return changeCounterpartyLifecycle(client, input, "archive_counterparty");
}

export async function restoreCounterparty(client: AppClient, input: CounterpartyTarget): Promise<Result<null, "forbidden">> {
  return changeCounterpartyLifecycle(client, input, "restore_counterparty");
}

export async function deleteCounterparty(client: AppClient, input: CounterpartyTarget): Promise<Result<null, "forbidden" | "counterparty_in_use">> {
  return changeCounterpartyLifecycle(client, input, "delete_counterparty");
}
