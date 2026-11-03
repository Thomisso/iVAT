import type { ValidationFinding } from "./document-validation";
import type { ExtractionPayload } from "./extraction-payload";
import { normalizedPaymentAccount, paymentAccountIdentity } from "./payment-account";

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

/** Registry warnings for one freshly extracted Document. */
export async function vatRegistryFindings(
  registry: VatPayerRegistry,
  payload: ExtractionPayload,
): Promise<ValidationFinding[]> {
  const ownAccount = payload.direction === "outgoing";
  const account = paymentAccountIdentity(payload.payment);
  const accountFindings = account.outcome === "inconsistent"
    ? [warning(account.field, "inconsistent_payment_account")]
    : account.outcome === "unrecognized"
      ? [warning(account.field, "unrecognized_payment_account")]
      : [];
  const vatId = payload.supplier.vatId;
  if (!vatId || !/^CZ\d{8,10}$/.test(vatId)) return accountFindings;

  let check: VatPayerRegistryCheck;
  try {
    check = await registry.check(vatId);
  } catch {
    check = { outcome: "unavailable" };
  }
  if (check.outcome === "unavailable") {
    return [warning("supplier.vatId", ownAccount ? "own_vat_registry_check_not_performed" : "vat_registry_check_not_performed"), ...accountFindings];
  }
  if (check.outcome === "not_found") {
    return account.outcome === "recognized" ? [warning(account.field, ownAccount ? "own_bank_account_not_verified" : "bank_account_not_verified")] : accountFindings;
  }

  const findings: ValidationFinding[] = [];
  if (check.unreliable) {
    findings.push(warning("supplier.vatId", ownAccount ? "unreliable_own_vat_payer" : "unreliable_vat_payer"));
  }
  if (
    account.outcome === "recognized" &&
    !check.publishedAccounts
      .map(normalizedPaymentAccount)
      .includes(account.account)
  ) {
    findings.push(
      warning(
        account.field,
        ownAccount ? "unpublished_own_bank_account" : "unpublished_bank_account",
      ),
    );
  }
  return [...findings, ...accountFindings];
}
