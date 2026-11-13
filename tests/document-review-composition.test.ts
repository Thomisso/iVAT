import { expect, inject, it } from "vitest";
import { SAMPLE_EXTRACTION, fakeAiProvider } from "@/ai/fake";
import { readSourceFile } from "@/application/source-files";
import { uploadSourceFile } from "./support/source-upload";
import { createManualDocument, listDocuments, listExtractionVersions, saveAndApproveDocument } from "@/application/documents";
import { getDocumentReview } from "@/application/document-review";
import { getDocumentQueuePosition } from "@/application/document-queue";
import { createCounterparty, listCounterparties, updateCounterparty } from "@/application/counterparties";
import { generateVatReport, getVatReport } from "@/application/vat-reports";
import { getCompanyAiProcessingAllowance } from "@/application/ai-processing-allowance";
import { fakeVatPayerRegistry } from "@/vat-registry/fake";
import { administratorWithCompany, assignAiConfigurationFixture, companyMember } from "./support/fixtures";
import { fixtureFile } from "./support/files";
import { testWorker } from "./support/worker";
import { withClaimDate } from "./support/claim-clock";

it("composes source evidence, human period and partial choice, directory selection, exact warning consent and queue continuation into one immutable report", async () => {
  await withClaimDate(inject("databaseUrl"), "2026-11-07", async () => {
    const owner = await administratorWithCompany();
    const user = await companyMember(owner);
    const full = { ...SAMPLE_EXTRACTION, documentNumber: "COMPOSED-AI-242",
      rateBreakdown: [{ rate: 21, netAmount: "12000.00", vatAmount: "2520.00" }],
      totals: { netAmount: "12000.00", vatAmount: "2520.00", grossAmount: "14520.00" } };
    const worker = testWorker(fakeAiProvider({ extract: () => ({ ...full,
      sourceLocations: [{ fieldPath: "documentNumber", kind: "page", page: 1, x: 0.1, y: 0.1, width: 0.3, height: 0.05 }],
    }) }));
    await assignAiConfigurationFixture(owner.client, worker.jobs, { companyId: owner.companyId, provider: worker.ai });
    const bytes = fixtureFile("receipt.png");
    const uploaded = await uploadSourceFile(user.client, worker.jobs, { companyId: owner.companyId, fileName: "composition.png", bytes });
    if (!uploaded.ok) throw new Error(uploaded.error);
    expect(await worker.runJobs()).toEqual([]);
    const [document] = await listDocuments(user.client, owner.companyId, uploaded.value.id);
    const target = { companyId: owner.companyId, documentId: document.id };
    const original = (await getDocumentReview(user.client, target))!.current!;
    expect(original.author).toEqual({ kind: "ai" });
    expect(original.payload).not.toHaveProperty("partialClaim");
    expect(original.payload).not.toHaveProperty("claimEligibility");
    expect(original.payload.sourceEvidence).toMatchObject({ sourceFileId: uploaded.value.id,
      fields: { documentNumber: { origin: "ai", originalValue: "COMPOSED-AI-242" } } });

    const next = await createManualDocument(user.client, { companyId: owner.companyId,
      payload: { ...SAMPLE_EXTRACTION, documentNumber: "NEXT-IN-FILTERED-QUEUE-242" } }, undefined, fakeVatPayerRegistry());
    if (!next.ok) throw new Error(next.error);
    const directory = await createCounterparty(user.client, { companyId: owner.companyId, name: "Directory Supplier",
      supplier: true, customer: false });
    if (!directory.ok) throw new Error(directory.error);
    const search = { view: "review", direction: "incoming", reportingPeriod: "2026-10" };
    const beforeQueue = await getDocumentQueuePosition(user.client, owner.companyId, document.id, search);
    expect(beforeQueue.documents.map(row => row.id)).toContain(next.value.id);
    const registry = fakeVatPayerRegistry({ outcome: "checked", unreliable: false, publishedAccounts: [] });
    const input = { ...target, basedOnVersion: 1, requestId: crypto.randomUUID(), payload: { ...original.payload,
      documentNumber: "COMPOSED-CORRECTED-242", counterpartyLink: { id: directory.value.id },
      claimEligibility: { period: "2026-10", origin: "user" as const, confirmed: true },
      partialClaim: { confirmed: true, rateBreakdown: [{ rate: 21, netAmount: "6000.00", vatAmount: "1260.00" }] },
    } };
    const first = await saveAndApproveDocument(user.client, input, undefined, registry);
    expect(first).toMatchObject({ ok: false, error: "review_warnings_changed" });
    if (first.ok || first.error !== "review_warnings_changed") throw new Error("Expected explicit warning acknowledgement");
    expect(first.confirmation.findings).toContainEqual({ field: "payment.bankAccount", severity: "warning", code: "unpublished_bank_account" });
    expect(await listExtractionVersions(user.client, owner.companyId, document.id)).toEqual([original]);
    expect((await getDocumentReview(user.client, target))?.document.status).toBe("needs_review");
    const changed = { ...input, payload: { ...input.payload, documentNumber: "COMPOSED-FINAL-242" }, acknowledgement: first.confirmation.id };
    const second = await saveAndApproveDocument(user.client, changed, undefined, registry);
    expect(second).toMatchObject({ ok: false, error: "review_warnings_changed" });
    if (second.ok || second.error !== "review_warnings_changed") throw new Error("Changed values require fresh acknowledgement");
    const confirmed = { ...changed, acknowledgement: second.confirmation.id };
    expect(await saveAndApproveDocument(user.client, confirmed, undefined, registry)).toEqual({ ok: true, value: { version: 2 } });
    expect(await saveAndApproveDocument(user.client, confirmed, undefined, registry)).toEqual({ ok: true, value: { version: 2 } });
    const versions = await listExtractionVersions(user.client, owner.companyId, document.id);
    expect(versions).toHaveLength(2);
    expect(versions[0]).toEqual(original);
    expect(versions[1]).toMatchObject({ author: { kind: "user", userId: user.userId }, payload: {
      documentNumber: "COMPOSED-FINAL-242", rateBreakdown: full.rateBreakdown, totals: full.totals,
      partialClaim: { confirmed: true, rateBreakdown: [{ netAmount: "6000.00", vatAmount: "1260.00" }] },
      claimEligibility: { period: "2026-10", origin: "user", confirmed: true },
      counterpartyLink: { id: directory.value.id, recorded: { name: "Directory Supplier" } },
      sourceEvidence: { fields: { documentNumber: { origin: "manual", originalValue: "COMPOSED-AI-242" } } },
    } });
    expect(versions[1].payload.sourceEvidence!.fields.documentNumber.locations).toEqual(original.payload.sourceEvidence!.fields.documentNumber.locations);
    const position = await getDocumentQueuePosition(user.client, owner.companyId, document.id, search);
    expect(position.continuationDocumentId).toBe(next.value.id);
    expect(position.documents.map(row => row.id)).toEqual([next.value.id]);
    expect((await getDocumentQueuePosition(user.client, owner.companyId, document.id, {})).continuationDocumentId).toBeUndefined();
    expect(await generateVatReport(user.client, { companyId: owner.companyId, period: "2026-10" })).toMatchObject({ ok: true });
    const report = await getVatReport(user.client, owner.companyId, "2026-10");
    expect(report?.result.vatReturn.find(line => line.line === "40")).toMatchObject({ netAmount: "6000.00", vatAmount: "1260.00" });
    expect(report?.result.controlStatement).toMatchObject([{ section: "B.2", rateBreakdown: [{ netAmount: "6000.00", vatAmount: "1260.00" }] }]);
    expect(await updateCounterparty(user.client, { companyId: owner.companyId, id: directory.value.id,
      name: "Directory changed after reporting", supplier: true, customer: false })).toEqual({ ok: true, value: null });
    expect(await getVatReport(user.client, owner.companyId, "2026-10")).toEqual(report);
    expect((await getDocumentReview(user.client, { ...target, requestedVersion: "1" }))?.shown).toEqual(original);
    expect((await readSourceFile(user.client, owner.companyId, uploaded.value.id))?.bytes).toEqual(bytes);
    expect(await getCompanyAiProcessingAllowance(owner.client, owner.companyId)).toMatchObject({ ok: true, value: { used: 1 } });
    expect((await listCounterparties(user.client, owner.companyId)).total).toBe(1);
    expect(worker.queued).toEqual([]);
  });
});
