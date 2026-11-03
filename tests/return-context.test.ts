import { describe, expect, it } from "vitest";
import { documentDecisionHref } from "@/application/document-queue";
import { safeCompanyReturnTo, safeSecurityReturnTo, withCompanyReturnTo } from "@/application/return-context";

const companyId = "00000000-0000-4000-8000-000000000145";

describe("Company work return context", () => {
  it("retains the selected Processing period and workflow location through an explicit detail link", () => {
    const origin = `/companies/${companyId}/vat-reports?period=2026-10#vat-step-review`;
    expect(safeCompanyReturnTo(companyId, origin)).toBe(origin);
    const detail = withCompanyReturnTo(companyId, `/companies/${companyId}/documents/00000000-0000-4000-8000-000000000001`, origin);
    expect(new URL(detail, "https://ivat.test").searchParams.get("returnTo")).toBe(origin);
  });
  it.each([
    "https://evil.test/path", "//evil.test/path", "/\\evil.test/path", "/%5cevil.test/path", "/%2f%2fevil.test/path",
    `/companies/${companyId}/documents\\..\\..\\evil`, `/companies/${companyId}/documents%2f..%2f..`,
    `/companies/${companyId}/documents\n`, `/companies/${companyId}/settings`, `/companies/${companyId}/vat-reports/2026-10/xml`,
    "/companies/00000000-0000-4000-8000-000000000999/documents",
    `/companies/${companyId}/../00000000-0000-4000-8000-000000000999/documents`,
  ])("refuses a non-work or unsafe return destination %s", (target) => {
    expect(safeCompanyReturnTo(companyId, target)).toBeNull();
  });
  it("preserves batch dates/page and a safe parent origin while dropping unrelated redirect parameters", () => {
    const origin = `/companies/${companyId}/upload?createdFrom=2026-10-25&createdTo=2026-10-25&historyPage=2#batch-00000000-0000-4000-8000-000000000001`;
    expect(safeCompanyReturnTo(companyId, origin)).toBe(origin);
    const list = withCompanyReturnTo(companyId, `/companies/${companyId}/documents?view=all&counterparty=Acme+%26+syn&page=3&next=https://evil.test`, origin);
    const safe = new URL(safeCompanyReturnTo(companyId, list)!, "https://ivat.test");
    expect(safe.searchParams.get("returnTo")).toBe(origin);
    expect(safe.searchParams.get("counterparty")).toBe("Acme & syn");
    expect(safe.searchParams.get("page")).toBe("3");
    expect(safe.searchParams.has("next")).toBe(false);
  });
});

const documentId = "00000000-0000-4000-8000-000000000001";
it("returns a completed review decision to its original workflow, or a safe list fallback", () => {
  const returnTo = `/companies/${companyId}/vat-reports?period=2026-10#vat-step-review`;
  expect(documentDecisionHref(companyId, { documentId, nextDocumentId: "", queueQuery: "", returnTo })).toBe(returnTo);
  expect(documentDecisionHref(companyId, { documentId, nextDocumentId: "", queueQuery: "view=review&next=https://evil.test", returnTo: "//evil.test" }))
    .toBe(`/companies/${companyId}/documents?view=review#document-${documentId}`);
});
it("continues a filtered queue without losing its explicit list origin", () => {
  const returnTo = `/companies/${companyId}/documents?view=review&reportingPeriod=2026-10&page=3#document-${documentId}`;
  const href = new URL(documentDecisionHref(companyId, { documentId, nextDocumentId: documentId, queueQuery: "view=review&reportingPeriod=2026-10", returnTo }), "https://ivat.test");
  expect(href.searchParams.get("returnTo")).toBe(returnTo);
  expect(href.searchParams.get("reportingPeriod")).toBe("2026-10");
});

it("retains supported Security origins for Platform remediation and Company VAT settings", () => {
  expect(safeSecurityReturnTo("/platform/administration#operational-problems-title")).toBe("/platform/administration#operational-problems-title");
  expect(safeSecurityReturnTo(`/companies/${companyId}/settings/vat?generateYear=2027#reporting-years`)).toBe(`/companies/${companyId}/settings/vat?generateYear=2027#reporting-years`);
});

it.each([
  "https://evil.test/platform/settings", "//evil.test/platform/settings", "/\\evil.test/platform/settings",
  "/%2f%2fevil.test/platform/settings", "/platform/administration\n", "/platform/../platform/settings",
  "/platform/settings/delete", "/settings/security", "/mfa/enroll",
])("refuses unsafe or non-work Security origins %s", (origin) => {
  expect(safeSecurityReturnTo(origin)).toBeNull();
});
it("canonicalizes legacy management origins and removes unsupported redirect parameters", () => {
  expect(safeSecurityReturnTo(`/organizations/${companyId}/members?scope=organization&next=https://evil.test`))
    .toBe(`/organizations/${companyId}/users?scope=organization`);
  expect(safeSecurityReturnTo(`/companies/${companyId}/members?scope=organization`))
    .toBe(`/companies/${companyId}/settings/users?scope=organization`);
});
