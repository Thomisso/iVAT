import { createConfirmedManualDocument, setOctoberImportFixture } from "./support/claim-eligibility";
import { describe, expect, it } from "vitest";
import { fakeAiProvider, SAMPLE_EXTRACTION } from "@/ai/fake";
import { createCounterparty } from "@/application/counterparties";
import { finalizeVatReport, generateVatReport } from "@/application/vat-reports";
import { getDocumentReview } from "@/application/document-review";
import { refreshBankAccountCheck } from "@/application/bank-account-checks";
import { listAuditEvents } from "@/application/audit";
import { correctDocument, getDocument, listDocuments, listExtractionVersions, saveAndApproveDocument } from "@/application/documents";
import { fakeVatPayerRegistry } from "@/vat-registry/fake";
import { administratorWithCompany, assignAiConfigurationFixture } from "./support/fixtures";
import { uploadSourceFile } from "@/application/source-files";
import { fixtureFile } from "./support/files";
import { testWorker } from "./support/worker";

async function documentInReview(registry = fakeVatPayerRegistry()) {
  const user = await administratorWithCompany();
  const created = await createConfirmedManualDocument(user.client, { companyId: user.companyId, payload: SAMPLE_EXTRACTION }, undefined, registry);
  if (!created.ok) throw new Error(created.error);
  return { ...user, documentId: created.value.id };
}

describe("atomic Document approval", () => {
  it("saves the submitted correction and approves exactly that Version together", async () => {
    const document = await documentInReview();
    expect(await saveAndApproveDocument(document.client, {
      ...document, basedOnVersion: 1, requestId: crypto.randomUUID(),
      payload: { ...SAMPLE_EXTRACTION, documentNumber: "ATOMIC-228" },
    }, undefined, fakeVatPayerRegistry())).toEqual({ ok: true, value: { version: 2 } });
    expect((await getDocument(document.client, document.companyId, document.documentId))?.status).toBe("approved");
    const versions = await listExtractionVersions(document.client, document.companyId, document.documentId);
    expect(versions.map((version) => version.payload.documentNumber)).toEqual(["FV-2026-0001", "ATOMIC-228"]);
    const events = await listAuditEvents(document.client, document.organizationId);
    expect(events.filter((event) => event.targetId === document.documentId && ["document.corrected", "document.approved"].includes(event.action)).map((event) => ({ action: event.action, payload: event.payload }))).toEqual([
      { action: "document.corrected", payload: { version: 2 } },
      { action: "document.approved", payload: { version: 2 } },
    ]);
  });
  it("approves unchanged data without creating an empty User Version", async () => {
    const document = await documentInReview();
    const [current] = await listExtractionVersions(document.client, document.companyId, document.documentId);
    expect(await saveAndApproveDocument(document.client, {
      ...document, basedOnVersion: 1, requestId: crypto.randomUUID(), payload: current.payload,
    }, undefined, fakeVatPayerRegistry())).toEqual({ ok: true, value: { version: 1 } });
    expect(await listExtractionVersions(document.client, document.companyId, document.documentId)).toHaveLength(1);
  });

  it("replays one successful request without another Version or approval and refuses a different stale request", async () => {
    const document = await documentInReview();
    const input = { ...document, basedOnVersion: 1, requestId: crypto.randomUUID(), payload: { ...SAMPLE_EXTRACTION, documentNumber: "RETRY-228" } };
    const first = await saveAndApproveDocument(document.client, input, undefined, fakeVatPayerRegistry());
    expect(first).toEqual({ ok: true, value: { version: 2 } });
    expect(await saveAndApproveDocument(document.client, input, undefined, fakeVatPayerRegistry())).toEqual(first);
    expect(await saveAndApproveDocument(document.client, { ...input, requestId: crypto.randomUUID() }, undefined, fakeVatPayerRegistry())).toMatchObject({ ok: false, error: "stale_version" });
    expect(await saveAndApproveDocument(document.client, { ...input, basedOnVersion: 999 }, undefined, fakeVatPayerRegistry())).toMatchObject({ ok: false, error: "stale_version" });
    expect(await listExtractionVersions(document.client, document.companyId, document.documentId)).toHaveLength(2);
    const events = await listAuditEvents(document.client, document.organizationId);
    expect(events.filter((event) => event.targetId === document.documentId && event.action === "document.approved")).toHaveLength(1);
  });

  it("pauses for a newly prepared warning and confirms the exact submitted data and findings", async () => {
    const document = await documentInReview();
    const input = { ...document, basedOnVersion: 1, requestId: crypto.randomUUID(), payload: { ...SAMPLE_EXTRACTION, documentNumber: "WARNING-228" } };
    const registry = fakeVatPayerRegistry({ outcome: "checked", unreliable: false, publishedAccounts: [] });
    const first = await saveAndApproveDocument(document.client, input, undefined, registry);
    expect(first).toMatchObject({ ok: false, error: "review_warnings_changed", confirmation: { findings: [{ field: "payment.bankAccount", severity: "warning", code: "unpublished_bank_account" }] } });
    expect(await listExtractionVersions(document.client, document.companyId, document.documentId)).toHaveLength(1);
    expect((await getDocument(document.client, document.companyId, document.documentId))?.status).toBe("needs_review");
    if (first.ok || first.error !== "review_warnings_changed") throw new Error("expected warning confirmation");
    expect(await saveAndApproveDocument(document.client, { ...input, acknowledgement: first.confirmation.id }, undefined, registry)).toEqual({ ok: true, value: { version: 2 } });
  });

  it("invalidates acknowledgement after data, findings or directory context changes", async () => {
    const document = await documentInReview();
    const registry = fakeVatPayerRegistry({ outcome: "checked", unreliable: false, publishedAccounts: [] });
    const input = { ...document, basedOnVersion: 1, requestId: crypto.randomUUID(), payload: { ...SAMPLE_EXTRACTION, documentNumber: "CONFIRM-A" } };
    const first = await saveAndApproveDocument(document.client, input, undefined, registry);
    if (first.ok || first.error !== "review_warnings_changed") throw new Error("expected confirmation");
    const changed = { ...input, payload: { ...input.payload, documentNumber: "CONFIRM-B" }, acknowledgement: first.confirmation.id };
    const second = await saveAndApproveDocument(document.client, changed, undefined, registry);
    expect(second).toMatchObject({ ok: false, error: "review_warnings_changed" });
    if (second.ok || second.error !== "review_warnings_changed") throw new Error("expected new confirmation");
    const unreliable = fakeVatPayerRegistry({ outcome: "checked", unreliable: true, publishedAccounts: [] });
    const third = await saveAndApproveDocument(document.client, { ...changed, acknowledgement: second.confirmation.id }, undefined, unreliable);
    expect(third).toMatchObject({ ok: false, error: "review_warnings_changed", confirmation: { findings: expect.arrayContaining([{ field: "supplier.vatId", severity: "warning", code: "unreliable_vat_payer" }]) } });
    if (third.ok || third.error !== "review_warnings_changed") throw new Error("expected changed findings");
    expect((await createCounterparty(document.client, { companyId: document.companyId, name: "Changed directory", supplier: true, customer: false })).ok).toBe(true);
    expect(await saveAndApproveDocument(document.client, { ...changed, acknowledgement: third.confirmation.id }, undefined, unreliable)).toMatchObject({ ok: false, error: "review_warnings_changed" });
    expect(await listExtractionVersions(document.client, document.companyId, document.documentId)).toHaveLength(1);
  });

  it("reports a new target Period Lock without saving any submitted correction", async () => {
    const document = await documentInReview();
    const registry = { async check() {
      const period = { companyId: document.companyId, period: "2026-11" };
      expect((await generateVatReport(document.client, period)).ok).toBe(true);
      expect(await finalizeVatReport(document.client, { ...period, confirmed: true })).toEqual({ ok: true, value: null });
      return { outcome: "checked" as const, unreliable: false, publishedAccounts: ["123456789/0100"] };
    } };
    expect(await saveAndApproveDocument(document.client, { ...document, basedOnVersion: 1, requestId: crypto.randomUUID(), payload: { ...SAMPLE_EXTRACTION, taxPointDate: "2026-11-01", documentNumber: "LOCKED-228" } }, undefined, registry)).toMatchObject({ ok: false, error: "period_locked" });
    expect(await listExtractionVersions(document.client, document.companyId, document.documentId)).toHaveLength(1);
    expect((await getDocument(document.client, document.companyId, document.documentId))?.status).toBe("needs_review");
  });

  it("approves a real AI Version unchanged while retaining its author and confidence", async () => {
    const document = await administratorWithCompany();
    const worker = testWorker(fakeAiProvider());
    expect((await assignAiConfigurationFixture(document.client, worker.jobs, { companyId: document.companyId, provider: worker.ai })).ok).toBe(true);
    const uploaded = await uploadSourceFile(document.client, worker.jobs, { companyId: document.companyId, fileName: "receipt.png", bytes: fixtureFile("receipt.png") });
    if (!uploaded.ok) throw new Error(uploaded.error);
  await setOctoberImportFixture(uploaded.value.id);
    expect(await worker.runJobs()).toEqual([]);
    const [item] = await listDocuments(document.client, document.companyId, uploaded.value.id);
    const [ai] = await listExtractionVersions(document.client, document.companyId, item.id);
    expect(ai.author).toEqual({ kind: "ai" });
    expect(ai.payload.confidence).toEqual({ documentNumber: 0.98, "rateBreakdown.0.vatAmount": 0.95 });
    expect(await saveAndApproveDocument(document.client, { companyId: document.companyId, documentId: item.id, basedOnVersion: 1, requestId: crypto.randomUUID(), payload: ai.payload }, undefined, fakeVatPayerRegistry())).toEqual({ ok: true, value: { version: 1 } });
    expect(await listExtractionVersions(document.client, document.companyId, item.id)).toEqual([ai]);
  });

  it("serializes a double submission and replays without another registry call", async () => {
    const document = await documentInReview();
    const input = { ...document, basedOnVersion: 1, requestId: crypto.randomUUID(), payload: { ...SAMPLE_EXTRACTION, documentNumber: "DOUBLE-228" } };
    expect(await Promise.all([saveAndApproveDocument(document.client, input, undefined, fakeVatPayerRegistry()), saveAndApproveDocument(document.client, input, undefined, fakeVatPayerRegistry())])).toEqual([{ ok: true, value: { version: 2 } }, { ok: true, value: { version: 2 } }]);
    expect(await saveAndApproveDocument(document.client, input, undefined, { check: async () => { throw new Error("registry must not run for replay"); } })).toEqual({ ok: true, value: { version: 2 } });
    expect(await saveAndApproveDocument(document.client, { ...input, payload: { ...input.payload, documentNumber: "CHANGED-RETRY" } }, undefined, fakeVatPayerRegistry())).toMatchObject({ ok: false, error: "stale_version" });
    expect(await listExtractionVersions(document.client, document.companyId, document.documentId)).toHaveLength(2);
  });

  it.each([
    [{ direction: null }, "direction_required"],
    [{ proposedVatRegime: null }, "vat_regime_required"],
    [{ taxPointDate: null }, "tax_point_date_required"],
    [{ taxPointDate: "2026-02-30" }, "invalid_date"],
    [{ documentNumber: null }, "document_incomplete"],
    [{ totals: { netAmount: "999.00", vatAmount: "210.00", grossAmount: "1209.00" } }, "rate_breakdown_totals_mismatch"],
  ] as const)("enforces accounting guards in a direct authenticated atomic call (%j)", async (change, hint) => {
    const document = await documentInReview();
    const context = await document.client.rpc("document_review_context", { target_document_id: document.documentId, based_on_version: 1 });
    expect(context.error).toBeNull();
    const payload = { ...SAMPLE_EXTRACTION, documentNumber: "REFUSED-228", ...change };
    const result = await document.client.rpc("save_and_approve_document", { target_document_id: document.documentId, based_on_version: 1, request_id: crypto.randomUUID(), payload, submitted_payload: payload, findings: [], expected_context: context.data });
    expect(result.error).toMatchObject({ code: "P0001", hint });
    expect(await listExtractionVersions(document.client, document.companyId, document.documentId)).toHaveLength(1);
    expect((await getDocument(document.client, document.companyId, document.documentId))?.status).toBe("needs_review");
    const events = await listAuditEvents(document.client, document.organizationId);
    expect(events.filter((event) => event.targetId === document.documentId && ["document.corrected", "document.approved"].includes(event.action))).toEqual([]);
  });

  it("keeps confirmations and successful receipts isolated from another Organization", async () => {
    const document = await documentInReview();
    const foreign = await administratorWithCompany();
    const input = { ...document, basedOnVersion: 1, requestId: crypto.randomUUID(), payload: { ...SAMPLE_EXTRACTION, documentNumber: "ISOLATED-228" } };
    const registry = fakeVatPayerRegistry({ outcome: "checked", unreliable: false, publishedAccounts: [] });
    const warning = await saveAndApproveDocument(document.client, input, undefined, registry);
    if (warning.ok || warning.error !== "review_warnings_changed") throw new Error("expected confirmation");
    expect(await saveAndApproveDocument(foreign.client, { ...input, acknowledgement: warning.confirmation.id }, undefined, registry)).toEqual({ ok: false, error: "forbidden" });
    expect((await foreign.client.from("document_review_confirmation").select("id").eq("document_id", document.documentId)).data).toEqual([]);
    const forged = await foreign.client.from("document_review_confirmation").update({ findings: [] }).eq("id", warning.confirmation.id);
    expect(forged.error?.code).toBe("42501");
    expect((await saveAndApproveDocument(document.client, { ...input, acknowledgement: warning.confirmation.id }, undefined, registry)).ok).toBe(true);
    expect((await foreign.client.from("document_approval_receipt").select("request_id").eq("document_id", document.documentId)).data).toEqual([]);
    expect((await foreign.client.from("document_approval_receipt").update({ version: 999 }).eq("document_id", document.documentId).eq("request_id", input.requestId)).error?.code).toBe("42501");
    expect((await foreign.client.from("document_approval_receipt").delete().eq("document_id", document.documentId).eq("request_id", input.requestId)).error?.code).toBe("42501");
    expect(await saveAndApproveDocument(document.client, input, undefined, registry)).toEqual({ ok: true, value: { version: 2 } });
    expect((await foreign.client.rpc("document_approval_result", { target_document_id: document.documentId, request_id: input.requestId, submitted_payload: input.payload, based_on_version: 1 })).error?.code).toBe("42501");
  });

  it("preserves drafts with valid DUZP and refuses missing or invalid DUZP", async () => {
    const document = await documentInReview();
    expect(await correctDocument(document.client, { ...document, basedOnVersion: 1, payload: { ...SAMPLE_EXTRACTION, taxPointDate: null } })).toEqual({ ok: false, error: "tax_point_date_required" });
    expect(await correctDocument(document.client, { ...document, basedOnVersion: 1, payload: { ...SAMPLE_EXTRACTION, taxPointDate: "2026-02-30" } })).toEqual({ ok: false, error: "invalid_date" });
    expect(await correctDocument(document.client, { ...document, basedOnVersion: 1, payload: { ...SAMPLE_EXTRACTION, direction: null, documentNumber: null } }, undefined, fakeVatPayerRegistry())).toEqual({ ok: true, value: { version: 2 } });
    expect((await getDocument(document.client, document.companyId, document.documentId))?.status).toBe("needs_review");
  });

  it("returns the specific accounting refusal and freshly prepared field errors without a partial save", async () => {
    const document = await documentInReview();
    expect(await saveAndApproveDocument(document.client, { ...document, basedOnVersion: 1, requestId: crypto.randomUUID(), payload: { ...SAMPLE_EXTRACTION, documentNumber: "BAD-REGIME-228", proposedVatRegime: null } }, undefined, fakeVatPayerRegistry())).toMatchObject({ ok: false, error: "vat_regime_required", findings: expect.arrayContaining([{ field: "proposedVatRegime", code: "vat_regime_required", severity: "error" }]) });
    expect(await listExtractionVersions(document.client, document.companyId, document.documentId)).toHaveLength(1);
  });

  it("detects a concurrent correction during preparation and returns the actual current data", async () => {
    const document = await documentInReview();
    const registry = { async check() {
      expect((await correctDocument(document.client, { ...document, basedOnVersion: 1, payload: { ...SAMPLE_EXTRACTION, documentNumber: "CONCURRENT-228" } }, undefined, fakeVatPayerRegistry())).ok).toBe(true);
      return { outcome: "checked" as const, unreliable: false, publishedAccounts: ["123456789/0100"] };
    } };
    expect(await saveAndApproveDocument(document.client, { ...document, basedOnVersion: 1, requestId: crypto.randomUUID(), payload: { ...SAMPLE_EXTRACTION, documentNumber: "MY-DRAFT-228" } }, undefined, registry)).toMatchObject({ ok: false, error: "stale_version", conflict: { version: 2, status: "needs_review", payload: { documentNumber: "CONCURRENT-228" } } });
    expect((await listExtractionVersions(document.client, document.companyId, document.documentId)).map((version) => version.payload.documentNumber)).toEqual(["FV-2026-0001", "CONCURRENT-228"]);
  });

  it("detects a directory write during preparation without saving or approving", async () => {
    const document = await documentInReview();
    const registry = { async check() {
      expect((await createCounterparty(document.client, { companyId: document.companyId, name: "Concurrent directory", supplier: true, customer: false })).ok).toBe(true);
      return { outcome: "checked" as const, unreliable: false, publishedAccounts: ["123456789/0100"] };
    } };
    expect(await saveAndApproveDocument(document.client, { ...document, basedOnVersion: 1, requestId: crypto.randomUUID(), payload: { ...SAMPLE_EXTRACTION, documentNumber: "NO-PARTIAL-228" } }, undefined, registry)).toMatchObject({ ok: false, error: "review_context_changed", conflict: { version: 1, status: "needs_review" } });
    expect(await listExtractionVersions(document.client, document.companyId, document.documentId)).toHaveLength(1);
  });

  it.each([true, false])("uses the actual displayed Bank Account Check findings, not stored warnings (stored unpublished=%s)", async (storedUnpublished) => {
    const unpublished = fakeVatPayerRegistry({ outcome: "checked", unreliable: false, publishedAccounts: [] });
    const document = await documentInReview(storedUnpublished ? unpublished : fakeVatPayerRegistry());
    expect((await refreshBankAccountCheck(document.client, document, storedUnpublished ? fakeVatPayerRegistry() : unpublished)).ok).toBe(true);
    const displayed = await getDocumentReview(document.client, document);
    expect(displayed?.shownFindings.some((finding) => finding.code === "unpublished_bank_account")).toBe(!storedUnpublished);
    const [current] = await listExtractionVersions(document.client, document.companyId, document.documentId);
    const result = await saveAndApproveDocument(document.client, { ...document, basedOnVersion: 1, requestId: crypto.randomUUID(), payload: current.payload }, undefined, unpublished);
    if (storedUnpublished) {
      expect(result).toMatchObject({ ok: false, error: "review_warnings_changed" });
      expect((await getDocument(document.client, document.companyId, document.documentId))?.status).toBe("needs_review");
    } else expect(result).toEqual({ ok: true, value: { version: 1 } });
    expect(await listExtractionVersions(document.client, document.companyId, document.documentId)).toHaveLength(1);
  });

  it("replays a successful explicit draft save without confusing it with approval or a new save", async () => {
    const document = await documentInReview();
    const input = { ...document, basedOnVersion: 1, requestId: crypto.randomUUID(), payload: { ...SAMPLE_EXTRACTION, documentNumber: "DRAFT-RETRY-228" } };
    expect(await correctDocument(document.client, input, undefined, fakeVatPayerRegistry())).toEqual({ ok: true, value: { version: 2 } });
    expect(await correctDocument(document.client, input, undefined, fakeVatPayerRegistry())).toEqual({ ok: true, value: { version: 2 } });
    expect(await correctDocument(document.client, { ...input, requestId: crypto.randomUUID() }, undefined, fakeVatPayerRegistry())).toMatchObject({ ok: false, error: "stale_version", conflict: { version: 2 } });
    expect(await saveAndApproveDocument(document.client, input, undefined, fakeVatPayerRegistry())).toMatchObject({ ok: false, error: "stale_version" });
    expect(await correctDocument(document.client, { ...input, basedOnVersion: 2, requestId: crypto.randomUUID() }, undefined, fakeVatPayerRegistry())).toEqual({ ok: true, value: { version: 3 } });
    expect(await correctDocument(document.client, input, undefined, fakeVatPayerRegistry())).toEqual({ ok: true, value: { version: 2 } });
    expect((await getDocument(document.client, document.companyId, document.documentId))?.status).toBe("needs_review");
    expect(await listExtractionVersions(document.client, document.companyId, document.documentId)).toHaveLength(3);
  });

  it("does not implicitly acknowledge a Bank Account Check warning introduced after the displayed review", async () => {
    const document = await documentInReview();
    const displayed = await getDocumentReview(document.client, document);
    const unpublished = fakeVatPayerRegistry({ outcome: "checked", unreliable: false, publishedAccounts: [] });
    expect((await refreshBankAccountCheck(document.client, document, unpublished)).ok).toBe(true);
    const [current] = await listExtractionVersions(document.client, document.companyId, document.documentId);
    expect(await saveAndApproveDocument(document.client, { ...document, basedOnVersion: 1, requestId: crypto.randomUUID(), payload: current.payload, displayedBankAccountCheckId: displayed?.bankChecks.current?.id ?? null }, undefined, unpublished)).toMatchObject({ ok: false, error: "review_warnings_changed" });
    expect((await getDocument(document.client, document.companyId, document.documentId))?.status).toBe("needs_review");
  });

});
