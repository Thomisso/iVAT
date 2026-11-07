import { createConfirmedManualDocument } from "./support/claim-eligibility";
import { directoryIdentityDuringApproval, orderedDirectoryLinkRace } from "./support/counterparty-link-race";
import { expect, it } from "vitest";
import { SAMPLE_EXTRACTION } from "@/ai/fake";
import { archiveCounterparty, createCounterparty, deleteCounterparty, getCounterparty, restoreCounterparty, updateCounterparty, listCounterpartyDocuments, listCounterparties } from "@/application/counterparties";
import { approveDocument, correctDocument, listExtractionVersions, saveAndApproveDocument } from "@/application/documents";
import { getDocumentReview } from "@/application/document-review";
import { fakeVatPayerRegistry } from "@/vat-registry/fake";
import { createCompany } from "@/application/companies";
import { generateVatReport, getVatReport, finalizeVatReport } from "@/application/vat-reports";
import { promotedSuperAdministrator } from "./support/platform";
import { listAuditEvents } from "@/application/audit";
import { administratorWithCompany, companyDetails, companyMember } from "./support/fixtures";

it("automatically links an unambiguous normalized identity and approves without duplicating the Counterparty", async () => {
  const company = await administratorWithCompany();
  const entry = await createCounterparty(company.client, {
    companyId: company.companyId, name: "Dodavatel s.r.o.", ico: "27082440", vatId: "CZ27082440",
    street: "Na Příkopě 1", city: "Praha", postalCode: "110 00", countryCode: "CZ",
    supplier: true, customer: false,
  });
  if (!entry.ok) throw new Error(entry.error);
  const created = await createConfirmedManualDocument(company.client, {
    companyId: company.companyId,
    payload: { ...SAMPLE_EXTRACTION, supplier: { ...SAMPLE_EXTRACTION.supplier, name: "Dodavatel   s.r.o.", vatId: "cz 27082440" } },
  }, undefined, fakeVatPayerRegistry());
  if (!created.ok) throw new Error(created.error);
  const target = { companyId: company.companyId, documentId: created.value.id };
  const review = await getDocumentReview(company.client, target);
  expect(review?.current?.payload).toMatchObject({
    supplier: { name: "Dodavatel   s.r.o.", ico: "27082440", vatId: "CZ27082440" },
    counterpartyLink: { id: entry.value.id, recorded: { name: "Dodavatel s.r.o.", ico: "27082440", vatId: "CZ27082440" } },
  });
  if (!review?.current) throw new Error("expected current Document review");
  expect(await saveAndApproveDocument(company.client, {
    ...target, basedOnVersion: 1, requestId: crypto.randomUUID(), payload: review.current.payload,
  }, undefined, fakeVatPayerRegistry())).toEqual({ ok: true, value: { version: 1 } });
  expect((await getDocumentReview(company.client, target))?.document.status).toBe("approved");
  expect(await listExtractionVersions(company.client, target.companyId, target.documentId)).toHaveLength(1);
  expect(await listCounterparties(company.client, company.companyId)).toMatchObject({ total: 1, entries: [{ id: entry.value.id }] });
});

it("creates an unknown Counterparty only together with successful approval and records its immutable link", async () => {
  const company = await administratorWithCompany();
  const created = await createConfirmedManualDocument(company.client, { companyId: company.companyId, payload: SAMPLE_EXTRACTION }, undefined, fakeVatPayerRegistry());
  if (!created.ok) throw new Error(created.error);
  const target = { companyId: company.companyId, documentId: created.value.id };
  const before = await getDocumentReview(company.client, target);
  if (!before?.current) throw new Error("expected current Document review");
  expect((await listCounterparties(company.client, company.companyId)).total).toBe(0);
  expect(await saveAndApproveDocument(company.client, {
    ...target, basedOnVersion: 1, requestId: crypto.randomUUID(), payload: before.current.payload,
  }, undefined, fakeVatPayerRegistry())).toEqual({ ok: true, value: { version: 2 } });
  const directory = await listCounterparties(company.client, company.companyId);
  expect(directory).toMatchObject({ total: 1, entries: [{ name: "Dodavatel s.r.o.", ico: "27082440", vatId: "CZ27082440", supplier: true, customer: false }] });
  const review = await getDocumentReview(company.client, target);
  expect(review).toMatchObject({ document: { status: "approved" }, current: { payload: {
    supplier: SAMPLE_EXTRACTION.supplier, counterpartyLink: { id: directory.entries[0].id, recorded: { name: "Dodavatel s.r.o.", ico: "27082440" } },
  } } });
  const versions = await listExtractionVersions(company.client, target.companyId, target.documentId);
  expect(versions).toHaveLength(2);
  expect(versions[0].payload).not.toHaveProperty("counterpartyLink");
});

it("requires manual resolution when matching IČO conflicts with the other VAT identity", async () => {
  const company = await administratorWithCompany();
  const entry = await createCounterparty(company.client, { companyId: company.companyId, name: "Conflicting identity", ico: "27082440", vatId: "CZ25596641", supplier: true, customer: false });
  if (!entry.ok) throw new Error(entry.error);
  const created = await createConfirmedManualDocument(company.client, { companyId: company.companyId, payload: SAMPLE_EXTRACTION }, undefined, fakeVatPayerRegistry());
  if (!created.ok) throw new Error(created.error);
  const target = { companyId: company.companyId, documentId: created.value.id };
  const review = await getDocumentReview(company.client, target);
  expect(review?.current?.payload).not.toHaveProperty("counterpartyLink");
  expect(await saveAndApproveDocument(company.client, { ...target, basedOnVersion: 1, requestId: crypto.randomUUID(), payload: review!.current!.payload }, undefined, fakeVatPayerRegistry()))
    .toMatchObject({ ok: false, error: "counterparty_resolution_required" });
  expect((await listCounterparties(company.client, company.companyId)).total).toBe(1);
  expect((await getDocumentReview(company.client, target))?.document.status).toBe("needs_review");
  expect(await listExtractionVersions(company.client, company.companyId, target.documentId)).toHaveLength(1);
});

it("requires fresh explicit Party and Direction consent to create a Counterparty without identifiers", async () => {
  const company = await administratorWithCompany();
  const party = { ...SAMPLE_EXTRACTION.supplier, name: "Cash supplier", ico: null, vatId: null };
  const created = await createConfirmedManualDocument(company.client, { companyId: company.companyId, payload: { ...SAMPLE_EXTRACTION, supplier: party } }, undefined, fakeVatPayerRegistry());
  if (!created.ok) throw new Error(created.error);
  const target = { companyId: company.companyId, documentId: created.value.id };
  const review = await getDocumentReview(company.client, target);
  const input = { ...target, basedOnVersion: 1, requestId: crypto.randomUUID(), payload: review!.current!.payload };
  expect(await saveAndApproveDocument(company.client, input, undefined, fakeVatPayerRegistry())).toMatchObject({ ok: false, error: "counterparty_resolution_required" });
  const counterpartyCreationConsent = { direction: "incoming" as const, party };
  const changed = { ...input, counterpartyCreationConsent, payload: { ...input.payload, supplier: { ...party, name: "Changed after consent" } } };
  const warning = await saveAndApproveDocument(company.client, changed, undefined, fakeVatPayerRegistry());
  expect(warning).toMatchObject({ ok: false, error: "review_warnings_changed" });
  if (warning.ok || warning.error !== "review_warnings_changed") throw new Error("expected changed-value warning acknowledgement");
  expect(await saveAndApproveDocument(company.client, { ...changed, acknowledgement: warning.confirmation.id }, undefined, fakeVatPayerRegistry()))
    .toMatchObject({ ok: false, error: "counterparty_resolution_required" });
  expect((await listCounterparties(company.client, company.companyId)).total).toBe(0);
  expect(await saveAndApproveDocument(company.client, { ...input, counterpartyCreationConsent }, undefined, fakeVatPayerRegistry())).toEqual({ ok: true, value: { version: 2 } });
  expect(await listCounterparties(company.client, company.companyId)).toMatchObject({ total: 1, entries: [{ name: "Cash supplier", ico: null, vatId: null }] });
  const saved = (await getDocumentReview(company.client, target))!.current!.payload;
  expect(saved.counterpartyLink).toMatchObject({ id: expect.any(String), recorded: { name: "Cash supplier" } });
  expect(saved).not.toHaveProperty("counterpartyCreationConsent");
  expect(await saveAndApproveDocument(company.client, { ...input, counterpartyCreationConsent }, undefined, fakeVatPayerRegistry())).toEqual({ ok: true, value: { version: 2 } });
  expect(await saveAndApproveDocument(company.client, input, undefined, fakeVatPayerRegistry())).toMatchObject({ ok: false, error: "stale_version" });
});

it("enforces the no-identifier decision through legacy approval and a direct authenticated RPC", async () => {
  const company = await administratorWithCompany();
  const payload = { ...SAMPLE_EXTRACTION, supplier: { ...SAMPLE_EXTRACTION.supplier, ico: null, vatId: null } };
  const created = await createConfirmedManualDocument(company.client, { companyId: company.companyId, payload }, undefined, fakeVatPayerRegistry());
  if (!created.ok) throw new Error(created.error);
  const target = { companyId: company.companyId, documentId: created.value.id };
  expect(await approveDocument(company.client, { ...target, version: 1 })).toEqual({ ok: false, error: "counterparty_resolution_required" });
  const direct = await company.client.rpc("approve_document", { target_document_id: created.value.id, reviewed_version: 1 });
  expect(direct.error).toMatchObject({ code: "P0001", hint: "counterparty_resolution_required" });
  expect((await listCounterparties(company.client, company.companyId)).total).toBe(0);
  expect((await getDocumentReview(company.client, target))?.document.status).toBe("needs_review");
  expect(await listExtractionVersions(company.client, company.companyId, target.documentId)).toHaveLength(1);
});

it("preserves an explicit unlink instead of silently relinking the same normalized identity", async () => {
  const company = await administratorWithCompany();
  const party = SAMPLE_EXTRACTION.supplier;
  const entry = await createCounterparty(company.client, { companyId: company.companyId, name: party.name!, ico: party.ico, vatId: party.vatId,
    street: party.street!, city: party.city!, postalCode: party.postalCode!, countryCode: party.country!, supplier: true, customer: false });
  if (!entry.ok) throw new Error(entry.error);
  const created = await createConfirmedManualDocument(company.client, { companyId: company.companyId, payload: SAMPLE_EXTRACTION }, undefined, fakeVatPayerRegistry());
  if (!created.ok) throw new Error(created.error);
  const target = { companyId: company.companyId, documentId: created.value.id };
  expect(await correctDocument(company.client, { ...target, basedOnVersion: 1, payload: { ...SAMPLE_EXTRACTION, counterpartyLink: null } }, undefined, fakeVatPayerRegistry()))
    .toEqual({ ok: true, value: { version: 2 } });
  const review = await getDocumentReview(company.client, target);
  expect(review?.current?.payload).toMatchObject({ supplier: party, counterpartyLink: null });
  expect(await saveAndApproveDocument(company.client, { ...target, basedOnVersion: 2, requestId: crypto.randomUUID(), payload: review!.current!.payload }, undefined, fakeVatPayerRegistry()))
    .toMatchObject({ ok: false, error: "counterparty_resolution_required" });
  expect((await listCounterpartyDocuments(company.client, company.companyId, entry.value.id)).entries).toMatchObject([{ documentId: created.value.id, version: 1 }]);
});

it("requires explicit restoration of an archived identity and never recreates or activates it during approval", async () => {
  const company = await administratorWithCompany();
  const party = SAMPLE_EXTRACTION.supplier;
  const entry = await createCounterparty(company.client, { companyId: company.companyId, name: party.name!, ico: party.ico, vatId: party.vatId,
    street: party.street!, city: party.city!, postalCode: party.postalCode!, countryCode: party.country!, supplier: true, customer: false });
  if (!entry.ok) throw new Error(entry.error);
  const entryTarget = { companyId: company.companyId, id: entry.value.id };
  expect(await archiveCounterparty(company.client, entryTarget)).toEqual({ ok: true, value: null });
  const created = await createConfirmedManualDocument(company.client, { companyId: company.companyId, payload: SAMPLE_EXTRACTION }, undefined, fakeVatPayerRegistry());
  if (!created.ok) throw new Error(created.error);
  const target = { companyId: company.companyId, documentId: created.value.id };
  const review = await getDocumentReview(company.client, target);
  const input = { ...target, basedOnVersion: 1, requestId: crypto.randomUUID(), payload: review!.current!.payload };
  expect(await saveAndApproveDocument(company.client, input, undefined, fakeVatPayerRegistry())).toMatchObject({ ok: false, error: "counterparty_resolution_required" });
  expect(await getCounterparty(company.client, company.companyId, entry.value.id)).toMatchObject({ archivedAt: expect.any(String) });
  expect((await listCounterparties(company.client, company.companyId, { state: "archived" })).total).toBe(1);
  expect((await listCounterparties(company.client, company.companyId)).total).toBe(0);
  expect(await restoreCounterparty(company.client, entryTarget)).toEqual({ ok: true, value: null });
  expect(await saveAndApproveDocument(company.client, input, undefined, fakeVatPayerRegistry())).toEqual({ ok: true, value: { version: 2 } });
  expect((await getDocumentReview(company.client, target))?.current?.payload.counterpartyLink?.id).toBe(entry.value.id);
  expect((await listCounterparties(company.client, company.companyId)).total).toBe(1);
});

it("matches an outgoing VAT-only identity across directory roles without changing the Document customer", async () => {
  const company = await administratorWithCompany();
  const party = { ...SAMPLE_EXTRACTION.customer, ico: null };
  const entry = await createCounterparty(company.client, { companyId: company.companyId, name: party.name!, vatId: party.vatId,
    street: party.street!, city: party.city!, postalCode: party.postalCode!, countryCode: party.country!, supplier: true, customer: false });
  if (!entry.ok) throw new Error(entry.error);
  const created = await createConfirmedManualDocument(company.client, { companyId: company.companyId,
    payload: { ...SAMPLE_EXTRACTION, direction: "outgoing", customer: { ...party, vatId: "cz 25596641" } } }, undefined, fakeVatPayerRegistry());
  if (!created.ok) throw new Error(created.error);
  const review = await getDocumentReview(company.client, { companyId: company.companyId, documentId: created.value.id });
  expect(review?.current?.payload).toMatchObject({ customer: party, counterpartyLink: { id: entry.value.id } });
});

it("normalizes IČO for identity matching while retaining the Document value and its validation error", async () => {
  const company = await administratorWithCompany();
  const entry = await createCounterparty(company.client, { companyId: company.companyId, name: "Known identity", ico: "27082440", supplier: true, customer: false });
  if (!entry.ok) throw new Error(entry.error);
  const created = await createConfirmedManualDocument(company.client, { companyId: company.companyId,
    payload: { ...SAMPLE_EXTRACTION, supplier: { ...SAMPLE_EXTRACTION.supplier, ico: "2708 2440", vatId: null } } }, undefined, fakeVatPayerRegistry());
  if (!created.ok) throw new Error(created.error);
  const review = await getDocumentReview(company.client, { companyId: company.companyId, documentId: created.value.id });
  expect(review?.current?.payload).toMatchObject({ supplier: { ico: "2708 2440" }, counterpartyLink: { id: entry.value.id } });
  expect(review?.shownFindings).toContainEqual({ field: "supplier.ico", severity: "error", code: "invalid_ico_format" });
});

it("rolls back a new Counterparty, link and audits when the final claim-eligibility approval guard refuses", async () => {
  const company = await administratorWithCompany();
  const created = await createConfirmedManualDocument(company.client, { companyId: company.companyId, payload: SAMPLE_EXTRACTION }, undefined, fakeVatPayerRegistry());
  if (!created.ok) throw new Error(created.error);
  const target = { companyId: company.companyId, documentId: created.value.id };
  const before = await getDocumentReview(company.client, target);
  expect(await saveAndApproveDocument(company.client, { ...target, basedOnVersion: 1, requestId: crypto.randomUUID(), payload: {
    ...before!.current!.payload, claimEligibility: { period: "2026-09", origin: "user", confirmed: true },
  } }, undefined, fakeVatPayerRegistry())).toMatchObject({ ok: false, error: "invalid_earliest_claim_period" });
  expect((await listCounterparties(company.client, company.companyId)).total).toBe(0);
  expect(await listExtractionVersions(company.client, company.companyId, target.documentId)).toHaveLength(1);
  expect((await getDocumentReview(company.client, target))?.document.status).toBe("needs_review");
  const events = await listAuditEvents(company.client, company.organizationId);
  expect(events.filter(event => event.action === "counterparty.created" || event.targetId === created.value.id && ["document.corrected", "document.approved"].includes(event.action))).toEqual([]);
});

it("leaves no Counterparty on a warning pause and replays successful creation without another entry or approval", async () => {
  const company = await administratorWithCompany();
  const created = await createConfirmedManualDocument(company.client, { companyId: company.companyId, payload: SAMPLE_EXTRACTION }, undefined, fakeVatPayerRegistry());
  if (!created.ok) throw new Error(created.error);
  const target = { companyId: company.companyId, documentId: created.value.id };
  const input = { ...target, basedOnVersion: 1, requestId: crypto.randomUUID(), payload: (await getDocumentReview(company.client, target))!.current!.payload };
  const registry = fakeVatPayerRegistry({ outcome: "checked", unreliable: false, publishedAccounts: [] });
  const pending = await saveAndApproveDocument(company.client, input, undefined, registry);
  expect(pending).toMatchObject({ ok: false, error: "review_warnings_changed" });
  if (pending.ok || pending.error !== "review_warnings_changed") throw new Error("expected warning acknowledgement");
  expect((await listCounterparties(company.client, company.companyId)).total).toBe(0);
  expect(await listExtractionVersions(company.client, company.companyId, target.documentId)).toHaveLength(1);
  expect(await saveAndApproveDocument(company.client, { ...input, acknowledgement: pending.confirmation.id }, undefined, registry)).toEqual({ ok: true, value: { version: 2 } });
  expect(await saveAndApproveDocument(company.client, input, undefined, { async check() { throw new Error("successful replay must return before registry preparation"); } }))
    .toEqual({ ok: true, value: { version: 2 } });
  expect(await saveAndApproveDocument(company.client, { ...input, requestId: crypto.randomUUID() }, undefined, registry)).toMatchObject({ ok: false, error: "stale_version" });
  const directory = await listCounterparties(company.client, company.companyId);
  expect(directory.total).toBe(1);
  expect(await listExtractionVersions(company.client, company.companyId, target.documentId)).toHaveLength(2);
  const events = await listAuditEvents(company.client, company.organizationId);
  expect(events.filter(event => event.targetId === target.documentId && event.action === "document.approved")).toHaveLength(1);
  expect(events.filter(event => event.targetId === directory.entries[0].id && event.action === "counterparty.created")).toHaveLength(1);
});

it.each([true, false])("serializes new identity creation without duplicates when the same Document request is %s", async (sameRequest) => {
  const company = await administratorWithCompany();
  const first = await createConfirmedManualDocument(company.client, { companyId: company.companyId, payload: SAMPLE_EXTRACTION }, undefined, fakeVatPayerRegistry());
  if (!first.ok) throw new Error(first.error);
  const second = sameRequest ? first : await createConfirmedManualDocument(company.client, { companyId: company.companyId, payload: { ...SAMPLE_EXTRACTION, documentNumber: "SECOND-234" } }, undefined, fakeVatPayerRegistry());
  if (!second.ok) throw new Error(second.error);
  const requestId = crypto.randomUUID();
  const inputs = await Promise.all([first, second].map(async (document, index) => ({
    companyId: company.companyId, documentId: document.value.id, basedOnVersion: 1,
    requestId: sameRequest || index === 0 ? requestId : crypto.randomUUID(),
    payload: (await getDocumentReview(company.client, { companyId: company.companyId, documentId: document.value.id }))!.current!.payload,
  })));
  let arrivals = 0;
  let release!: () => void;
  const bothPrepared = new Promise<void>(resolve => { release = resolve; });
  const registry = { async check() {
    if (++arrivals === 2) release();
    await bothPrepared;
    return { outcome: "checked" as const, unreliable: false, publishedAccounts: ["123456789/0100"] };
  } };
  const results = await Promise.all(inputs.map(input => saveAndApproveDocument(company.client, input, undefined, registry)));
  if (sameRequest) expect(results).toEqual([{ ok: true, value: { version: 2 } }, { ok: true, value: { version: 2 } }]);
  else {
    expect(results.filter(result => result.ok)).toEqual([{ ok: true, value: { version: 2 } }]);
    const loser = results.findIndex(result => !result.ok);
    expect(results[loser]).toMatchObject({ ok: false, error: "review_context_changed" });
    expect(await saveAndApproveDocument(company.client, inputs[loser], undefined, fakeVatPayerRegistry())).toEqual({ ok: true, value: { version: 2 } });
  }
  const directory = await listCounterparties(company.client, company.companyId);
  expect(directory.total).toBe(1);
  expect((await listCounterpartyDocuments(company.client, company.companyId, directory.entries[0].id)).total).toBe(sameRequest ? 1 : 2);
  const events = await listAuditEvents(company.client, company.organizationId);
  expect(events.filter(event => event.action === "counterparty.created")).toHaveLength(1);
  expect(events.filter(event => event.action === "document.approved")).toHaveLength(sameRequest ? 1 : 2);
});

it("refuses newly changed directory warnings through legacy approval until the current review is shown", async () => {
  const company = await administratorWithCompany();
  const party = SAMPLE_EXTRACTION.supplier;
  const entry = await createCounterparty(company.client, { companyId: company.companyId, name: party.name!, ico: party.ico, vatId: party.vatId,
    street: party.street!, city: party.city!, postalCode: party.postalCode!, countryCode: party.country!, supplier: true, customer: false });
  if (!entry.ok) throw new Error(entry.error);
  const created = await createConfirmedManualDocument(company.client, { companyId: company.companyId, payload: SAMPLE_EXTRACTION }, undefined, fakeVatPayerRegistry());
  if (!created.ok) throw new Error(created.error);
  const target = { companyId: company.companyId, documentId: created.value.id };
  expect((await updateCounterparty(company.client, { companyId: company.companyId, id: entry.value.id, name: "Changed directory", ico: party.ico, vatId: party.vatId,
    street: party.street!, city: party.city!, postalCode: party.postalCode!, countryCode: party.country!, supplier: true, customer: false })).ok).toBe(true);
  expect(await approveDocument(company.client, { ...target, version: 1 })).toEqual({ ok: false, error: "counterparty_resolution_required" });
  expect(await listExtractionVersions(company.client, company.companyId, target.documentId)).toHaveLength(1);
  const shown = await getDocumentReview(company.client, target);
  expect(shown?.shownFindings).toContainEqual(expect.objectContaining({ code: "counterparty_directory_difference", field: "supplier.name" }));
  expect(await saveAndApproveDocument(company.client, { ...target, basedOnVersion: 1, requestId: crypto.randomUUID(), payload: shown!.current!.payload,
    displayedReviewContext: shown!.displayedReviewContext }, undefined, fakeVatPayerRegistry())).toEqual({ ok: true, value: { version: 2 } });
});

it("enforces Party-bound no-ID consent in the direct authenticated atomic RPC", async () => {
  const company = await administratorWithCompany();
  const party = { ...SAMPLE_EXTRACTION.supplier, ico: null, vatId: null };
  const created = await createConfirmedManualDocument(company.client, { companyId: company.companyId, payload: { ...SAMPLE_EXTRACTION, supplier: party } }, undefined, fakeVatPayerRegistry());
  if (!created.ok) throw new Error(created.error);
  const target = { companyId: company.companyId, documentId: created.value.id };
  const payload = (await getDocumentReview(company.client, target))!.current!.payload;
  const context = await company.client.rpc("document_review_context", { target_document_id: created.value.id, based_on_version: 1 });
  expect(context.error).toBeNull();
  for (const consent of [undefined, { direction: "outgoing", party }, { direction: "incoming", party: { ...party, name: "Different consent" } }]) {
    const direct = await company.client.rpc("save_and_approve_document", { target_document_id: created.value.id, based_on_version: 1,
      request_id: crypto.randomUUID(), payload, submitted_payload: { ...payload, ...(consent ? { counterpartyCreationConsent: consent } : {}) }, findings: [], expected_context: context.data });
    expect(direct.error).toMatchObject({ code: "P0001", hint: "counterparty_resolution_required" });
  }
  expect((await listCounterparties(company.client, company.companyId)).total).toBe(0);
  expect((await getDocumentReview(company.client, target))?.document.status).toBe("needs_review");
});

it("does not use a similar name to link an unrelated identity", async () => {
  const company = await administratorWithCompany();
  const entry = await createCounterparty(company.client, { companyId: company.companyId, name: "Dodavatel s.r.o.", ico: "25596641", vatId: "CZ25596641", supplier: true, customer: false });
  if (!entry.ok) throw new Error(entry.error);
  const created = await createConfirmedManualDocument(company.client, { companyId: company.companyId, payload: SAMPLE_EXTRACTION }, undefined, fakeVatPayerRegistry());
  if (!created.ok) throw new Error(created.error);
  const target = { companyId: company.companyId, documentId: created.value.id };
  const review = await getDocumentReview(company.client, target);
  expect(review?.current?.payload).not.toHaveProperty("counterpartyLink");
  expect(await saveAndApproveDocument(company.client, { ...target, basedOnVersion: 1, requestId: crypto.randomUUID(), payload: review!.current!.payload }, undefined, fakeVatPayerRegistry()))
    .toEqual({ ok: true, value: { version: 2 } });
  const linked = (await getDocumentReview(company.client, target))!.current!.payload.counterpartyLink!.id;
  expect(linked).not.toBe(entry.value.id);
  expect((await listCounterparties(company.client, company.companyId)).total).toBe(2);
});

it("requires a manual choice when the two identifiers resolve to different directory entries", async () => {
  const company = await administratorWithCompany();
  for (const identifiers of [{ ico: "27082440", vatId: "CZ25596641" }, { ico: "25596641", vatId: "CZ27082440" }]) {
    expect((await createCounterparty(company.client, { companyId: company.companyId, name: "Split identity", ...identifiers, supplier: true, customer: false })).ok).toBe(true);
  }
  const created = await createConfirmedManualDocument(company.client, { companyId: company.companyId, payload: SAMPLE_EXTRACTION }, undefined, fakeVatPayerRegistry());
  if (!created.ok) throw new Error(created.error);
  const target = { companyId: company.companyId, documentId: created.value.id };
  const review = await getDocumentReview(company.client, target);
  expect(review?.current?.payload).not.toHaveProperty("counterpartyLink");
  expect(await saveAndApproveDocument(company.client, { ...target, basedOnVersion: 1, requestId: crypto.randomUUID(), payload: review!.current!.payload }, undefined, fakeVatPayerRegistry()))
    .toMatchObject({ ok: false, error: "counterparty_resolution_required" });
  expect((await listCounterparties(company.client, company.companyId)).total).toBe(2);
});

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
  expect(await saveAndApproveDocument(company.client, input, undefined, fakeVatPayerRegistry())).toEqual({ ok: true, value: { version: 1 } });
  const period = { companyId: company.companyId, period: "2026-10" };
  expect((await generateVatReport(company.client, period)).ok).toBe(true);
  const stored = await getVatReport(company.client, company.companyId, period.period);
  expect(await finalizeVatReport(company.client, { ...period, confirmed: true })).toEqual({ ok: true, value: null });
  const versions = await listExtractionVersions(company.client, company.companyId, created.value.id);
  expect((await updateCounterparty(company.client, { companyId: company.companyId, id: entry.value.id, name: "After finalization", supplier: true, customer: false })).ok).toBe(true);
  for (const command of [archiveCounterparty, restoreCounterparty]) {
    expect(await command(company.client, { companyId: company.companyId, id: entry.value.id })).toEqual({ ok: true, value: null });
    expect(await listExtractionVersions(company.client, company.companyId, created.value.id)).toEqual(versions);
    const unchangedReport = await getVatReport(company.client, company.companyId, period.period);
    expect(unchangedReport?.result).toEqual(stored?.result);
    expect(unchangedReport?.documents).toEqual(stored?.documents);
    expect((await getDocumentReview(company.client, input))?.document.status).toBe("approved");
    expect(await deleteCounterparty(company.client, { companyId: company.companyId, id: entry.value.id })).toEqual({ ok: false, error: "counterparty_in_use" });
  }
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
  expect(result).toEqual([{ status: "fulfilled", value: { ok: true, value: { version: 1 } } }, { status: "fulfilled", value: { ok: true, value: null } }]);
  const current = await getDocumentReview(company.client, target);
  expect(current).toMatchObject({ document: { status: "approved" }, current: { payload: { supplier: { ico: "27082440" }, counterpartyLink: { recorded: { ico: "27082440" } } } } });
  expect(current?.shownFindings).toContainEqual(expect.objectContaining({ field: "supplier.ico", code: "counterparty_directory_difference", params: { documentValue: "27082440", directoryValue: "12345679" } }));
});

it.each(["current", "historical"] as const)("protects a %s link from public deletion and direct authenticated bypass", async link => {
  const company = await administratorWithCompany();
  const entry = await createCounterparty(company.client, { companyId: company.companyId, name: "Historical only", supplier: true, customer: false });
  if (!entry.ok) throw new Error(entry.error);
  const created = await createConfirmedManualDocument(company.client, { companyId: company.companyId, payload: { ...SAMPLE_EXTRACTION, counterpartyLink: { id: entry.value.id } } }, undefined, fakeVatPayerRegistry());
  if (!created.ok) throw new Error(created.error);
  const target = { companyId: company.companyId, documentId: created.value.id };
  if (link === "historical") expect((await correctDocument(company.client, { ...target, basedOnVersion: 1, payload: SAMPLE_EXTRACTION }, undefined, fakeVatPayerRegistry())).ok).toBe(true);
  const user = await companyMember(company);
  const administrator = await companyMember(company, "administrator");
  const superAdmin = await promotedSuperAdministrator("Referenced lifecycle operator");
  for (const actor of [user, administrator, company, superAdmin]) {
    expect(await deleteCounterparty(actor.client, { companyId: company.companyId, id: entry.value.id })).toEqual({ ok: false, error: "counterparty_in_use" });
  }
  const direct = await company.client.rpc("delete_counterparty", { target_company_id: company.companyId, target_counterparty_id: entry.value.id });
  expect(direct.error).toMatchObject({ code: "P0001", hint: "counterparty_in_use" });
  const bypass = await company.client.from("counterparty").delete().eq("id", entry.value.id);
  expect(bypass.error?.code).toBe("42501");
  expect((await getCounterparty(company.client, company.companyId, entry.value.id))?.name).toBe("Historical only");
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


it("preserves archived recorded links but requires explicit restore before a new Document can link", async () => {
  const company = await administratorWithCompany();
  const entry = await createCounterparty(company.client, { companyId: company.companyId, name: "Archived linked supplier", supplier: true, customer: false });
  if (!entry.ok) throw new Error(entry.error);
  const linked = { ...SAMPLE_EXTRACTION, counterpartyLink: { id: entry.value.id } };
  const created = await createConfirmedManualDocument(company.client, { companyId: company.companyId, payload: linked }, undefined, fakeVatPayerRegistry());
  if (!created.ok) throw new Error(created.error);
  const before = await listExtractionVersions(company.client, company.companyId, created.value.id);
  const target = { companyId: company.companyId, id: entry.value.id };
  expect(await archiveCounterparty(company.client, target)).toEqual({ ok: true, value: null });
  expect(await listExtractionVersions(company.client, company.companyId, created.value.id)).toEqual(before);
  expect((await getDocumentReview(company.client, { companyId: company.companyId, documentId: created.value.id }))?.current?.payload)
    .toMatchObject({ supplier: SAMPLE_EXTRACTION.supplier, counterpartyLink: { id: entry.value.id, recorded: { name: "Archived linked supplier" } } });
  const other = await createConfirmedManualDocument(company.client, { companyId: company.companyId, payload: SAMPLE_EXTRACTION }, undefined, fakeVatPayerRegistry());
  if (!other.ok) throw new Error(other.error);
  const correction = { companyId: company.companyId, documentId: other.value.id, basedOnVersion: 1, payload: linked };
  expect(await correctDocument(company.client, correction, undefined, fakeVatPayerRegistry())).toEqual({ ok: false, error: "forbidden" });
  const direct = await company.client.rpc("save_document_review", { target_document_id: other.value.id, based_on_version: 1, request_id: crypto.randomUUID(), payload: linked, submitted_payload: linked, findings: [] });
  expect(direct.error?.code).toBe("42501");
  expect(await listExtractionVersions(company.client, company.companyId, other.value.id)).toHaveLength(1);
  // Existing recorded linkage remains valid when the same Document saves a correction.
  expect(await correctDocument(company.client, { ...correction, documentId: created.value.id, payload: { ...linked, documentNumber: "ARCHIVED-EDIT" } }, undefined, fakeVatPayerRegistry()))
    .toEqual({ ok: true, value: { version: 2 } });
  expect(await restoreCounterparty(company.client, target)).toEqual({ ok: true, value: null });
  expect(await correctDocument(company.client, correction, undefined, fakeVatPayerRegistry())).toEqual({ ok: true, value: { version: 2 } });
  expect((await listExtractionVersions(company.client, company.companyId, created.value.id))[0]).toEqual(before[0]);
});

it.each([
  ["delete", "link"], ["delete", "lifecycle"], ["archive", "link"], ["archive", "lifecycle"],
] as const)("serializes %s against a concurrent link when %s wins", async (operation, winner) => {
  const company = await administratorWithCompany();
  const entry = await createCounterparty(company.client, { companyId: company.companyId, name: "Race supplier", supplier: true, customer: false });
  if (!entry.ok) throw new Error(entry.error);
  const created = await createConfirmedManualDocument(company.client, { companyId: company.companyId, payload: SAMPLE_EXTRACTION }, undefined, fakeVatPayerRegistry());
  if (!created.ok) throw new Error(created.error);
  const target = { companyId: company.companyId, documentId: created.value.id };
  const lifecycle = { query: `${operation}_counterparty`, run: () => (operation === "delete" ? deleteCounterparty : archiveCounterparty)(company.client, { companyId: company.companyId, id: entry.value.id }) };
  const link = { query: "save_document_review", run: () => correctDocument(company.client, { ...target, basedOnVersion: 1, requestId: crypto.randomUUID(), payload: { ...SAMPLE_EXTRACTION, counterpartyLink: { id: entry.value.id } } }, undefined, fakeVatPayerRegistry()) };
  const outcomes = await orderedDirectoryLinkRace(company.companyId, winner === "link" ? link : lifecycle, winner === "link" ? lifecycle : link);
  const success = { status: "fulfilled", value: { ok: true, value: null } };
  const linked = { status: "fulfilled", value: { ok: true, value: { version: 2 } } };
  expect(outcomes).toEqual(winner === "link"
    ? [linked, operation === "delete" ? { status: "fulfilled", value: { ok: false, error: "counterparty_in_use" } } : success]
    : [success, { status: "fulfilled", value: { ok: false, error: "forbidden" } }]);
  const versions = await listExtractionVersions(company.client, company.companyId, created.value.id);
  expect(versions).toHaveLength(winner === "link" ? 2 : 1);
  if (winner === "link") expect(versions[1].payload.counterpartyLink).toMatchObject({ id: entry.value.id, recorded: { name: "Race supplier" } });
  else expect(versions[0].payload).not.toHaveProperty("counterpartyLink");
  const remaining = await getCounterparty(company.client, company.companyId, entry.value.id);
  if (operation === "delete" && winner === "lifecycle") expect(remaining).toBeNull();
  else expect(remaining).toMatchObject({ archivedAt: operation === "archive" ? expect.any(String) : null });
});
