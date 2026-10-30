import type { ValidationFinding } from "./document-validation";
import type { ExtractionPayload } from "./extraction-payload";

export type VatPayerRegistryCheck =
  | {
      outcome: "checked";
      unreliable: boolean;
      /** Czech account number (`prefix-number/bank`) or IBAN. */
      publishedAccounts: string[];
    }
  | { outcome: "not_found" }
  | { outcome: "unavailable" };

/** External ADIS seam; processing tests inject a deterministic fake. */
export interface VatPayerRegistry {
  check(vatId: string): Promise<VatPayerRegistryCheck>;
}

const warning = (field: string, code: string): ValidationFinding => ({
  field,
  severity: "warning",
  code,
});

/**
 * Accounts have insignificant spaces, letter case and leading zeroes. Czech
 * standard accounts use `prefix-number/bank`; non-standard accounts are IBANs.
 */
function normalizedAccount(value: string): string {
  const compact = value.replace(/\s+/g, "").toUpperCase();
  const standard = /^(?:(\d+)-)?(\d+)\/(\d{4})$/.exec(compact);
  if (!standard) return compact;
  const digits = (part: string | undefined) =>
    part === undefined ? undefined : part.replace(/^0+(?=\d)/, "");
  const prefix = digits(standard[1]);
  return `${prefix ? `${prefix}-` : ""}${digits(standard[2])}/${standard[3]}`;
}

/** Registry warnings for one freshly extracted Document. */
export async function vatRegistryFindings(
  registry: VatPayerRegistry,
  payload: ExtractionPayload,
): Promise<ValidationFinding[]> {
  const vatId = payload.supplier.vatId;
  if (!vatId || !/^CZ\d{8,10}$/.test(vatId)) return [];
  const paymentAccount = payload.payment.iban?.trim() || payload.payment.bankAccount?.trim() || null;
  const accountField = payload.payment.iban?.trim() ? "payment.iban" : "payment.bankAccount";

  let check: VatPayerRegistryCheck;
  try {
    check = await registry.check(vatId);
  } catch {
    check = { outcome: "unavailable" };
  }
  if (check.outcome === "unavailable") {
    return [warning("supplier.vatId", "vat_registry_check_not_performed")];
  }
  if (check.outcome === "not_found") {
    return paymentAccount ? [warning(accountField, "bank_account_not_verified")] : [];
  }

  const findings: ValidationFinding[] = [];
  if (check.unreliable) {
    findings.push(warning("supplier.vatId", "unreliable_vat_payer"));
  }
  if (
    paymentAccount &&
    !check.publishedAccounts
      .map(normalizedAccount)
      .includes(normalizedAccount(paymentAccount))
  ) {
    findings.push(
      warning(
        accountField,
        "unpublished_bank_account",
      ),
    );
  }
  return findings;
}
