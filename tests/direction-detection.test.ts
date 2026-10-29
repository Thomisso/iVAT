import { describe, expect, it } from "vitest";
import { SAMPLE_EXTRACTION } from "@/ai/fake";
import { detectDocumentDirection } from "@/application/direction-detection";

const company = { ico: "45274649", vatId: "CZ45274649" };

describe("automatic Direction detection", () => {
  it("detects an outgoing Document when the Company is the supplier", () => {
    expect(
      detectDocumentDirection(
        {
          ...SAMPLE_EXTRACTION,
          direction: "incoming",
          supplier: {
            ...SAMPLE_EXTRACTION.supplier,
            ico: "45274649",
            vatId: null,
          },
        },
        company,
        null,
      ),
    ).toBe("outgoing");
  });

  it("detects an incoming Document when the Company is the customer", () => {
    expect(
      detectDocumentDirection(
        {
          ...SAMPLE_EXTRACTION,
          direction: "outgoing",
          customer: {
            ...SAMPLE_EXTRACTION.customer,
            ico: null,
            vatId: "cz 45274649",
          },
        },
        company,
        null,
      ),
    ).toBe("incoming");
  });

  it("returns unknown for an invoice when neither party matches the Company", () => {
    expect(
      detectDocumentDirection(SAMPLE_EXTRACTION, company, null),
    ).toBeNull();
  });

  it.each(["receipt", "simplified_tax_document"] as const)(
    "treats an identified foreign supplier on a %s as incoming",
    (documentType) => {
      expect(detectDocumentDirection({
        ...SAMPLE_EXTRACTION,
        documentType,
        supplier: { ...SAMPLE_EXTRACTION.supplier, name: "Foreign shop", ico: null, vatId: "DE123456789" },
        customer: { name: null, ico: null, vatId: null, street: null, city: null, postalCode: null, country: null },
      }, company, null)).toBe("incoming");
    },
  );

  it("leaves a receipt unresolved when neither party is identifiable", () => {
    const unknown = { name: null, ico: null, vatId: null, street: null, city: null, postalCode: null, country: null };
    expect(detectDocumentDirection({
      ...SAMPLE_EXTRACTION,
      documentType: "receipt",
      supplier: unknown,
      customer: unknown,
    }, company, null)).toBeNull();
  });

  it("uses the upload preselection even when party matching says otherwise", () => {
    expect(
      detectDocumentDirection(
        {
          ...SAMPLE_EXTRACTION,
          supplier: {
            ...SAMPLE_EXTRACTION.supplier,
            vatId: company.vatId,
          },
        },
        company,
        "incoming",
      ),
    ).toBe("incoming");
  });
});
