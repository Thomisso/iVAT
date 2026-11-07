import { setOctoberImportFixture } from "./support/claim-eligibility";
import { describe, expect, it } from "vitest";
import { listAuditEvents } from "@/application/audit";
import {
  approveDocument,
  listCompanyDocuments,
  listDocuments,
  returnDocumentToReview,
} from "@/application/documents";
import { getReportingPeriodReadiness } from "@/application/reporting-period-readiness";
import { finalizeVatReport, generateVatReport, getVatReport } from "@/application/vat-reports";
import { uploadSourceFile } from "@/application/source-files";
import { fakeAiProvider, SAMPLE_EXTRACTION } from "@/ai/fake";
import { fixtureFile } from "./support/files";
import {
  administratorWithCompany,
  assignAiConfigurationFixture as enableAiProcessing,
  companyMember,
} from "./support/fixtures";
import { testWorker } from "./support/worker";

/** An Administrator whose Company holds one Approved Document, Extracted as SAMPLE_EXTRACTION. */
async function approvedDocument() {
  const worker = testWorker(fakeAiProvider({ extract: () => SAMPLE_EXTRACTION }));
  const admin = await administratorWithCompany();
  const enabled = await enableAiProcessing(admin.client, worker.jobs, { companyId: admin.companyId, provider: worker.ai });
  if (!enabled.ok) throw new Error(enabled.error);
  const uploaded = await uploadSourceFile(admin.client, worker.jobs, {
    companyId: admin.companyId,
    fileName: "receipt.png",
    bytes: fixtureFile("receipt.png"),
  });
  if (!uploaded.ok) throw new Error(uploaded.error);
  await setOctoberImportFixture(uploaded.value.id);
  await worker.runJobs();
  const [document] = await listDocuments(admin.client, admin.companyId, uploaded.value.id);
  const approved = await approveDocument(admin.client, { companyId: admin.companyId, documentId: document.id, version: 1 });
  if (!approved.ok) throw new Error(approved.error);
  return { ...admin, worker, sourceFileId: uploaded.value.id, documentId: document.id };
}

describe("Return to Review", () => {
  it("lets a User of the Company return an Approved Document to review, and audits it without personal data", async () => {
    const document = await approvedDocument();
    const member = await companyMember(document);

    expect(await returnDocumentToReview(member.client, document)).toEqual({ ok: true, value: null });

    expect((await listDocuments(member.client, document.companyId, document.sourceFileId))[0].status).toBe(
      "needs_review",
    );
    expect((await listAuditEvents(document.client, document.organizationId)).at(-1)).toEqual(
      expect.objectContaining({
        action: "document.returned_to_review",
        actorUserId: member.userId,
        companyId: document.companyId,
        targetType: "document",
        targetId: document.documentId,
        payload: {},
      }),
    );
  });

  it("is refused while the Document's Reporting Period has a Period Lock", async () => {
    const document = await approvedDocument();
    const [{ reportingPeriod }] = await listCompanyDocuments(document.client, document.companyId);
    const report = { companyId: document.companyId, period: reportingPeriod! };
    expect((await generateVatReport(document.client, report)).ok).toBe(true);
    expect(await finalizeVatReport(document.client, { ...report, confirmed: true })).toEqual({ ok: true, value: null });

    expect(await returnDocumentToReview(document.client, document)).toEqual({ ok: false, error: "period_locked" });

    expect((await listDocuments(document.client, document.companyId, document.sourceFileId))[0].status).toBe(
      "approved",
    );
  });

  it("leaves the VAT Report: a draft becomes out of date and a regenerated one excludes the Document", async () => {
    const document = await approvedDocument();
    const [{ reportingPeriod }] = await listCompanyDocuments(document.client, document.companyId);
    const report = { companyId: document.companyId, period: reportingPeriod! };
    expect((await generateVatReport(document.client, report)).ok).toBe(true);
    expect((await getVatReport(document.client, report.companyId, report.period))?.result.totals.inputVat).toBe("210.00");

    expect(await returnDocumentToReview(document.client, document)).toEqual({ ok: true, value: null });

    const readiness = await getReportingPeriodReadiness(document.client, report);
    if (!readiness.ok) throw new Error(readiness.error);
    expect(readiness.value.snapshot?.freshness).toBe("stale");
    expect(readiness.value.groups.needsReview).toEqual([document.documentId]);
    expect((await generateVatReport(document.client, report)).ok).toBe(true);
    const regenerated = await getVatReport(document.client, report.companyId, report.period);
    expect(regenerated?.result.totals.inputVat).toBe("0.00");
    expect(regenerated?.result.excludedDocuments).toEqual([
      { documentId: document.documentId, reason: "not_approved" },
    ]);
  });

  it("refuses a Document that is not approved", async () => {
    const document = await approvedDocument();
    await returnDocumentToReview(document.client, document);

    expect(await returnDocumentToReview(document.client, document)).toEqual({ ok: false, error: "not_approved" });
  });

  it("gives another Organization no access to the Document", async () => {
    const document = await approvedDocument();
    const outsider = await administratorWithCompany("Other Organization");

    expect(await returnDocumentToReview(outsider.client, document)).toEqual({ ok: false, error: "forbidden" });
    const direct = await outsider.client.rpc("return_document_to_review", { target_document_id: document.documentId });
    expect(direct.error?.code).toBe("42501");
  });
});
