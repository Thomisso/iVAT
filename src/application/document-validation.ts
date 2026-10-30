import type { ExtractionPayload } from "./extraction-payload";

export type ValidationFindingSeverity = "error" | "warning";

export type ValidationFinding = {
  field: string;
  severity: ValidationFindingSeverity;
  code: string;
  /** Values the finding's message shows, such as an amount `difference` ("10.00"). */
  params?: Record<string, string>;
};

export type VatRatePeriod = {
  validFrom: string;
  rates: readonly number[];
};

export type DocumentValidationReferenceData = {
  vatRates: readonly VatRatePeriod[];
  roundingToleranceCents: number;
};

/** Czech VAT rates keyed by their effective date, newest first. */
export const CZECH_DOCUMENT_VALIDATION_REFERENCE_DATA: DocumentValidationReferenceData = {
  vatRates: [
    { validFrom: "2024-01-01", rates: [0, 12, 21] },
    { validFrom: "2015-01-01", rates: [0, 10, 15, 21] },
    { validFrom: "2013-01-01", rates: [0, 15, 21] },
    { validFrom: "2012-01-01", rates: [0, 14, 20] },
    { validFrom: "2010-01-01", rates: [0, 10, 20] },
    { validFrom: "2008-01-01", rates: [0, 9, 19] },
    { validFrom: "2004-05-01", rates: [0, 5, 19] },
  ],
  roundingToleranceCents: 2,
};

/** Non-negative cents as a two-decimal string, the way amounts are stored ("0.05"). */
function centsAmount(cents: number): string {
  return `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, "0")}`;
}

function amountCents(value: string | null): number | null {
  if (value === null || !/^-?\d+\.\d{2}$/.test(value)) return null;
  const negative = value.startsWith("-");
  const [whole, decimals] = value.replace("-", "").split(".");
  const cents = Number(whole) * 100 + Number(decimals);
  return negative ? -cents : cents;
}

const error = (field: string, code: string): ValidationFinding => ({
  field,
  severity: "error",
  code,
});

const warning = (field: string, code: string): ValidationFinding => ({
  field,
  severity: "warning",
  code,
});

export type IdentifierValidation = "valid" | "invalid_format" | "invalid_checksum";

/** Czech IČO checksum: weighted first seven digits, with the eighth as check digit. */
export function validateIco(ico: string): IdentifierValidation {
  if (!/^\d{8}$/.test(ico)) return "invalid_format";
  const digits = [...ico].map(Number);
  const weighted = digits
    .slice(0, 7)
    .reduce((sum, digit, index) => sum + digit * (8 - index), 0);
  const remainder = weighted % 11;
  const expected = remainder === 0 ? 1 : remainder === 1 ? 0 : 11 - remainder;
  return digits[7] === expected ? "valid" : "invalid_checksum";
}

function validBirthNumberDate(digits: string): boolean {
  const yearPart = Number(digits.slice(0, 2));
  let month = Number(digits.slice(2, 4));
  const day = Number(digits.slice(4, 6));
  if (month > 70) month -= 70;
  else if (month > 50) month -= 50;
  else if (month > 20) month -= 20;
  const year = digits.length === 9 || yearPart >= 54 ? 1900 + yearPart : 2000 + yearPart;
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

/** Czech VAT ID checksum for legal-person IČOs and natural-person birth numbers. */
export function validateCzechVatId(vatId: string): IdentifierValidation {
  if (!/^CZ\d{8,10}$/.test(vatId)) return "invalid_format";
  const digits = vatId.slice(2);
  if (digits.length === 8) {
    const result = validateIco(digits);
    return result === "invalid_format" ? "invalid_checksum" : result;
  }
  if (!validBirthNumberDate(digits)) return "invalid_checksum";
  if (digits.length === 9) return Number(digits.slice(0, 2)) < 54 ? "valid" : "invalid_checksum";
  return BigInt(digits) % BigInt(11) === BigInt(0) ? "valid" : "invalid_checksum";
}

function identifierFindings(payload: ExtractionPayload): ValidationFinding[] {
  const findings: ValidationFinding[] = [];
  for (const partyName of ["supplier", "customer"] as const) {
    const party = payload[partyName];
    if (party.ico) {
      const result = validateIco(party.ico);
      if (result !== "valid") {
        findings.push(
          error(
            `${partyName}.ico`,
            result === "invalid_format" ? "invalid_ico_format" : "invalid_ico_checksum",
          ),
        );
      }
    }
    if (party.vatId) {
      const result = party.vatId.startsWith("CZ")
        ? validateCzechVatId(party.vatId)
        : /^[A-Z]{2}[A-Z0-9+*.]{2,12}$/.test(party.vatId)
          ? "valid"
          : "invalid_format";
      if (result !== "valid") {
        findings.push(
          error(
            `${partyName}.vatId`,
            result === "invalid_format" ? "invalid_vat_id_format" : "invalid_vat_id_checksum",
          ),
        );
      }
    }
  }
  return findings;
}

function requiredFieldFindings(payload: ExtractionPayload): ValidationFinding[] {
  const findings: ValidationFinding[] = [];
  const grossCents = amountCents(payload.totals.grossAmount);
  const requiresCounterpartyVatId =
    payload.proposedVatRegime === "domestic_reverse_charge" ||
    payload.proposedVatRegime === "eu_acquisition_of_goods" ||
    payload.proposedVatRegime === "eu_received_service" ||
    (payload.proposedVatRegime === "domestic" &&
      grossCents !== null &&
      Math.abs(grossCents) > 1_000_000);
  const counterpartyName =
    payload.direction === "incoming"
      ? "supplier"
      : payload.direction === "outgoing"
        ? "customer"
        : null;
  if (
    requiresCounterpartyVatId &&
    counterpartyName &&
    !payload[counterpartyName].vatId
  ) {
    findings.push(
      error(
        `${counterpartyName}.vatId`,
        "counterparty_vat_id_required",
      ),
    );
  }
  if (
    payload.proposedVatRegime === "domestic_reverse_charge" &&
    !payload.reverseChargeCode
  ) {
    findings.push(
      error("reverseChargeCode", "reverse_charge_code_required"),
    );
  }
  return findings;
}

function paymentFindings(payload: ExtractionPayload): ValidationFinding[] {
  return !payload.payment.bankAccount?.trim() && !payload.payment.iban?.trim()
    ? [warning("payment.bankAccount", "missing_bank_account")] : [];
}

/** Pure deterministic validation of one Extraction Version. */
export function validateDocument(
  payload: ExtractionPayload,
  referenceData: DocumentValidationReferenceData,
): ValidationFinding[] {
  const findings: ValidationFinding[] = [
    ...identifierFindings(payload),
    ...requiredFieldFindings(payload),
    ...paymentFindings(payload),
  ];
  if (payload.direction === null) {
    findings.push(error("direction", "direction_unknown"));
  }
  if (!payload.proposedVatRegime) {
    findings.push(error("proposedVatRegime", "vat_regime_required"));
  }
  if (
    payload.proposedVatRegime === "other" ||
    ((payload.proposedVatRegime === "eu_acquisition_of_goods" ||
      payload.proposedVatRegime === "eu_received_service") &&
      payload.direction === "outgoing")
  ) {
    findings.push(
      warning("proposedVatRegime", "manual_classification_required"),
    );
  }
  const validRates = payload.taxPointDate
    ? referenceData.vatRates.find(
        (period) => period.validFrom <= payload.taxPointDate!,
      )?.rates
    : undefined;
  if (validRates) {
    payload.rateBreakdown.forEach((line, index) => {
      if (line.rate !== null && !validRates.includes(line.rate)) {
        findings.push(
          error(
            `rateBreakdown.${index}.rate`,
            "vat_rate_not_valid_on_tax_point_date",
          ),
        );
      }
    });
  }
  let rateNetCents = 0;
  let rateVatCents = 0;
  let everyRateAmountValid = true;

  payload.rateBreakdown.forEach((line, index) => {
    const netCents = amountCents(line.netAmount);
    const vatCents = amountCents(line.vatAmount);
    if (netCents === null || vatCents === null || line.rate === null) {
      everyRateAmountValid = false;
      findings.push(error(`rateBreakdown.${index}.${line.rate === null ? "rate" : netCents === null ? "netAmount" : "vatAmount"}`, "rate_breakdown_incomplete"));
      return;
    }
    rateNetCents += netCents;
    rateVatCents += vatCents;
    const selfAssessed =
      payload.proposedVatRegime === "domestic_reverse_charge" ||
      payload.proposedVatRegime === "eu_acquisition_of_goods" ||
      payload.proposedVatRegime === "eu_received_service";
    const expectedVatCents = Math.round((netCents * line.rate) / 100);
    if (!selfAssessed && Math.abs(expectedVatCents - vatCents) > referenceData.roundingToleranceCents) {
      findings.push(
        error(
          `rateBreakdown.${index}.vatAmount`,
          "rate_vat_amount_mismatch",
        ),
      );
    }
  });

  const totalNetCents = amountCents(payload.totals.netAmount);
  const totalVatCents = amountCents(payload.totals.vatAmount);
  const totalGrossCents = amountCents(payload.totals.grossAmount);
  const outsideTolerance = (left: number, right: number) =>
    Math.abs(left - right) > referenceData.roundingToleranceCents;

  if (
    everyRateAmountValid &&
    totalNetCents !== null &&
    outsideTolerance(rateNetCents, totalNetCents)
  ) {
    findings.push(error("totals.netAmount", "total_net_amount_mismatch"));
  }
  if (
    everyRateAmountValid &&
    totalVatCents !== null &&
    outsideTolerance(rateVatCents, totalVatCents)
  ) {
    findings.push(error("totals.vatAmount", "total_vat_amount_mismatch"));
  }
  if (
    totalNetCents !== null &&
    totalVatCents !== null &&
    totalGrossCents !== null &&
    outsideTolerance(totalNetCents + totalVatCents, totalGrossCents)
  ) {
    // VAT Reports use the Rate Breakdown, so a gross total off by rounding on
    // the Document is shown, not blocking.
    findings.push({
      ...warning("totals.grossAmount", "total_gross_amount_mismatch"),
      params: {
        difference: centsAmount(Math.abs(totalGrossCents - (totalNetCents + totalVatCents))),
      },
    });
  }

  return findings;
}

/** Apply current advisory rules when reading immutable historical findings. */
export function currentValidationFindings(
  payload: ExtractionPayload,
  findings: readonly ValidationFinding[],
): ValidationFinding[] {
  const historicalGrossError = findings.some((finding) =>
    finding.code === "total_gross_amount_mismatch" && finding.severity === "error");
  const grossWarning = historicalGrossError
    ? validateDocument(payload, CZECH_DOCUMENT_VALIDATION_REFERENCE_DATA)
      .find((finding) => finding.code === "total_gross_amount_mismatch")
    : undefined;
  const current = findings.map<ValidationFinding>((finding) => historicalGrossError && finding.code === "total_gross_amount_mismatch"
    ? grossWarning ?? { ...finding, severity: "warning" } : finding);
  const requiredRegime = !payload.proposedVatRegime
    ? [error("proposedVatRegime", "vat_regime_required")]
    : [];
  return [...current, ...[...paymentFindings(payload), ...requiredRegime]
    .filter((finding) => !current.some((entry) => entry.code === finding.code))];
}
