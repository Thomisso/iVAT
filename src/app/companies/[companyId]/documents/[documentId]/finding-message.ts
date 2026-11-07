import type { ValidationFinding } from "@/application/document-validation";

/**
 * The message key and values of a finding. A gross-total finding recorded
 * before it carried its difference uses a message without an amount.
 */
export function findingMessage(finding: ValidationFinding): {
  key: string;
  values: Record<string, string | number>;
} {
  const difference = finding.params?.difference;
  if (finding.code === "total_gross_amount_mismatch" && difference === undefined) {
    return { key: `${finding.code}_without_difference`, values: {} };
  }
  return {
    key: finding.code,
    values: { ...finding.params, ...(difference === undefined ? {} : { difference: Number(difference) }) },
  };
}
