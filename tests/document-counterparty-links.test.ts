import { createConfirmedManualDocument } from "./support/claim-eligibility";
import { directoryIdentityDuringApproval, attemptHistoricalCounterpartyDelete } from "./support/counterparty-link-race";
import { expect, it } from "vitest";
import { SAMPLE_EXTRACTION } from "@/ai/fake";
import { createCounterparty, updateCounterparty, listCounterpartyDocuments } from "@/application/counterparties";
import { correctDocument, listExtractionVersions, saveAndApproveDocument } from "@/application/documents";
import { getDocumentReview } from "@/application/document-review";
import { fakeVatPayerRegistry } from "@/vat-registry/fake";
import { createCompany } from "@/application/companies";
import { generateVatReport, getVatReport, finalizeVatReport } from "@/application/vat-reports";
import { listAuditEvents } from "@/application/audit";
import { administratorWithCompany, companyDetails } from "./support/fixtures";

it("links an existing Counterparty while preserving the Document's own Party and earlier Version", async () => {
  const company = await administratorWithCompany();
  const entry = await createCounterparty(company.client, { companyId: company.companyId, name: "Directory Supplier", supplier: true, customer: false });
  if (!entry.ok) throw new Error(entry.error);
  const payload = { ...SAMPLE_EXTRACTION, supplier: { ...SAMPLE_EXTRACTION.supplier, name: "Recorded Supplier" } };
  const created = await createConfirmedManualDocument(company.client, { companyId: company.companyId, payload }, undefined, fakeVatPayerRegistry());
  if (!created.ok) throw new Error(created.error);
  const target = { companyId: company.companyId, documentId: created.value.id };
  const linked = { ...payload, counterpartyLink: { id: entry.value.id } };
  expect(await correctDocument(company.client, { ...target, basedOnVersion: 1, requestId: crypto.randomUUID(), payload: linked }, undefined, fakeVatPayerRegistry())).toEqual({ ok: true, value: { version: 2 } });
  const review = await getDocumentReview(company.client, target);
  expect(review?.current?.payload).toMatchObject({ supplier: { name: "Recorded Supplier" }, counterpartyLink: { id: entry.value.id, recorded: { name: "Directory Supplier" } } });
  const versions = await listExtractionVersions(company.client, company.companyId, created.value.id);
  expect(versions[0].payload).not.toHaveProperty("counterpartyLink");
});

it("shows today's material differences while recorded Versions and historical-only links stay truthful", async () => {
  const company = await administratorWithCompany();
  const entry = await createCounterparty(company.client, { companyId: company.companyId, name: "Recorded Supplier", ico: "27082440", supplier: true, customer: false });
  if (!entry.ok) throw new Error(entry.error);
  const created = await createConfirmedManualDocument(company.client, { companyId: company.companyId, payload: SAMPLE_EXTRACTION }, undefined, fakeVatPayerRegistry());
  if (!created.ok) throw new Error(created.error);
  const target = { companyId: company.companyId, documentId: created.value.id };
  const linked = { ...SAMPLE_EXTRACTION, counterpartyLink: { id: entry.value.id } };
  expect((await correctDocument(company.client, { ...target, basedOnVersion: 1, payload: linked }, undefined, fakeVatPayerRegistry())).ok).toBe(true);
  const before = await getDocumentReview(company.client, { ...target, requestedVersion: "2" });
  expect((await updateCounterparty(company.client, { companyId: company.companyId, id: entry.value.id, name: "Today's Supplier", supplier: true, customer: false })).ok).toBe(true);
  const current = await getDocumentReview(company.client, target);
  expect(current?.shownFindings).toContainEqual(expect.objectContaining({ code: "counterparty_directory_difference", params: { documentValue: SAMPLE_EXTRACTION.supplier.name, directoryValue: "Today's Supplier" } }));
  expect((await getDocumentReview(company.client, { ...target, requestedVersion: "2" }))?.shownFindings).toEqual(before?.shownFindings);
  expect(current?.current?.payload).toMatchObject({ supplier: SAMPLE_EXTRACTION.supplier, counterpartyLink: { recorded: { name: "Recorded Supplier" } } });
  expect((await correctDocument(company.client, { ...target, basedOnVersion: 2, payload: SAMPLE_EXTRACTION }, undefined, fakeVatPayerRegistry())).ok).toBe(true);
  expect(await listCounterpartyDocuments(company.client, company.companyId, entry.value.id)).toMatchObject({ total: 1, entries: [{ documentId: created.value.id, version: 2, documentNumber: "FV-2026-0001" }] });
});

it("binds link-only approval and acknowledgements to fresh directory details without empty corrections", async () => {
  const company = await administratorWithCompany();
  const entry = await createCounterparty(company.client, { companyId: company.companyId, name: "Directory Before", supplier: true, customer: false });
  if (!entry.ok) throw new Error(entry.error);
  const created = await createConfirmedManualDocument(company.client, { companyId: company.companyId, payload: SAMPLE_EXTRACTION }, undefined, fakeVatPayerRegistry());
  if (!created.ok) throw new Error(created.error);
  const input = { companyId: company.companyId, documentId: created.value.id, basedOnVersion: 1, requestId: crypto.randomUUID(), payload: { ...SAMPLE_EXTRACTION, counterpartyLink: { id: entry.value.id } } };
  const pending = await saveAndApproveDocument(company.client, input, undefined, fakeVatPayerRegistry());
  expect(pending).toMatchObject({ ok: false, error: "review_warnings_changed" });
  if (pending.ok || pending.error !== "review_warnings_changed") throw new Error("expected directory warning");
  expect(await listExtractionVersions(company.client, company.companyId, created.value.id)).toHaveLength(1);
  expect((await updateCounterparty(company.client, { companyId: company.companyId, id: entry.value.id, name: "Directory After", supplier: true, customer: false })).ok).toBe(true);
  const changed = await saveAndApproveDocument(company.client, { ...input, acknowledgement: pending.confirmation.id }, undefined, fakeVatPayerRegistry());
  expect(changed).toMatchObject({ ok: false, error: "review_warnings_changed" });
  if (changed.ok || changed.error !== "review_warnings_changed") throw new Error("expected new directory warning");
  expect(await saveAndApproveDocument(company.client, { ...input, acknowledgement: changed.confirmation.id }, undefined, fakeVatPayerRegistry())).toEqual({ ok: true, value: { version: 2 } });
  expect(await saveAndApproveDocument(company.client, input, undefined, fakeVatPayerRegistry())).toEqual({ ok: true, value: { version: 2 } });
  expect((await getDocumentReview(company.client, input))?.current?.payload).toMatchObject({ counterpartyLink: { id: entry.value.id, recorded: { name: "Directory After" } }, supplier: SAMPLE_EXTRACTION.supplier });
});

it("refuses a foreign Company's existing entry even for a caller with access to both Companies", async () => {
  const company = await administratorWithCompany();
  const other = await createCompany(company.client, { organizationId: company.organizationId, ...companyDetails() });
  if (!other.ok) throw new Error(other.error);
  const entry = await createCounterparty(company.client, { companyId: other.value.id, name: "Foreign Company entry", supplier: true, customer: false });
  if (!entry.ok) throw new Error(entry.error);
  const created = await createConfirmedManualDocument(company.client, { companyId: company.companyId, payload: SAMPLE_EXTRACTION }, undefined, fakeVatPayerRegistry());
  if (!created.ok) throw new Error(created.error);
  const target = { companyId: company.companyId, documentId: created.value.id };
  const payload = { ...SAMPLE_EXTRACTION, counterpartyLink: { id: entry.value.id, recorded: SAMPLE_EXTRACTION.supplier } };
  expect(await correctDocument(company.client, { ...target, basedOnVersion: 1, requestId: crypto.randomUUID(), payload }, undefined, fakeVatPayerRegistry())).toEqual({ ok: false, error: "forbidden" });
  const context = await company.client.rpc("document_review_context", { target_document_id: target.documentId, based_on_version: 1 });
  expect(context.error).toBeNull();
  const direct = await company.client.rpc("save_and_approve_document", { target_document_id: target.documentId, based_on_version: 1, request_id: crypto.randomUUID(), payload, submitted_payload: payload, findings: [], expected_context: context.data });
  expect(direct.error?.code).toBe("42501");
  const directDraft = await company.client.rpc("save_document_review", { target_document_id: target.documentId, based_on_version: 1, request_id: crypto.randomUUID(), payload, submitted_payload: payload, findings: [] });
  expect(directDraft.error?.code).toBe("42501");
  expect(await listExtractionVersions(company.client, target.companyId, target.documentId)).toHaveLength(1);
  expect((await getDocumentReview(company.client, target))?.document.status).toBe("needs_review");
  expect((await listAuditEvents(company.client, company.organizationId)).filter(event => event.targetId === target.documentId && ["document.corrected", "document.approved"].includes(event.action))).toEqual([]);
  expect((await listCounterpartyDocuments(company.client, other.value.id, entry.value.id)).total).toBe(0);
});

it("normalizes formatting without hiding material outgoing customer differences or forged recorded details", async () => {
  const company = await administratorWithCompany();
  const party = { name: "Novák a syn", ico: "27082440", vatId: "CZ27082440", street: "Nová 12", city: "Praha", postalCode: "12000", country: "CZ" };
  const entry = await createCounterparty(company.client, { companyId: company.companyId, ...party, countryCode: "cz", supplier: true, customer: true });
  if (!entry.ok) throw new Error(entry.error);
  const payload = { ...SAMPLE_EXTRACTION, direction: "outgoing" as const, customer: { ...party, name: " Novák  a   syn ", ico: "2708 2440", vatId: "cz 27082440", postalCode: "120 00", country: "cz" }, counterpartyLink: { id: entry.value.id, recorded: { ...party, name: "Forged" } } };
  const created = await createConfirmedManualDocument(company.client, { companyId: company.companyId, payload }, undefined, fakeVatPayerRegistry());
  if (!created.ok) throw new Error(created.error);
  const target = { companyId: company.companyId, documentId: created.value.id };
  const review = await getDocumentReview(company.client, target);
  expect(review?.shownFindings.filter(f => f.code === "counterparty_directory_difference")).toEqual([]);
  expect(review?.current?.payload.counterpartyLink?.recorded?.name).toBe("Novák a syn");
  expect((await updateCounterparty(company.client, { companyId: company.companyId, id: entry.value.id, ...party, name: "Novak a syn", countryCode: "CZ", supplier: true, customer: true })).ok).toBe(true);
  expect((await getDocumentReview(company.client, target))?.shownFindings).toContainEqual(expect.objectContaining({ field: "customer.name", code: "counterparty_directory_difference" }));
});

it("keeps stored reports, approved Party fields and historical links unchanged after directory edits", async () => {
  const company = await administratorWithCompany();
  const party = SAMPLE_EXTRACTION.supplier;
  const entry = await createCounterparty(company.client, { companyId: company.companyId, name: party.name!, ico: party.ico, vatId: party.vatId, street: party.street!, city: party.city!, postalCode: party.postalCode!, countryCode: party.country!, supplier: true, customer: false });
  if (!entry.ok) throw new Error(entry.error);
  const created = await createConfirmedManualDocument(company.client, { companyId: company.companyId, payload: SAMPLE_EXTRACTION }, undefined, fakeVatPayerRegistry());
  if (!created.ok) throw new Error(created.error);
  const input = { companyId: company.companyId, documentId: created.value.id, basedOnVersion: 1, requestId: crypto.randomUUID(), payload: { ...SAMPLE_EXTRACTION, counterpartyLink: { id: entry.value.id } } };
  expect(await saveAndApproveDocument(company.client, input, undefined, fakeVatPayerRegistry())).toEqual({ ok: true, value: { version: 2 } });
  const period = { companyId: company.companyId, period: "2026-10" };
  expect((await generateVatReport(company.client, period)).ok).toBe(true);
  const stored = await getVatReport(company.client, company.companyId, period.period);
  expect(await finalizeVatReport(company.client, { ...period, confirmed: true })).toEqual({ ok: true, value: null });
  const versions = await listExtractionVersions(company.client, company.companyId, created.value.id);
  expect((await updateCounterparty(company.client, { companyId: company.companyId, id: entry.value.id, name: "After finalization", supplier: true, customer: false })).ok).toBe(true);
  expect(await listExtractionVersions(company.client, company.companyId, created.value.id)).toEqual(versions);
  const report = await getVatReport(company.client, company.companyId, period.period);
  expect(report?.result).toEqual(stored?.result);
  expect(report?.documents).toEqual(stored?.documents);
  const review = await getDocumentReview(company.client, input);
  expect(review).toMatchObject({ document: { status: "approved" }, reviewing: false, current: { payload: { supplier: party } } });
  expect(review?.shownFindings).toContainEqual(expect.objectContaining({ code: "counterparty_directory_difference" }));
  expect(await correctDocument(company.client, { ...input, basedOnVersion: 2, requestId: crypto.randomUUID(), payload: SAMPLE_EXTRACTION }, undefined, fakeVatPayerRegistry())).toMatchObject({ ok: false, error: "not_in_review" });
});

it("uses the same live warning projection and rendered directory context for unchanged visible warnings", async () => {
  const company = await administratorWithCompany();
  const party = SAMPLE_EXTRACTION.supplier;
  const entry = await createCounterparty(company.client, { companyId: company.companyId, name: party.name!, ico: party.ico, vatId: party.vatId, street: party.street!, city: party.city!, postalCode: party.postalCode!, countryCode: party.country!, supplier: true, customer: false });
  if (!entry.ok) throw new Error(entry.error);
  const created = await createConfirmedManualDocument(company.client, { companyId: company.companyId, payload: { ...SAMPLE_EXTRACTION, counterpartyLink: { id: entry.value.id } } }, undefined, fakeVatPayerRegistry());
  if (!created.ok) throw new Error(created.error);
  const target = { companyId: company.companyId, documentId: created.value.id };
  const displayed = await getDocumentReview(company.client, target);
  expect((await updateCounterparty(company.client, { companyId: company.companyId, id: entry.value.id, name: "Changed after render", supplier: true, customer: false })).ok).toBe(true);
  const input = { ...target, basedOnVersion: 1, requestId: crypto.randomUUID(), payload: displayed!.current!.payload };
  expect(await saveAndApproveDocument(company.client, { ...input, displayedReviewContext: displayed!.displayedReviewContext }, undefined, fakeVatPayerRegistry())).toMatchObject({ ok: false, error: "review_warnings_changed" });
  const refreshed = await getDocumentReview(company.client, target);
  expect(await saveAndApproveDocument(company.client, { ...input, requestId: crypto.randomUUID(), displayedReviewContext: refreshed!.displayedReviewContext }, undefined, fakeVatPayerRegistry())).toEqual({ ok: true, value: { version: 2 } });
});

it("refuses directory changes during approval preparation without saving partial accounting data", async () => {
  const company = await administratorWithCompany();
  const entry = await createCounterparty(company.client, { companyId: company.companyId, name: "Before preparation", supplier: true, customer: false });
  if (!entry.ok) throw new Error(entry.error);
  const created = await createConfirmedManualDocument(company.client, { companyId: company.companyId, payload: SAMPLE_EXTRACTION }, undefined, fakeVatPayerRegistry());
  if (!created.ok) throw new Error(created.error);
  const target = { companyId: company.companyId, documentId: created.value.id };
  const registry = { async check() {
    expect((await updateCounterparty(company.client, { companyId: company.companyId, id: entry.value.id, name: "Changed during preparation", supplier: true, customer: false })).ok).toBe(true);
    return { outcome: "checked" as const, unreliable: false, publishedAccounts: ["123456789/0100"] };
  } };
  expect(await saveAndApproveDocument(company.client, { ...target, basedOnVersion: 1, requestId: crypto.randomUUID(), payload: { ...SAMPLE_EXTRACTION, counterpartyLink: { id: entry.value.id } } }, undefined, registry)).toMatchObject({ ok: false, error: "review_context_changed" });
  expect(await listExtractionVersions(company.client, company.companyId, created.value.id)).toHaveLength(1);
  expect((await getDocumentReview(company.client, target))?.document.status).toBe("needs_review");
});

it("serializes a directory identifier update behind link approval without deadlock or stale recorded data", async () => {
  const company = await administratorWithCompany();
  const party = SAMPLE_EXTRACTION.supplier;
  const entry = await createCounterparty(company.client, { companyId: company.companyId, name: party.name!, ico: party.ico, vatId: party.vatId, street: party.street!, city: party.city!, postalCode: party.postalCode!, countryCode: party.country!, supplier: true, customer: false });
  if (!entry.ok) throw new Error(entry.error);
  const created = await createConfirmedManualDocument(company.client, { companyId: company.companyId, payload: SAMPLE_EXTRACTION }, undefined, fakeVatPayerRegistry());
  if (!created.ok) throw new Error(created.error);
  const target = { companyId: company.companyId, documentId: created.value.id };
  const result = await directoryIdentityDuringApproval(company.companyId,
    hold => saveAndApproveDocument(company.client, { ...target, basedOnVersion: 1, requestId: crypto.randomUUID(), payload: { ...SAMPLE_EXTRACTION, counterpartyLink: { id: entry.value.id } } }, undefined, { async check() {
      await hold();
      return { outcome: "checked", unreliable: false, publishedAccounts: ["123456789/0100"] };
    } }),
    () => updateCounterparty(company.client, { companyId: company.companyId, id: entry.value.id, name: party.name!, ico: "12345679", vatId: party.vatId, street: party.street!, city: party.city!, postalCode: party.postalCode!, countryCode: party.country!, supplier: true, customer: false }),
  );
  expect(result).toEqual([{ status: "fulfilled", value: { ok: true, value: { version: 2 } } }, { status: "fulfilled", value: { ok: true, value: null } }]);
  const current = await getDocumentReview(company.client, target);
  expect(current).toMatchObject({ document: { status: "approved" }, current: { payload: { supplier: { ico: "27082440" }, counterpartyLink: { recorded: { ico: "27082440" } } } } });
  expect(current?.shownFindings).toContainEqual(expect.objectContaining({ field: "supplier.ico", code: "counterparty_directory_difference", params: { documentValue: "27082440", directoryValue: "12345679" } }));
});

it("protects a historical-only link from direct authenticated deletion and Version-reference rewriting", async () => {
  const company = await administratorWithCompany();
  const entry = await createCounterparty(company.client, { companyId: company.companyId, name: "Historical only", supplier: true, customer: false });
  if (!entry.ok) throw new Error(entry.error);
  const created = await createConfirmedManualDocument(company.client, { companyId: company.companyId, payload: { ...SAMPLE_EXTRACTION, counterpartyLink: { id: entry.value.id } } }, undefined, fakeVatPayerRegistry());
  if (!created.ok) throw new Error(created.error);
  const target = { companyId: company.companyId, documentId: created.value.id };
  expect((await correctDocument(company.client, { ...target, basedOnVersion: 1, payload: SAMPLE_EXTRACTION }, undefined, fakeVatPayerRegistry())).ok).toBe(true);
  expect(await attemptHistoricalCounterpartyDelete(entry.value.id, company.userId)).toEqual({ code: "23503" });
  const rewrite = await company.client.from("extraction_version").update({ counterparty_id: null }).eq("document_id", created.value.id);
  expect(rewrite.error?.code).toBe("42501");
  expect((await listCounterpartyDocuments(company.client, company.companyId, entry.value.id)).entries).toEqual([{ documentId: created.value.id, version: 1, documentNumber: "FV-2026-0001" }]);
});

it("recomputes directory differences in a direct authenticated approval even when recorded details and findings are forged", async () => {
  const company = await administratorWithCompany();
  const entry = await createCounterparty(company.client, { companyId: company.companyId, name: "Authoritative directory", supplier: true, customer: false });
  if (!entry.ok) throw new Error(entry.error);
  const created = await createConfirmedManualDocument(company.client, { companyId: company.companyId, payload: SAMPLE_EXTRACTION }, undefined, fakeVatPayerRegistry());
  if (!created.ok) throw new Error(created.error);
  const context = await company.client.rpc("document_review_context", { target_document_id: created.value.id, based_on_version: 1 });
  expect(context.error).toBeNull();
  const payload = { ...SAMPLE_EXTRACTION, counterpartyLink: { id: entry.value.id, recorded: SAMPLE_EXTRACTION.supplier } };
  const direct = await company.client.rpc("save_and_approve_document", { target_document_id: created.value.id, based_on_version: 1, request_id: crypto.randomUUID(), payload, submitted_payload: payload, findings: [], expected_context: context.data });
  expect(direct.error).toBeNull();
  expect(direct.data).toMatchObject({ confirmationId: expect.any(String), findings: expect.arrayContaining([expect.objectContaining({ code: "counterparty_directory_difference", params: { documentValue: SAMPLE_EXTRACTION.supplier.name, directoryValue: "Authoritative directory" } })]) });
  expect(await listExtractionVersions(company.client, company.companyId, created.value.id)).toHaveLength(1);
  expect((await getDocumentReview(company.client, { companyId: company.companyId, documentId: created.value.id }))?.document.status).toBe("needs_review");
});
