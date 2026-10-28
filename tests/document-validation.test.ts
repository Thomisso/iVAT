import { describe, expect, it } from "vitest";
import {
  CZECH_DOCUMENT_VALIDATION_REFERENCE_DATA,
  validateDocument,
} from "@/application/document-validation";
import { SAMPLE_EXTRACTION } from "@/ai/fake";

describe("Document validation", () => {
  it("returns no findings for a consistent Czech domestic invoice", () => {
    expect(
      validateDocument(
        SAMPLE_EXTRACTION,
        CZECH_DOCUMENT_VALIDATION_REFERENCE_DATA,
      ),
    ).toEqual([]);
  });

  it("finds Rate Breakdown and total arithmetic outside the rounding tolerance", () => {
    const payload = {
      ...SAMPLE_EXTRACTION,
      rateBreakdown: [
        { rate: 21, netAmount: "1000.00", vatAmount: "209.00" },
        { rate: 12, netAmount: "500.00", vatAmount: "60.00" },
      ],
      totals: {
        netAmount: "1499.00",
        vatAmount: "268.00",
        grossAmount: "1766.00",
      },
    };

    expect(
      validateDocument(payload, CZECH_DOCUMENT_VALIDATION_REFERENCE_DATA),
    ).toEqual([
      {
        field: "rateBreakdown.0.vatAmount",
        severity: "error",
        code: "rate_vat_amount_mismatch",
      },
      {
        field: "totals.netAmount",
        severity: "error",
        code: "total_net_amount_mismatch",
      },
      {
        field: "totals.vatAmount",
        severity: "error",
        code: "total_vat_amount_mismatch",
      },
      {
        field: "totals.grossAmount",
        severity: "error",
        code: "total_gross_amount_mismatch",
      },
    ]);
  });

  it("accepts a two-cent rounding difference", () => {
    const payload = {
      ...SAMPLE_EXTRACTION,
      rateBreakdown: [
        { rate: 21, netAmount: "1000.00", vatAmount: "209.98" },
      ],
      totals: {
        netAmount: "1000.02",
        vatAmount: "210.00",
        grossAmount: "1210.02",
      },
    };

    expect(
      validateDocument(payload, CZECH_DOCUMENT_VALIDATION_REFERENCE_DATA),
    ).toEqual([]);
  });

  it("checks each VAT rate against the reference data in force on the Tax Point Date", () => {
    const payload = {
      ...SAMPLE_EXTRACTION,
      taxPointDate: "2026-10-01",
      rateBreakdown: [
        { rate: 15, netAmount: "1000.00", vatAmount: "150.00" },
      ],
      totals: {
        netAmount: "1000.00",
        vatAmount: "150.00",
        grossAmount: "1150.00",
      },
    };

    expect(
      validateDocument(payload, CZECH_DOCUMENT_VALIDATION_REFERENCE_DATA),
    ).toEqual([
      {
        field: "rateBreakdown.0.rate",
        severity: "error",
        code: "vat_rate_not_valid_on_tax_point_date",
      },
    ]);
    expect(
      validateDocument(
        { ...payload, taxPointDate: "2023-10-01" },
        CZECH_DOCUMENT_VALIDATION_REFERENCE_DATA,
      ),
    ).toEqual([]);
  });

  it("checks the format and checksum of IČO and Czech VAT IDs", () => {
    const payload = {
      ...SAMPLE_EXTRACTION,
      supplier: {
        ...SAMPLE_EXTRACTION.supplier,
        ico: "27082441",
        vatId: "CZ27082441",
      },
      customer: {
        ...SAMPLE_EXTRACTION.customer,
        ico: "123",
        vatId: "SK27082440",
      },
    };

    expect(
      validateDocument(payload, CZECH_DOCUMENT_VALIDATION_REFERENCE_DATA),
    ).toEqual([
      {
        field: "supplier.ico",
        severity: "error",
        code: "invalid_ico_checksum",
      },
      {
        field: "supplier.vatId",
        severity: "error",
        code: "invalid_vat_id_checksum",
      },
      {
        field: "customer.ico",
        severity: "error",
        code: "invalid_ico_format",
      },
      {
        field: "customer.vatId",
        severity: "error",
        code: "invalid_vat_id_format",
      },
    ]);
  });

  it.each([
    [
      "domestic entries above CZK 10,000",
      {
        ...SAMPLE_EXTRACTION,
        supplier: { ...SAMPLE_EXTRACTION.supplier, vatId: null },
        rateBreakdown: [
          { rate: 21, netAmount: "10000.00", vatAmount: "2100.00" },
        ],
        totals: {
          netAmount: "10000.00",
          vatAmount: "2100.00",
          grossAmount: "12100.00",
        },
      },
      "supplier.vatId",
    ],
    [
      "EU acquisitions",
      {
        ...SAMPLE_EXTRACTION,
        proposedVatRegime: "eu_acquisition_of_goods" as const,
        supplier: { ...SAMPLE_EXTRACTION.supplier, vatId: null },
      },
      "supplier.vatId",
    ],
    [
      "outgoing domestic reverse charge",
      {
        ...SAMPLE_EXTRACTION,
        proposedVatRegime: "domestic_reverse_charge" as const,
        direction: "outgoing" as const,
        customer: { ...SAMPLE_EXTRACTION.customer, vatId: null },
      },
      "customer.vatId",
    ],
  ])("requires a counterparty VAT ID for %s", (_case, payload, field) => {
    expect(
      validateDocument(payload, CZECH_DOCUMENT_VALIDATION_REFERENCE_DATA),
    ).toContainEqual({
      field,
      severity: "error",
      code: "counterparty_vat_id_required",
    });
  });

  it("does not require a counterparty VAT ID below the domestic Control Statement threshold", () => {
    expect(
      validateDocument(
        {
          ...SAMPLE_EXTRACTION,
          supplier: { ...SAMPLE_EXTRACTION.supplier, vatId: null },
        },
        CZECH_DOCUMENT_VALIDATION_REFERENCE_DATA,
      ),
    ).toEqual([]);
  });
});
