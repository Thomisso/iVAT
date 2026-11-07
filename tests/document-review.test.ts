import { createConfirmedManualDocument } from "./support/claim-eligibility";
import { expect, it } from "vitest";
import { SAMPLE_EXTRACTION } from "@/ai/fake";
import { refreshBankAccountCheck } from "@/application/bank-account-checks";
import { getDocumentReview } from "@/application/document-review";
import { correctDocument } from "@/application/documents";
import type { ExtractionPayload } from "@/application/extraction-payload";
import { fakeExchangeRates } from "@/cnb/fake";
import { fakeVatPayerRegistry } from "@/vat-registry/fake";
import { administratorWithCompany } from "./support/fixtures";

async function manualDocumentInReview(payload: ExtractionPayload = SAMPLE_EXTRACTION) {
  const company = await administratorWithCompany();
  const created = await createConfirmedManualDocument(company.client, { companyId: company.companyId, payload }, fakeExchangeRates(), fakeVatPayerRegistry());
  if (!created.ok) throw new Error(created.error);
  return { ...company, documentId: created.value.id };
}

it("loads current observations separately from the findings of a requested recorded Version", async () => {
  const document = await manualDocumentInReview({
    ...SAMPLE_EXTRACTION, documentNumber: "RECORDED-1",
    payment: { bankAccount: null, iban: null, variableSymbol: null },
  });
  const target = { companyId: document.companyId, documentId: document.documentId };
  expect(await correctDocument(document.client, {
    ...target, basedOnVersion: 1, payload: { ...SAMPLE_EXTRACTION, documentNumber: "CURRENT-2" },
  }, fakeExchangeRates(), fakeVatPayerRegistry({ outcome: "checked", unreliable: false, publishedAccounts: [] })))
    .toEqual({ ok: true, value: { version: 2 } });
  expect(await refreshBankAccountCheck(document.client, target, fakeVatPayerRegistry()))
    .toMatchObject({ ok: true, value: { version: 2, outcome: "published" } });

  const current = await getDocumentReview(document.client, target);
  expect(current).toMatchObject({
    current: { version: 2, payload: { documentNumber: "CURRENT-2" } },
    shown: { version: 2 }, viewingRecorded: false, shownFindings: [],
    bankChecks: { current: { version: 2, outcome: "published", checkedAt: expect.any(String) } },
    file: null, sourceRows: null, reviewing: true,
  });
  const recorded = await getDocumentReview(document.client, { ...target, requestedVersion: "1" });
  expect(recorded).toMatchObject({
    current: { version: 2 }, shown: { version: 1, payload: { documentNumber: "RECORDED-1" } },
    viewingRecorded: true,
    shownFindings: [{ field: "payment.bankAccount", severity: "warning", code: "missing_bank_account" }],
  });
  const recordedCurrent = await getDocumentReview(document.client, { ...target, requestedVersion: "2" });
  expect(recordedCurrent).toMatchObject({
    shown: { version: 2 }, viewingRecorded: true,
    shownFindings: [{ field: "payment.bankAccount", severity: "warning", code: "unpublished_bank_account" }],
  });
  for (const requestedVersion of ["999", "invalid", "02"]) {
    expect(await getDocumentReview(document.client, { ...target, requestedVersion }))
      .toMatchObject({ shown: { version: 2 }, viewingRecorded: false, shownFindings: [] });
  }
});
