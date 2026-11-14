import { expect, inject, it } from "vitest";
import { getCompany, listCompanyReportingYears, setCompanyAutomaticApproval } from "@/application/companies";
import { listAuditEvents } from "@/application/audit";
import { administratorWithCompany, assignAiConfigurationFixture, companyMember } from "./support/fixtures";
import { promotedSuperAdministrator } from "./support/platform";
import { createCounterparty, listCounterparties, updateCounterparty } from "@/application/counterparties";
import { SAMPLE_EXTRACTION, fakeAiProvider } from "@/ai/fake";
import { uploadSourceFile } from "./support/source-upload";
import { getDocumentReview } from "@/application/document-review";
import { getDocument, listDocuments, listExtractionVersions, startManualDocumentReview, correctDocument, reprocessDocument, createManualDocument, approveDocument, returnDocumentToReview } from "@/application/documents";
import { extractJob } from "@/application/processing";
import { getCompanyAiProcessingAllowance } from "@/application/ai-processing-allowance";
import { systemClient, testWorker } from "./support/worker";
import { withClaimDate } from "./support/claim-clock";
import { createConfirmedManualDocument, setOctoberImportFixture } from "./support/claim-eligibility";
import { fixtureFile } from "./support/files";
import { legacyUnknownApprovalFixture, privateWorkerApprovalRefusals } from "./support/automatic-approval-security";
import { fakeVatPayerRegistry } from "@/vat-registry/fake";
import { refreshBankAccountCheck } from "@/application/bank-account-checks";
import type { ExtractionPayload } from "@/application/extraction-payload";
import { generateVatReport, getVatReport, finalizeVatReport, getPeriodLock } from "@/application/vat-reports";

function heldRegistry() {
  const entered = Promise.withResolvers<void>();
  const released = Promise.withResolvers<void>();
  return {
    entered: entered.promise, release: () => released.resolve(),
    registry: { async check() {
      entered.resolve();
      await released.promise;
      return { outcome: "checked" as const, unreliable: false, publishedAccounts: ["123456789/0100"] };
    } },
  };
}

async function queueOctoberDocument(company: Awaited<ReturnType<typeof administratorWithCompany>>, worker: ReturnType<typeof testWorker>, suffix = "") {
  const bytes = new Uint8Array([...fixtureFile("receipt.png"), ...new TextEncoder().encode(suffix)]);
  const source = await uploadSourceFile(company.client, worker.jobs, { companyId: company.companyId, fileName: "receipt.png", bytes });
  if (!source.ok) throw new Error(source.error);
  await setOctoberImportFixture(source.value.id);
  await worker.runNextJob();
  const [document] = await listDocuments(company.client, company.companyId, source.value.id);
  return document;
}

it("preserves a successful rerun proposing a locked period without retrying AI or changing locked accounting", async () => {
  await withClaimDate(inject("databaseUrl"), "2026-10-15", async () => {
    const company = await administratorWithCompany();
    const rerunStarted = Promise.withResolvers<void>();
    const releaseRerun = Promise.withResolvers<void>();
    let providerCalls = 0;
    const outgoing = { ...SAMPLE_EXTRACTION, documentNumber: "RERUN-LOCKED-TARGET", supplier: SAMPLE_EXTRACTION.customer, customer: SAMPLE_EXTRACTION.supplier };
    const worker = testWorker(fakeAiProvider({ async extract() {
      providerCalls += 1;
      if (providerCalls === 1) return outgoing;
      if (providerCalls === 2) { rerunStarted.resolve(); await releaseRerun.promise; }
      return { ...outgoing, issueDate: "2026-09-01", taxPointDate: "2026-09-01", dueDate: "2026-09-15" };
    } }));
    await assignAiConfigurationFixture(company.client, worker.jobs, { companyId: company.companyId, provider: worker.ai });
    const document = await queueOctoberDocument(company, worker);
    expect(await worker.runJobs()).toEqual([]);
    const input = { companyId: company.companyId, documentId: document.id };
    const oldVersions = await listExtractionVersions(company.client, company.companyId, document.id);
    expect(await getDocument(company.client, company.companyId, document.id)).toMatchObject({ status: "needs_review" });

    const locked = await createConfirmedManualDocument(company.client, { companyId: company.companyId, payload: {
      ...SAMPLE_EXTRACTION, documentNumber: "LOCKED-SEPTEMBER-BASE", issueDate: "2026-09-01", taxPointDate: "2026-09-01", dueDate: "2026-09-15",
      supplier: { ...SAMPLE_EXTRACTION.supplier, name: "Locked supplier", ico: "12345679", vatId: "CZ12345679" },
    } }, undefined, fakeVatPayerRegistry());
    if (!locked.ok) throw new Error(locked.error);
    expect(await approveDocument(company.client, { companyId: company.companyId, documentId: locked.value.id, version: 1 })).toEqual({ ok: true, value: null });
    expect((await generateVatReport(company.client, { companyId: company.companyId, period: "2026-09" })).ok).toBe(true);
    expect(await finalizeVatReport(company.client, { companyId: company.companyId, period: "2026-09", confirmed: true })).toEqual({ ok: true, value: null });
    const lockedReport = await getVatReport(company.client, company.companyId, "2026-09");
    const lockedVersions = await listExtractionVersions(company.client, company.companyId, locked.value.id);
    const periodLock = await getPeriodLock(company.client, company.companyId, "2026-09");
    const directory = await listCounterparties(company.client, company.companyId);
    await setCompanyAutomaticApproval(company.client, { companyId: company.companyId, enabled: true });
    expect(await reprocessDocument(company.client, worker.jobs, { ...input, confirmed: true })).toEqual({ ok: true, value: null });
    const processing = worker.runJobs({ final: false });
    try {
      await rerunStarted.promise;
      expect(await getDocument(company.client, company.companyId, document.id)).toMatchObject({ status: "processing" });
      expect(await listExtractionVersions(company.client, company.companyId, document.id)).toEqual(oldVersions);
    } finally { releaseRerun.resolve(); }
    const errors = await processing;
    await worker.jobs.send(extractJob(document.id));
    const replayErrors = await worker.runJobs({ final: false });
    const versions = await listExtractionVersions(company.client, company.companyId, document.id);
    const current = await getDocumentReview(company.client, input);
    const allowance = await getCompanyAiProcessingAllowance(company.client, company.companyId);
    // These invariants also run on the recording-failure RED, before the success assertion.
    expect(await listCounterparties(company.client, company.companyId)).toEqual(directory);
    expect(await getVatReport(company.client, company.companyId, "2026-09")).toEqual(lockedReport);
    expect(await listExtractionVersions(company.client, company.companyId, locked.value.id)).toEqual(lockedVersions);
    expect(await getPeriodLock(company.client, company.companyId, "2026-09")).toEqual(periodLock);
    expect({ errors, replayErrors, providerCalls, versions: versions.length, status: current?.document.status, allowance })
      .toMatchObject({ errors: [], replayErrors: [], providerCalls: 2, versions: 2, status: "needs_review", allowance: { ok: true, value: { used: 2 } } });
    expect(versions[0]).toEqual(oldVersions[0]);
    expect(versions[1]).toMatchObject({ author: { kind: "ai" }, payload: { direction: "outgoing", taxPointDate: "2026-09-01" } });
    expect(current?.lockedPeriod).toBe("2026-09");
    expect(current?.approvalDecisions).toEqual([]);
    expect(await approveDocument(company.client, { ...input, version: 2 })).toEqual({ ok: false, error: "period_locked" });
    expect(await correctDocument(company.client, { ...input, basedOnVersion: 2, payload: outgoing }, undefined, fakeVatPayerRegistry()))
      .toEqual({ ok: false, error: "period_locked" });
    expect(await reprocessDocument(company.client, worker.jobs, { ...input, confirmed: true })).toEqual({ ok: false, error: "period_locked" });
    expect(await returnDocumentToReview(company.client, { companyId: company.companyId, documentId: locked.value.id }))
      .toEqual({ ok: false, error: "period_locked" });
  });
});

it.each(["outgoing", "nonordinary incoming"] as const)("preserves otherwise eligible %s AI for review when no Reporting Year provides a period", async direction => {
  await withClaimDate(inject("databaseUrl"), "2026-10-15", async () => {
    const company = await administratorWithCompany();
    const payload: ExtractionPayload = { ...SAMPLE_EXTRACTION,
      issueDate: "2025-10-01", taxPointDate: "2025-10-01", dueDate: "2025-10-15",
      supplier: direction === "outgoing" ? SAMPLE_EXTRACTION.customer : { ...SAMPLE_EXTRACTION.supplier, ico: null, vatId: "DE123456789", country: "DE" },
      customer: direction === "outgoing" ? SAMPLE_EXTRACTION.supplier : SAMPLE_EXTRACTION.customer,
      proposedVatRegime: direction === "outgoing" ? "domestic" : "eu_received_service",
    };
    expect(await listCompanyReportingYears(company.client, company.companyId)).not.toContainEqual(expect.objectContaining({ year: 2025 }));
    const worker = testWorker(fakeAiProvider({ extract: () => payload }));
    await assignAiConfigurationFixture(company.client, worker.jobs, { companyId: company.companyId, provider: worker.ai });
    await setCompanyAutomaticApproval(company.client, { companyId: company.companyId, enabled: true });
    const document = await queueOctoberDocument(company, worker);
    expect(await worker.runJobs()).toEqual([]);
    const review = await getDocumentReview(company.client, { companyId: company.companyId, documentId: document.id });
    expect(review).toMatchObject({ shownFindings: [], reporting: { period: null,
      mapping: { vatReturnUnknownReason: null, controlStatementUnknownReason: null } } });
    expect(review?.document.status).toBe("needs_review");
    expect(await listExtractionVersions(company.client, company.companyId, document.id)).toMatchObject([
      { version: 1, author: { kind: "ai" }, payload: { documentNumber: "FV-2026-0001" } },
    ]);
    expect((await listCounterparties(company.client, company.companyId)).total).toBe(0);
    expect(await getCompanyAiProcessingAllowance(company.client, company.companyId)).toMatchObject({ ok: true, value: { used: 1 } });
    expect((await listAuditEvents(company.client, company.organizationId)).filter(event => ["counterparty.created", "document.automatically_approved"].includes(event.action)))
      .toEqual([]);
  });
});

it("defaults automatic approval off and audits an Administrator's explicit policy changes", async () => {
  const company = await administratorWithCompany();
  expect(await getCompany(company.client, company.companyId)).toMatchObject({ automaticApprovalEnabled: false });
  expect(await setCompanyAutomaticApproval(company.client, { companyId: company.companyId, enabled: true }))
    .toEqual({ ok: true, value: null });
  expect(await getCompany(company.client, company.companyId)).toMatchObject({ automaticApprovalEnabled: true });
  const events = (await listAuditEvents(company.client, company.organizationId))
    .filter(event => event.action === "company.automatic_approval_changed");
  expect(events).toMatchObject([{ actorUserId: company.userId, targetId: company.companyId, payload: { enabled: true } }]);
});

it("shares only this Document's truthful decisions with Company Users and preserves legacy and repeated decisions", async () => {
  await withClaimDate(inject("databaseUrl"), "2026-10-15", async () => {
    const company = await administratorWithCompany();
    const user = await companyMember(company);
    const foreign = await administratorWithCompany();
    const worker = testWorker();
    await assignAiConfigurationFixture(company.client, worker.jobs, { companyId: company.companyId, provider: worker.ai });
    await setCompanyAutomaticApproval(company.client, { companyId: company.companyId, enabled: true });
    const document = await queueOctoberDocument(company, worker);
    expect(await worker.runJobs()).toEqual([]);
    const input = { companyId: company.companyId, documentId: document.id };
    const autoDecision = (await getDocumentReview(user.client, input))?.approvalDecisions;
    expect(autoDecision).toMatchObject([{ mode: "automatic", version: 1, actorUserId: null }]);
    expect(await listAuditEvents(user.client, company.organizationId)).toEqual([]);
    expect((await foreign.client.rpc("document_approval_decisions", { target_document_id: document.id })).error?.code).toBe("42501");
    expect(await getDocumentReview(foreign.client, input)).toBeNull();
    expect(await returnDocumentToReview(user.client, input)).toEqual({ ok: true, value: null });
    expect(await approveDocument(user.client, { ...input, version: 1 })).toEqual({ ok: true, value: null });
    const human = await getDocumentReview(user.client, input);
    expect(human?.approvalDecisions).toMatchObject([
      { mode: "automatic", version: 1, actorUserId: null }, { mode: "human", version: 1, actorUserId: user.userId },
    ]);
    expect(human?.approvalDecisions[0]).toEqual(autoDecision?.[0]);
    await legacyUnknownApprovalFixture(company.organizationId, company.companyId, document.id);
    const historical = await getDocumentReview(user.client, { ...input, requestedVersion: "1" });
    expect(historical?.approvalDecisions.at(-1)).toMatchObject({ mode: "unknown", version: null, actorUserId: null });
    expect(historical?.versions).toHaveLength(1);
  });
});

it("does not start automatic approval for manual creation, correction or Partial Claim selection", async () => {
  const company = await administratorWithCompany();
  await setCompanyAutomaticApproval(company.client, { companyId: company.companyId, enabled: true });
  const created = await createManualDocument(company.client, { companyId: company.companyId, payload: SAMPLE_EXTRACTION }, undefined, fakeVatPayerRegistry());
  if (!created.ok) throw new Error(created.error);
  const input = { companyId: company.companyId, documentId: created.value.id };
  expect(await correctDocument(company.client, { ...input, basedOnVersion: 1,
    payload: { ...SAMPLE_EXTRACTION, partialClaim: { confirmed: true, rateBreakdown: [{ rate: 21, netAmount: "500.00", vatAmount: "105.00" }] } },
  }, undefined, fakeVatPayerRegistry())).toEqual({ ok: true, value: { version: 2 } });
  expect((await getDocumentReview(company.client, input))?.document.status).toBe("needs_review");
  expect((await listExtractionVersions(company.client, company.companyId, input.documentId)).map(version => version.author))
    .toEqual([{ kind: "user", userId: company.userId }, { kind: "user", userId: company.userId }]);
  expect(await getCompanyAiProcessingAllowance(company.client, company.companyId)).toMatchObject({ ok: true, value: { used: 0 } });
  expect((await listCounterparties(company.client, company.companyId)).total).toBe(0);
  expect((await listAuditEvents(company.client, company.organizationId)).filter(event => event.action === "document.automatically_approved")).toEqual([]);
});

it("refuses an unreserved completion and does not hide the recording failure or create an orphan", async () => {
  const company = await administratorWithCompany();
  const worker = testWorker();
  await assignAiConfigurationFixture(company.client, worker.jobs, { companyId: company.companyId, provider: worker.ai });
  await setCompanyAutomaticApproval(company.client, { companyId: company.companyId, enabled: true });
  const document = await queueOctoberDocument(company, worker);
  const system = systemClient();
  // These are the same request inputs the public worker reads before calling its completion RPC.
  const request = await system.from("document").select("extraction_request_id").eq("id", document.id).single();
  const state = await system.from("company").select("data_revision").eq("id", company.companyId).single();
  if (request.error || state.error) throw request.error ?? state.error;
  const completed = await system.rpc("record_ai_extraction_with_approval", {
    target_document_id: document.id, target_extraction_request_id: request.data.extraction_request_id,
    target_reservation_id: crypto.randomUUID(), provider: "fake", model: "fake-extract", payload: SAMPLE_EXTRACTION,
    findings: [], expected_company_revision: state.data.data_revision,
    assessment: { supportedMapping: true, registryVerification: "checked", payload: SAMPLE_EXTRACTION },
  });
  expect(completed.error).toMatchObject({ message: "AI Processing Allowance reservation is missing" });
  expect(await listExtractionVersions(company.client, company.companyId, document.id)).toEqual([]);
  expect((await listCounterparties(company.client, company.companyId)).total).toBe(0);
  expect(await getCompanyAiProcessingAllowance(company.client, company.companyId)).toMatchObject({ ok: true, value: { used: 0 } });
});

it("automatically approves supported foreign supply when the existing Czech registry check is not applicable", async () => {
  await withClaimDate(inject("databaseUrl"), "2026-10-15", async () => {
    const company = await administratorWithCompany();
    const party = { ...SAMPLE_EXTRACTION.supplier, ico: null, vatId: "DE123456789", country: "DE" };
    const payload = { ...SAMPLE_EXTRACTION, supplier: party, proposedVatRegime: "eu_received_service" as const };
    const entry = await createCounterparty(company.client, { companyId: company.companyId,
      name: party.name!, ico: party.ico, vatId: party.vatId, street: party.street!, city: party.city!,
      postalCode: party.postalCode!, countryCode: party.country, supplier: true, customer: false });
    if (!entry.ok) throw new Error(entry.error);
    const worker = testWorker(fakeAiProvider({ extract: () => payload }), { async check() {
      throw new Error("This foreign supplier has no applicable Czech registry check");
    } });
    await assignAiConfigurationFixture(company.client, worker.jobs, { companyId: company.companyId, provider: worker.ai });
    await setCompanyAutomaticApproval(company.client, { companyId: company.companyId, enabled: true });
    const document = await queueOctoberDocument(company, worker);
    expect(await worker.runJobs()).toEqual([]);
    const review = await getDocumentReview(company.client, { companyId: company.companyId, documentId: document.id });
    expect(review).toMatchObject({ document: { status: "approved" }, shownFindings: [],
      reporting: { mapping: { vatReturnLines: ["5", "43"], controlStatementSection: "A.2" } } });
    expect(await listExtractionVersions(company.client, company.companyId, document.id)).toHaveLength(1);
    expect(await getCompanyAiProcessingAllowance(company.client, company.companyId)).toMatchObject({ ok: true, value: { used: 1 } });
  });
});

it("keeps initial AI usable for review when its Reporting Period is already locked", async () => {
  await withClaimDate(inject("databaseUrl"), "2026-10-15", async () => {
    const company = await administratorWithCompany();
    const worker = testWorker();
    await assignAiConfigurationFixture(company.client, worker.jobs, { companyId: company.companyId, provider: worker.ai });
    await setCompanyAutomaticApproval(company.client, { companyId: company.companyId, enabled: true });
    expect((await generateVatReport(company.client, { companyId: company.companyId, period: "2026-10" })).ok).toBe(true);
    expect(await finalizeVatReport(company.client, { companyId: company.companyId, period: "2026-10", confirmed: true })).toEqual({ ok: true, value: null });
    const document = await queueOctoberDocument(company, worker);
    expect(await worker.runJobs()).toEqual([]);
    expect((await getDocumentReview(company.client, { companyId: company.companyId, documentId: document.id }))?.document.status).toBe("needs_review");
    expect(await listExtractionVersions(company.client, company.companyId, document.id)).toHaveLength(1);
    expect((await listCounterparties(company.client, company.companyId)).total).toBe(0);
    expect(await getCompanyAiProcessingAllowance(company.client, company.companyId)).toMatchObject({ ok: true, value: { used: 1 } });
  });
});

it("preserves automatic approval, immutable AI history and a locked report after later warnings and duplicates", async () => {
  await withClaimDate(inject("databaseUrl"), "2026-10-15", async () => {
    const company = await administratorWithCompany();
    const worker = testWorker();
    await assignAiConfigurationFixture(company.client, worker.jobs, { companyId: company.companyId, provider: worker.ai });
    await setCompanyAutomaticApproval(company.client, { companyId: company.companyId, enabled: true });
    const document = await queueOctoberDocument(company, worker);
    expect(await worker.runJobs()).toEqual([]);
    const input = { companyId: company.companyId, documentId: document.id };
    const history = await listExtractionVersions(company.client, company.companyId, document.id);
    expect((await generateVatReport(company.client, { companyId: company.companyId, period: "2026-10" })).ok).toBe(true);
    expect(await finalizeVatReport(company.client, { companyId: company.companyId, period: "2026-10", confirmed: true })).toEqual({ ok: true, value: null });
    const saved = await getVatReport(company.client, company.companyId, "2026-10");
    expect(await refreshBankAccountCheck(company.client, input, fakeVatPayerRegistry({ outcome: "checked", unreliable: false, publishedAccounts: [] })))
      .toMatchObject({ ok: true, value: { outcome: "unpublished" } });
    const duplicate = await queueOctoberDocument(company, worker, "later-duplicate");
    expect(await worker.runJobs()).toEqual([]);
    expect((await getDocumentReview(company.client, { companyId: company.companyId, documentId: duplicate.id }))?.document.status).toBe("needs_review");
    const review = await getDocumentReview(company.client, input);
    expect(review?.document.status).toBe("approved");
    expect(review?.shownFindings).toContainEqual({ field: "payment.bankAccount", severity: "warning", code: "unpublished_bank_account" });
    expect(await listExtractionVersions(company.client, company.companyId, document.id)).toEqual(history);
    expect(await getVatReport(company.client, company.companyId, "2026-10")).toEqual(saved);
    expect((await listAuditEvents(company.client, company.organizationId)).filter(event => event.action === "document.automatically_approved")).toHaveLength(1);
  });
});

it.each([
  { name: "warning", payload: { ...SAMPLE_EXTRACTION, totals: { ...SAMPLE_EXTRACTION.totals, grossAmount: "1211.00" } } },
  { name: "error", payload: { ...SAMPLE_EXTRACTION, totals: { ...SAMPLE_EXTRACTION.totals, netAmount: "1001.00" } } },
  { name: "unsupported mapping", payload: { ...SAMPLE_EXTRACTION, rateBreakdown: [{ rate: 0, netAmount: "1000.00", vatAmount: "0.00" }], totals: { netAmount: "1000.00", vatAmount: "0.00", grossAmount: "1000.00" } } },
  { name: "missing required verification", payload: { ...SAMPLE_EXTRACTION, payment: { ...SAMPLE_EXTRACTION.payment, bankAccount: null, iban: null } } },
  { name: "missing same-period facts", payload: { ...SAMPLE_EXTRACTION, issueDate: "2026-09-30" } },
] satisfies { name: string; payload: ExtractionPayload }[])("preserves successful AI for review with $name", async ({ name, payload }) => {
  await withClaimDate(inject("databaseUrl"), "2026-10-15", async () => {
    const company = await administratorWithCompany();
    const worker = testWorker(fakeAiProvider({ extract: () => payload }), name === "missing required verification"
      ? fakeVatPayerRegistry({ outcome: "not_found" }) : fakeVatPayerRegistry());
    await assignAiConfigurationFixture(company.client, worker.jobs, { companyId: company.companyId, provider: worker.ai });
    await setCompanyAutomaticApproval(company.client, { companyId: company.companyId, enabled: true });
    const document = await queueOctoberDocument(company, worker);
    expect(await worker.runJobs()).toEqual([]);
    const review = await getDocumentReview(company.client, { companyId: company.companyId, documentId: document.id });
    expect(review?.document.status).toBe("needs_review");
    if (name === "missing required verification") expect(review?.shownFindings).toContainEqual({ field: "payment.bankAccount", severity: "warning", code: "missing_bank_account" });
    expect(await listExtractionVersions(company.client, company.companyId, document.id)).toHaveLength(1);
    expect((await listCounterparties(company.client, company.companyId)).total).toBe(0);
    expect(await getCompanyAiProcessingAllowance(company.client, company.companyId)).toMatchObject({ ok: true, value: { used: 1 } });
  });
});

it("does not approve the older duplicate when its AI completes after the newer Document", async () => {
  await withClaimDate(inject("databaseUrl"), "2026-10-15", async () => {
    const company = await administratorWithCompany();
    const olderWorker = testWorker();
    const newerWorker = testWorker();
    await assignAiConfigurationFixture(company.client, olderWorker.jobs, { companyId: company.companyId, provider: olderWorker.ai });
    await setCompanyAutomaticApproval(company.client, { companyId: company.companyId, enabled: true });
    const older = await queueOctoberDocument(company, olderWorker, "older-source");
    const newer = await queueOctoberDocument(company, newerWorker, "newer-source");
    expect(await newerWorker.runJobs()).toEqual([]);
    expect((await getDocumentReview(company.client, { companyId: company.companyId, documentId: newer.id }))?.document.status).toBe("approved");
    expect(await olderWorker.runJobs()).toEqual([]);
    expect((await getDocumentReview(company.client, { companyId: company.companyId, documentId: older.id }))?.document.status).toBe("needs_review");
    expect((await getDocumentReview(company.client, { companyId: company.companyId, documentId: newer.id }))?.document.status).toBe("approved");
    expect((await listCounterparties(company.client, company.companyId)).total).toBe(1);
    expect(await getCompanyAiProcessingAllowance(company.client, company.companyId)).toMatchObject({ ok: true, value: { used: 2 } });
  });
});

it("converges concurrent and replayed worker jobs on one Version, directory identity and automatic decision", async () => {
  await withClaimDate(inject("databaseUrl"), "2026-10-15", async () => {
    const company = await administratorWithCompany();
    const worker = testWorker();
    await assignAiConfigurationFixture(company.client, worker.jobs, { companyId: company.companyId, provider: worker.ai });
    await setCompanyAutomaticApproval(company.client, { companyId: company.companyId, enabled: true });
    const document = await queueOctoberDocument(company, worker);
    await worker.jobs.send(extractJob(document.id));
    expect(await worker.runJobsConcurrently()).toEqual([]);
    worker.releaseDelayedJobs();
    await worker.jobs.send(extractJob(document.id));
    expect(await worker.runJobs()).toEqual([]);
    expect(await listExtractionVersions(company.client, company.companyId, document.id)).toHaveLength(1);
    expect((await listCounterparties(company.client, company.companyId)).total).toBe(1);
    expect(await getCompanyAiProcessingAllowance(company.client, company.companyId)).toMatchObject({ ok: true, value: { used: 1 } });
    expect((await listAuditEvents(company.client, company.organizationId)).filter(event => event.action === "document.automatically_approved"))
      .toHaveLength(1);
  });
});

it("requires human reconfirmation of a prior Partial Claim after an explicit new AI Extraction", async () => {
  await withClaimDate(inject("databaseUrl"), "2026-10-15", async () => {
    const company = await administratorWithCompany();
    const worker = testWorker();
    await assignAiConfigurationFixture(company.client, worker.jobs, { companyId: company.companyId, provider: worker.ai });
    const document = await queueOctoberDocument(company, worker);
    expect(await worker.runJobs()).toEqual([]);
    const input = { companyId: company.companyId, documentId: document.id };
    expect(await correctDocument(company.client, { ...input, basedOnVersion: 1,
      payload: { ...SAMPLE_EXTRACTION, partialClaim: { confirmed: true, rateBreakdown: [{ rate: 21, netAmount: "500.00", vatAmount: "105.00" }] } },
    }, undefined, fakeVatPayerRegistry())).toEqual({ ok: true, value: { version: 2 } });
    const history = await listExtractionVersions(company.client, company.companyId, document.id);
    await setCompanyAutomaticApproval(company.client, { companyId: company.companyId, enabled: true });
    expect(await reprocessDocument(company.client, worker.jobs, { ...input, confirmed: true })).toEqual({ ok: true, value: null });
    expect(await worker.runJobs()).toEqual([]);
    const versions = await listExtractionVersions(company.client, company.companyId, document.id);
    expect(versions).toHaveLength(3);
    expect(versions.slice(0, 2)).toEqual(history);
    expect(versions[2].payload.partialClaim).toMatchObject({ confirmed: false, rateBreakdown: [{ netAmount: "500.00", vatAmount: "105.00" }] });
    expect((await getDocumentReview(company.client, input))?.document.status).toBe("needs_review");
    expect(await getCompanyAiProcessingAllowance(company.client, company.companyId)).toMatchObject({ ok: true, value: { used: 2 } });
    expect((await listCounterparties(company.client, company.companyId)).total).toBe(0);
  });
});

it.each(["policy", "directory", "human"] as const)("does not approve stale prepared AI after a concurrent %s change", async change => {
  await withClaimDate(inject("databaseUrl"), "2026-10-15", async () => {
    const company = await administratorWithCompany();
    const party = SAMPLE_EXTRACTION.supplier;
    const entry = await createCounterparty(company.client, { companyId: company.companyId,
      name: party.name!, ico: party.ico, vatId: party.vatId, street: party.street!, city: party.city!,
      postalCode: party.postalCode!, countryCode: party.country!, supplier: true, customer: false });
    if (!entry.ok) throw new Error(entry.error);
    const barrier = heldRegistry();
    const worker = testWorker(fakeAiProvider(), barrier.registry);
    await assignAiConfigurationFixture(company.client, worker.jobs, { companyId: company.companyId, provider: worker.ai });
    await setCompanyAutomaticApproval(company.client, { companyId: company.companyId, enabled: true });
    const source = await uploadSourceFile(company.client, worker.jobs, { companyId: company.companyId,
      fileName: "receipt.png", bytes: fixtureFile("receipt.png") });
    if (!source.ok) throw new Error(source.error);
    await setOctoberImportFixture(source.value.id);
    await worker.runNextJob();
    const [document] = await listDocuments(company.client, company.companyId, source.value.id);
    const input = { companyId: company.companyId, documentId: document.id };
    const pending = worker.runJobs();
    try {
      await barrier.entered;
      if (change === "policy") {
        await setCompanyAutomaticApproval(company.client, { companyId: company.companyId, enabled: false });
        // Returning the flag to its old value must not validate stale preparation.
        await setCompanyAutomaticApproval(company.client, { companyId: company.companyId, enabled: true });
      } else if (change === "directory") {
        expect(await updateCounterparty(company.client, { companyId: company.companyId, id: entry.value.id,
          name: "Directory changed during registry request", ico: party.ico, vatId: party.vatId,
          street: party.street!, city: party.city!, postalCode: party.postalCode!, countryCode: party.country!, supplier: true, customer: false }))
          .toEqual({ ok: true, value: null });
      } else {
        expect(await startManualDocumentReview(company.client, input)).toEqual({ ok: true, value: null });
        expect(await correctDocument(company.client, { ...input, basedOnVersion: 0,
          payload: { ...SAMPLE_EXTRACTION, documentNumber: "HUMAN-WORK" } }, undefined, fakeVatPayerRegistry()))
          .toEqual({ ok: true, value: { version: 1 } });
      }
    } finally { barrier.release(); }
    expect(await pending).toEqual([]);
    expect((await getDocumentReview(company.client, input))?.document.status).toBe("needs_review");
    const versions = await listExtractionVersions(company.client, company.companyId, document.id);
    expect(versions).toHaveLength(1);
    expect(versions[0]).toMatchObject(change === "human"
      ? { author: { kind: "user", userId: company.userId }, payload: { documentNumber: "HUMAN-WORK" } }
      : { author: { kind: "ai" } });
    expect(await getCompanyAiProcessingAllowance(company.client, company.companyId)).toMatchObject({ ok: true, value: { used: change === "human" ? 0 : 1 } });
    expect((await listAuditEvents(company.client, company.organizationId)).filter(event => event.action === "document.automatically_approved")).toEqual([]);
  });
});

it("keeps automatic transitions and directory writes unavailable to human callers and private helpers unavailable to the worker", async () => {
  const company = await administratorWithCompany();
  const worker = testWorker();
  await assignAiConfigurationFixture(company.client, worker.jobs, { companyId: company.companyId, provider: worker.ai });
  const source = await uploadSourceFile(company.client, worker.jobs, { companyId: company.companyId,
    fileName: "receipt.png", bytes: fixtureFile("receipt.png") });
  if (!source.ok) throw new Error(source.error);
  await worker.runNextJob();
  const [document] = await listDocuments(company.client, company.companyId, source.value.id);
  const user = await companyMember(company);
  for (const client of [company.client, user.client]) {
    expect((await client.rpc("record_ai_extraction_with_approval", {
      target_document_id: document.id, target_extraction_request_id: crypto.randomUUID(), target_reservation_id: crypto.randomUUID(),
      provider: "fake", model: "fake-extract", payload: SAMPLE_EXTRACTION, findings: [], expected_company_revision: 0,
      assessment: { supportedMapping: true, registryVerified: true },
    })).error?.code).toBe("42501");
  }
  const system = systemClient();
  expect((await system.from("counterparty").insert({ organization_id: company.organizationId, company_id: company.companyId, name: "Unowned system identity", supplier: true })).error?.code)
    .toBe("42501");
  expect((await system.rpc("create_counterparty", { target_company_id: company.companyId,
    counterparty_name: "Unowned system identity", counterparty_ico: "27082440", counterparty_vat_id: "CZ27082440",
    counterparty_street: "", counterparty_city: "", counterparty_postal_code: "", counterparty_country_code: "CZ",
    counterparty_supplier: true, counterparty_customer: false })).error?.code).toBe("42501");
  expect(await privateWorkerApprovalRefusals(document.id, company.companyId)).toEqual(["42501", "42501"]);
  expect((await listCounterparties(company.client, company.companyId)).total).toBe(0);
  expect(await listExtractionVersions(company.client, company.companyId, document.id)).toEqual([]);
});

it("preserves a successful Extraction and one allowance without orphan identity when temporal approval fails", async () => {
  await withClaimDate(inject("databaseUrl"), "2029-01-03", async () => {
    const company = await administratorWithCompany();
    const worker = testWorker();
    await assignAiConfigurationFixture(company.client, worker.jobs, { companyId: company.companyId, provider: worker.ai });
    await setCompanyAutomaticApproval(company.client, { companyId: company.companyId, enabled: true });
    const source = await uploadSourceFile(company.client, worker.jobs, { companyId: company.companyId,
      fileName: "receipt.png", bytes: fixtureFile("receipt.png") });
    if (!source.ok) throw new Error(source.error);
    await setOctoberImportFixture(source.value.id);
    expect(await worker.runJobs()).toEqual([]);
    const [document] = await listDocuments(company.client, company.companyId, source.value.id);
    expect(document.status).toBe("needs_review");
    expect(await listExtractionVersions(company.client, company.companyId, document.id)).toMatchObject([
      { version: 1, author: { kind: "ai" }, payload: { documentNumber: "FV-2026-0001" } },
    ]);
    expect((await listCounterparties(company.client, company.companyId)).total).toBe(0);
    expect(await getCompanyAiProcessingAllowance(company.client, company.companyId)).toMatchObject({ ok: true, value: { used: 1 } });
    expect((await listAuditEvents(company.client, company.organizationId)).filter(event => ["counterparty.created", "document.automatically_approved"].includes(event.action)))
      .toEqual([]);
  });
});

it("does not approve an existing AI result when policy is enabled or a bank check refreshes", async () => {
  await withClaimDate(inject("databaseUrl"), "2026-10-15", async () => {
    const company = await administratorWithCompany();
    const worker = testWorker();
    await assignAiConfigurationFixture(company.client, worker.jobs, { companyId: company.companyId, provider: worker.ai });
    const source = await uploadSourceFile(company.client, worker.jobs, { companyId: company.companyId,
      fileName: "receipt.png", bytes: fixtureFile("receipt.png") });
    if (!source.ok) throw new Error(source.error);
    await setOctoberImportFixture(source.value.id);
    expect(await worker.runJobs()).toEqual([]);
    const [document] = await listDocuments(company.client, company.companyId, source.value.id);
    await setCompanyAutomaticApproval(company.client, { companyId: company.companyId, enabled: true });
    await refreshBankAccountCheck(company.client, { companyId: company.companyId, documentId: document.id }, fakeVatPayerRegistry());
    expect((await getDocumentReview(company.client, { companyId: company.companyId, documentId: document.id }))?.document.status).toBe("needs_review");
    expect(await listExtractionVersions(company.client, company.companyId, document.id)).toHaveLength(1);
    expect(worker.queued).toEqual([]);
    expect((await listCounterparties(company.client, company.companyId)).total).toBe(0);
  });
});

it("creates an identified Counterparty only with successful automatic approval in the same AI Version", async () => {
  await withClaimDate(inject("databaseUrl"), "2026-10-15", async () => {
    const company = await administratorWithCompany();
    const worker = testWorker();
    await assignAiConfigurationFixture(company.client, worker.jobs, { companyId: company.companyId, provider: worker.ai });
    await setCompanyAutomaticApproval(company.client, { companyId: company.companyId, enabled: true });
    const source = await uploadSourceFile(company.client, worker.jobs, { companyId: company.companyId,
      fileName: "receipt.png", bytes: fixtureFile("receipt.png") });
    if (!source.ok) throw new Error(source.error);
    await setOctoberImportFixture(source.value.id);
    expect(await worker.runJobs()).toEqual([]);
    const [document] = await listDocuments(company.client, company.companyId, source.value.id);
    expect(document.status).toBe("approved");
    const entries = await listCounterparties(company.client, company.companyId);
    expect(entries.total).toBe(1);
    expect(await listExtractionVersions(company.client, company.companyId, document.id)).toMatchObject([
      { version: 1, author: { kind: "ai" }, payload: { counterpartyLink: { id: entries.entries[0].id } } },
    ]);
    expect(await getCompanyAiProcessingAllowance(company.client, company.companyId)).toMatchObject({ ok: true, value: { used: 1 } });
    expect((await listAuditEvents(company.client, company.organizationId)).filter(event => event.action === "counterparty.created"))
      .toMatchObject([{ actorUserId: null }]);
  });
});

it("enforces policy changes through real Company access and Administrator authority", async () => {
  const company = await administratorWithCompany();
  const user = await companyMember(company);
  const foreign = await administratorWithCompany();
  for (const client of [user.client, foreign.client]) {
    expect(await setCompanyAutomaticApproval(client, { companyId: company.companyId, enabled: true }))
      .toEqual({ ok: false, error: "forbidden" });
    expect((await client.from("company").update({ automatic_approval_enabled: true }).eq("id", company.companyId)).error?.code)
      .toBe("42501");
  }
  expect(await getCompany(company.client, company.companyId)).toMatchObject({ automaticApprovalEnabled: false });
  const operator = await promotedSuperAdministrator("Automatic approval operator");
  expect(await setCompanyAutomaticApproval(operator.client, { companyId: company.companyId, enabled: true }))
    .toEqual({ ok: true, value: null });
  expect((await listAuditEvents(company.client, company.organizationId)).filter(event => event.action === "company.automatic_approval_changed"))
    .toMatchObject([{ actorUserId: operator.userId, payload: { enabled: true } }]);
});

it.each([undefined, { documentNumber: 0.01 }])("automatically approves a new eligible AI Extraction with one AI Version and one allowance use, independently of confidence %j", async confidence => {
  await withClaimDate(inject("databaseUrl"), "2026-10-15", async () => {
    const company = await administratorWithCompany();
    const party = SAMPLE_EXTRACTION.supplier;
    const entry = await createCounterparty(company.client, { companyId: company.companyId,
      name: party.name!, ico: party.ico, vatId: party.vatId, street: party.street!, city: party.city!,
      postalCode: party.postalCode!, countryCode: party.country!, supplier: true, customer: false });
    expect(entry.ok).toBe(true);
    const worker = testWorker(fakeAiProvider({ extract: () => ({ ...SAMPLE_EXTRACTION, confidence }) }));
    await assignAiConfigurationFixture(company.client, worker.jobs, { companyId: company.companyId, provider: worker.ai });
    expect(await setCompanyAutomaticApproval(company.client, { companyId: company.companyId, enabled: true })).toEqual({ ok: true, value: null });
    const source = await uploadSourceFile(company.client, worker.jobs, { companyId: company.companyId,
      fileName: "receipt.png", bytes: fixtureFile("receipt.png") });
    if (!source.ok) throw new Error(source.error);
    await setOctoberImportFixture(source.value.id);
    expect(await worker.runJobs()).toEqual([]);
    const [document] = await listDocuments(company.client, company.companyId, source.value.id);
    const review = await getDocumentReview(company.client, { companyId: company.companyId, documentId: document.id });
    expect(review).toMatchObject({ document: { status: "approved" }, shownFindings: [],
      approvalDecisions: [{ mode: "automatic", version: 1, actorUserId: null }], current: { payload: {
      claimEligibility: { origin: "same_period", confirmed: true }, counterpartyLink: { id: entry.ok ? entry.value.id : "" },
    } } });
    const versions = await listExtractionVersions(company.client, company.companyId, document.id);
    expect(versions).toHaveLength(1);
    expect(versions[0]).toMatchObject({ version: 1, author: { kind: "ai" } });
    expect(versions[0].payload).not.toHaveProperty("sourceEvidence");
    expect(await getCompanyAiProcessingAllowance(company.client, company.companyId)).toMatchObject({ ok: true, value: { used: 1 } });
    expect((await listAuditEvents(company.client, company.organizationId)).filter(event => event.action === "document.automatically_approved"))
      .toMatchObject([{ actorUserId: null, targetId: document.id, payload: { version: 1 } }]);
  });
});
