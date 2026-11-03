import { isUuid, type AppClient, type Result } from "./client";
import { currentValidationFindings, type ValidationFinding } from "./document-validation";
import { getDocument } from "./documents";
import type { ExtractionPayload } from "./extraction-payload";
import { normalizedPaymentAccount, paymentAccountIdentity } from "./payment-account";
import type { VatPayerRegistry, VatPayerRegistryCheck } from "./vat-registry";

export type BankAccountCheckOutcome = "published" | "unpublished" | "unavailable" | "unverified" | "missing" | "inconsistent" | "unrecognized";
export type BankAccountCheck = {
  id: string;
  extractionVersionId: string;
  version: number;
  checkedAt: string;
  outcome: BankAccountCheckOutcome;
  supplierVatId: string | null;
  payment: ExtractionPayload["payment"];
  direction: ExtractionPayload["direction"];
};

const accountFindingCodes = new Set([
  "missing_bank_account", "unpublished_bank_account", "unpublished_own_bank_account",
  "bank_account_not_verified", "own_bank_account_not_verified", "vat_registry_check_not_performed",
  "own_vat_registry_check_not_performed", "inconsistent_payment_account", "unrecognized_payment_account",
]);

/** Account advisories superseded by a current dated observation. */
export function isBankAccountFinding(finding: ValidationFinding): boolean {
  return accountFindingCodes.has(finding.code);
}

function observationFindings(check: BankAccountCheck): ValidationFinding[] {
  const own = check.direction === "outgoing";
  const account = paymentAccountIdentity(check.payment);
  const code = {
    published: null,
    unpublished: own ? "unpublished_own_bank_account" : "unpublished_bank_account",
    unavailable: own ? "own_vat_registry_check_not_performed" : "vat_registry_check_not_performed",
    unverified: own ? "own_bank_account_not_verified" : "bank_account_not_verified",
    missing: "missing_bank_account",
    inconsistent: "inconsistent_payment_account",
    unrecognized: "unrecognized_payment_account",
  }[check.outcome];
  return code ? [{ field: check.outcome === "unavailable" ? "supplier.vatId" : "field" in account ? account.field : "payment.bankAccount", severity: "warning", code }] : [];
}

/**
 * Authorized Document readers see all dated observations, newest first. Only a
 * check of the current immutable Version supersedes legacy account advisories;
 * unrelated findings and all stored Versions remain intact. No report writes.
 */
export async function getDocumentBankAccountChecks(client: AppClient, input: { companyId: string; documentId: string }) {
  const empty = { checks: [] as BankAccountCheck[], current: null as BankAccountCheck | null, findings: [] as ValidationFinding[], extractionVersionId: null as string | null };
  if (!isUuid(input.companyId) || !isUuid(input.documentId)) return empty;
  const latest = await client.from("extraction_version").select("id, payload, findings")
    .eq("company_id", input.companyId).eq("document_id", input.documentId).order("version", { ascending: false }).limit(1).maybeSingle();
  if (latest.error) throw latest.error;
  if (!latest.data) return empty;
  const latestVersion = latest.data;
  const checks: BankAccountCheck[] = [];
  for (let offset = 0; ; offset += 1000) {
    const result = await client.from("bank_account_check")
      .select("id, extraction_version_id, checked_at, outcome, extraction_version!inner(version, payload)")
      .eq("company_id", input.companyId).eq("document_id", input.documentId)
      .order("checked_at", { ascending: false }).order("id").range(offset, offset + 999);
    if (result.error) throw result.error;
    checks.push(...result.data.map((row) => {
      const payload = row.extraction_version.payload as ExtractionPayload;
      return { id: row.id, extractionVersionId: row.extraction_version_id, version: row.extraction_version.version,
        checkedAt: row.checked_at, outcome: row.outcome as BankAccountCheckOutcome,
        supplierVatId: payload.supplier.vatId, payment: payload.payment, direction: payload.direction };
    }));
    if (result.data.length < 1000) break;
  }
  const current = checks.find((check) => check.extractionVersionId === latestVersion.id) ?? null;
  const findings = currentValidationFindings(latestVersion.payload as ExtractionPayload, latestVersion.findings as ValidationFinding[]);
  return { checks, current, extractionVersionId: latestVersion.id,
    findings: current ? [...findings.filter((finding) => !isBankAccountFinding(finding)), ...observationFindings(current)] : findings };
}

/**
 * Explicit recheck under the caller's identity, including Approved/locked work.
 * Missing/inaccessible Documents refuse before contacting the registry; absent
 * Extraction refuses as not_extracted. Registry failure is a stored unavailable
 * observation. A concurrent correction retains the result only for its input
 * Version. PostgreSQL enforces read/write scope; no accounting state changes.
 */
export async function refreshBankAccountCheck(client: AppClient, input: { companyId: string; documentId: string }, registry: VatPayerRegistry): Promise<Result<BankAccountCheck, "forbidden" | "not_extracted">> {
  const document = await getDocument(client, input.companyId, input.documentId);
  if (!document) return { ok: false, error: "forbidden" };
  const version = await client.from("extraction_version").select("id, version, payload")
    .eq("document_id", document.id).order("version", { ascending: false }).limit(1).maybeSingle();
  if (version.error) throw version.error;
  if (!version.data) return { ok: false, error: "not_extracted" };
  const payload = version.data.payload as ExtractionPayload;
  const account = paymentAccountIdentity(payload.payment);
  let outcome: BankAccountCheckOutcome;
  if (account.outcome !== "recognized") outcome = account.outcome;
  else if (!payload.supplier.vatId || !/^CZ\d{8,10}$/.test(payload.supplier.vatId)) outcome = "unverified";
  else {
    let check: VatPayerRegistryCheck;
    try { check = await registry.check(payload.supplier.vatId); }
    catch { check = { outcome: "unavailable" }; }
    outcome = check.outcome === "unavailable" ? "unavailable" : check.outcome === "not_found" ? "unverified"
      : check.publishedAccounts.map(normalizedPaymentAccount).includes(account.account) ? "published" : "unpublished";
  }
  const result = await client.rpc("record_bank_account_check", { target_document_id: document.id, checked_version_id: version.data.id, check_outcome: outcome });
  if (result.error) {
    if (result.error.code === "42501") return { ok: false, error: "forbidden" };
    throw result.error;
  }
  const { checks } = await getDocumentBankAccountChecks(client, input);
  const saved = checks.find((check) => check.id === result.data);
  // Access may have been revoked while the registry request was in flight.
  return saved ? { ok: true, value: saved } : { ok: false, error: "forbidden" };
}
