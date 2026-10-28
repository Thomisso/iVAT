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

  it("returns unknown when neither party matches the Company", () => {
    expect(
      detectDocumentDirection(SAMPLE_EXTRACTION, company, null),
    ).toBeNull();
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
