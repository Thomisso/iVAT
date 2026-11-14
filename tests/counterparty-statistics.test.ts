import { expect, it, vi } from "vitest";
import { SAMPLE_EXTRACTION } from "@/ai/fake";
import { getCounterpartyStatistics } from "@/application/counterparty-statistics";
import { archiveCounterparty, createCounterparty, listCounterparties, updateCounterparty, listCounterpartyDocuments } from "@/application/counterparties";
import { getDocumentReview } from "@/application/document-review";
import { correctDocument, returnDocumentToReview, saveAndApproveDocument } from "@/application/documents";
import { createCompany } from "@/application/companies";
import { fakeVatPayerRegistry } from "@/vat-registry/fake";
import { administratorWithCompany, companyDetails, companyMember, knownSupplierFixture } from "./support/fixtures";
import { createConfirmedManualDocument } from "./support/claim-eligibility";
import { legacyCounterpartyTradeFixture } from "./support/counterparty-statistics";
import { companyDocumentRowLimitProbe, withPostgrestRowLimit } from "./support/postgrest";
import { promotedSuperAdministrator } from "./support/platform";

it("shows original trade amounts and the exact Approved Document contribution", async () => {
  const owner = await administratorWithCompany();
  await knownSupplierFixture(owner);
  const [party] = (await listCounterparties(owner.client, owner.companyId)).entries;
  const created = await createConfirmedManualDocument(owner.client, { companyId: owner.companyId, payload: { ...SAMPLE_EXTRACTION, taxPointDate: "2026-10-27" } }, undefined, fakeVatPayerRegistry());
  if (!created.ok) throw new Error(created.error);
  const target = { companyId: owner.companyId, documentId: created.value.id };
  const review = await getDocumentReview(owner.client, target);
  const approved = await saveAndApproveDocument(owner.client, { ...target, basedOnVersion: review!.current!.version, requestId: crypto.randomUUID(), payload: review!.current!.payload }, undefined, fakeVatPayerRegistry());
  expect(approved.ok).toBe(true);
  const result = await getCounterpartyStatistics(owner.client, owner.companyId, party.id, { year: "2026" });
  expect(result).toMatchObject({ ok: true, value: {
    total: 1, missingDateCount: 0,
    groups: [{ direction: "incoming", currency: "CZK", documentCount: 1, amountCount: 1,
      netAmount: "1000.00", vatAmount: "210.00", grossAmount: "1210.00" }],
    entries: [{ documentId: created.value.id, taxPointDate: "2026-10-27", direction: "incoming", currency: "CZK", grossAmount: "1210.00" }],
  } });
  expect(await returnDocumentToReview(owner.client, target)).toEqual({ ok: true, value: null });
  expect(await getCounterpartyStatistics(owner.client, owner.companyId, party.id, { year: "2026" })).toMatchObject({ ok: true, value: { total: 0, groups: [] } });
  const current = await getDocumentReview(owner.client, target);
  const corrected = await correctDocument(owner.client, { ...target, basedOnVersion: current!.current!.version,
    payload: { ...current!.current!.payload, documentNumber: "CORRECTED-CURRENT-TRADE" } }, undefined, fakeVatPayerRegistry());
  if (!corrected.ok) throw new Error(corrected.error);
  const updated = await getDocumentReview(owner.client, target);
  expect((await saveAndApproveDocument(owner.client, { ...target, basedOnVersion: corrected.value.version,
    requestId: crypto.randomUUID(), payload: updated!.current!.payload }, undefined, fakeVatPayerRegistry())).ok).toBe(true);
  expect(await getCounterpartyStatistics(owner.client, owner.companyId, party.id, { year: "2026" })).toMatchObject({ ok: true, value: {
    total: 1, entries: [{ version: corrected.value.version, documentNumber: "CORRECTED-CURRENT-TRADE" }],
  } });
});

it("starts with the current calendar year in Europe/Prague across the UTC year boundary", async () => {
  const owner = await administratorWithCompany();
  await knownSupplierFixture(owner);
  const [party] = (await listCounterparties(owner.client, owner.companyId)).entries;
  vi.useFakeTimers({ toFake: ["Date"] });
  try {
    vi.setSystemTime(new Date("2026-12-31T23:30:00Z"));
    expect(await getCounterpartyStatistics(owner.client, owner.companyId, party.id)).toMatchObject({ ok: true, value: {
      from: "2027-01-01", to: "2027-12-31", total: 0,
    } });
  } finally { vi.useRealTimers(); }
});

it("uses inclusive DUZP bounds and exposes undated and incomplete contributions without inventing zero", async () => {
  const owner = await administratorWithCompany();
  await knownSupplierFixture(owner);
  const [party] = (await listCounterparties(owner.client, owner.companyId)).entries;
  const base = { ...SAMPLE_EXTRACTION, counterpartyLink: { id: party.id } };
  const ids = await legacyCounterpartyTradeFixture(owner, [
    { payload: { ...base, taxPointDate: "2026-01-01", issueDate: "2025-12-31" } },
    { payload: { ...base, taxPointDate: "2026-12-31", issueDate: "2027-01-01" } },
    { payload: { ...base, taxPointDate: "2025-12-31", issueDate: "2026-01-01" } },
    { payload: { ...base, taxPointDate: null, issueDate: "2026-06-01" } },
    { payload: { ...base, taxPointDate: "2026-02-30" } },
    { payload: { ...base, taxPointDate: "2026-06-01", totals: { netAmount: "100.00", vatAmount: null, grossAmount: "121.00" } } },
    { payload: { ...base, taxPointDate: "2026-06-02", currency: null } },
  ]);
  const result = await getCounterpartyStatistics(owner.client, owner.companyId, party.id, { year: "2026" });
  expect(result).toMatchObject({ ok: true, value: { total: 4, missingDateCount: 2, missingAmountCount: 2, groups: [
    { currency: "CZK", documentCount: 3, amountCount: 2, missingAmountCount: 1, netAmount: "2000.00", grossAmount: "2420.00" },
    { currency: null, documentCount: 1, amountCount: 0, missingAmountCount: 1, netAmount: null, grossAmount: null },
  ] } });
  for (const [contribution, expected] of [["missing_date", [ids[3], ids[4]]], ["missing_amounts", [ids[5], ids[6]]], ["complete", [ids[0], ids[1]]]] as const) {
    const page = await getCounterpartyStatistics(owner.client, owner.companyId, party.id, { year: "2026", contribution });
    if (!page.ok) throw new Error(page.error);
    expect(page.value.entries.map(row => row.documentId).sort()).toEqual([...expected].sort());
    expect(page.value.total).toBe(2);
  }
  expect(await getCounterpartyStatistics(owner.client, owner.companyId, party.id, { from: "2026-12-31", to: "2026-12-31" })).toMatchObject({ ok: true, value: { total: 1, entries: [{ documentId: ids[1] }] } });
  expect(await getCounterpartyStatistics(owner.client, owner.companyId, party.id, { year: "2026", currency: "unknown" })).toMatchObject({ ok: true, value: { total: 1, entries: [{ documentId: ids[6] }] } });
  for (const filters of [{ from: "2026-02-30" }, { from: "2026-12-31", to: "2026-01-01" }, { direction: "supplier" }, { currency: "EUR,CZK" }, { page: "1.5" }]) {
    expect(await getCounterpartyStatistics(owner.client, owner.companyId, party.id, filters)).toEqual({ ok: false, error: "invalid_statistics_filter" });
  }
});

it("covers more than 1000 Documents and pages the exact population even under a real smaller PostgREST cap", async () => {
  const owner = await administratorWithCompany();
  await knownSupplierFixture(owner);
  const [party] = (await listCounterparties(owner.client, owner.companyId)).entries;
  const payload = { ...SAMPLE_EXTRACTION, counterpartyLink: { id: party.id }, currency: "EUR",
    totals: { netAmount: "0.01", vatAmount: "0.02", grossAmount: "0.03" } };
  const converted = { ...payload, czkConversion: { originalCurrency: "EUR", source: "CNB" as const, rate: "0.5", unit: 1,
    rateDate: payload.taxPointDate!, rateBreakdown: [{ rate: 21 as const, netAmount: "0.01", vatAmount: "0.01" }],
    totals: { netAmount: "0.01", vatAmount: "0.01", grossAmount: "0.02" } } };
  const ids = await legacyCounterpartyTradeFixture(owner, Array.from({ length: 1001 }, (_, index) => ({ payload: index < 950 ? converted : payload })));
  await withPostgrestRowLimit(3, companyDocumentRowLimitProbe(owner.client, owner.companyId), async () => {
    const first = await getCounterpartyStatistics(owner.client, owner.companyId, party.id, { year: "2026" });
    expect(first).toMatchObject({ ok: true, value: { total: 1001, pageCount: 21,
      groups: [{ currency: "EUR", documentCount: 1001, netAmount: "10.01", vatAmount: "20.02", grossAmount: "30.03" }],
      czkGroups: [{ documentCount: 1001, amountCount: 950, missingAmountCount: 51, netAmount: "9.50", vatAmount: "9.50", grossAmount: "19.00" }],
    } });
    const observed: string[] = [];
    const contributing: string[] = [];
    // Read-only bounded batches retain every page and exact id coverage.
    for (let batch = 1; batch <= 21; batch += 3) {
      const pages = await Promise.all(Array.from({ length: Math.min(3, 22 - batch) }, (_, offset) =>
        getCounterpartyStatistics(owner.client, owner.companyId, party.id, { year: "2026", page: String(batch + offset),
          contribution: "complete", direction: "incoming", currency: "EUR" })));
      for (const result of pages) {
        if (!result.ok) throw new Error(result.error);
        observed.push(...result.value.entries.map(row => row.documentId));
        contributing.push(...result.value.entries.filter(row => row.czkComplete).map(row => row.documentId));
      }
    }
    expect(observed.sort()).toEqual([...ids].sort());
    expect(contributing.sort()).toEqual(ids.slice(0, 950).sort());
    const missing: string[] = [];
    for (let page = 1; page <= 2; page++) {
      const result = await getCounterpartyStatistics(owner.client, owner.companyId, party.id, { year: "2026", page: String(page),
        contribution: "missing_czk", direction: "incoming", currency: "EUR" });
      if (!result.ok) throw new Error(result.error);
      expect(result.value.total).toBe(51);
      expect(result.value.pageCount).toBe(2);
      missing.push(...result.value.entries.map(row => row.documentId));
    }
    expect(missing.sort()).toEqual(ids.slice(950).sort());
    const complete = await getCounterpartyStatistics(owner.client, owner.companyId, party.id, { year: "2026", page: "19",
      contribution: "czk_complete", direction: "incoming", currency: "EUR" });
    if (!complete.ok) throw new Error(complete.error);
    expect(complete.value.total).toBe(950);
    expect(complete.value.pageCount).toBe(19);
    expect(complete.value.entries).toHaveLength(50);
    expect(complete.value.entries.every(row => ids.slice(0, 950).includes(row.documentId))).toBe(true);
  });
});

it("preserves Company access for effective Roles and refuses foreign Company and Organization direct calls", async () => {
  const owner = await administratorWithCompany();
  await knownSupplierFixture(owner);
  const [party] = (await listCounterparties(owner.client, owner.companyId)).entries;
  await legacyCounterpartyTradeFixture(owner, [{ payload: { ...SAMPLE_EXTRACTION, counterpartyLink: { id: party.id } } }]);
  const member = await companyMember(owner);
  const admin = await companyMember(owner, "administrator");
  const platform = await promotedSuperAdministrator("Trade reader");
  for (const user of [owner, member, admin, platform]) {
    expect(await getCounterpartyStatistics(user.client, owner.companyId, party.id, { year: "2026" })).toMatchObject({ ok: true, value: { total: 1 } });
  }
  const outsider = await administratorWithCompany();
  expect(await getCounterpartyStatistics(outsider.client, owner.companyId, party.id, { year: "2026" })).toEqual({ ok: false, error: "forbidden" });
  const direct = await outsider.client.rpc("counterparty_statistics", { target_company_id: owner.companyId, target_counterparty_id: party.id,
    date_from: "2026-01-01", date_to: "2026-12-31", trade_direction: "", original_currency: "", contribution: "dated", page_number: 1 });
  expect(direct.error?.code).toBe("42501");
  expect(await getCounterpartyStatistics(owner.client, outsider.companyId, party.id, { year: "2026" })).toEqual({ ok: false, error: "forbidden" });
  const sibling = await createCompany(owner.client, { organizationId: owner.organizationId, ...companyDetails() });
  if (!sibling.ok) throw new Error(sibling.error);
  const siblingParty = await createCounterparty(owner.client, { companyId: sibling.value.id, name: "Sibling Company party", supplier: true, customer: false });
  if (!siblingParty.ok) throw new Error(siblingParty.error);
  expect(await getCounterpartyStatistics(member.client, sibling.value.id, siblingParty.value.id, { year: "2026" })).toEqual({ ok: false, error: "forbidden" });
  const sameOrganization = await member.client.rpc("counterparty_statistics", { target_company_id: sibling.value.id, target_counterparty_id: siblingParty.value.id,
    date_from: "2026-01-01", date_to: "2026-12-31", trade_direction: "", original_currency: "", contribution: "dated", page_number: 1 });
  expect(sameOrganization.error?.code).toBe("42501");
});

it("keeps stored full CZK trade, signed originals and exact omissions independently of claim eligibility", async () => {
  const owner = await administratorWithCompany();
  await knownSupplierFixture(owner);
  const [party] = (await listCounterparties(owner.client, owner.companyId)).entries;
  const base = { ...SAMPLE_EXTRACTION, counterpartyLink: { id: party.id }, taxPointDate: "2026-10-01" };
  const ids = await legacyCounterpartyTradeFixture(owner, [
    { payload: { ...base, partialClaim: { confirmed: true, rateBreakdown: [{ rate: 21, netAmount: "100.00", vatAmount: "21.00" }] } } },
    { payload: { ...base, documentType: "credit_note", totals: { netAmount: "-100.00", vatAmount: "-21.00", grossAmount: "-121.00" } } },
    { payload: { ...base, direction: "outgoing", totals: { netAmount: "500.00", vatAmount: "105.00", grossAmount: "605.00" } } },
    { payload: { ...base, currency: "EUR", totals: { netAmount: "100.00", vatAmount: "21.00", grossAmount: "121.00" },
      czkConversion: { originalCurrency: "EUR", source: "CNB", rate: "25", unit: 1, rateDate: "2026-10-01",
        rateBreakdown: [{ rate: 21, netAmount: "2500.00", vatAmount: "525.00" }],
        totals: { netAmount: "2500.00", vatAmount: "525.00", grossAmount: "3025.00" } } } },
    { payload: { ...base, currency: "EUR", totals: { netAmount: "40.00", vatAmount: "8.40", grossAmount: "48.40" } } },
    { payload: { ...base, totals: { netAmount: "1000.00", vatAmount: "210.00", grossAmount: "1210.00" } }, status: "needs_review" },
    { payload: base, status: "rejected" }, { payload: base, status: "processing" }, { payload: base, superseded: true },
  ]);
  const result = await getCounterpartyStatistics(owner.client, owner.companyId, party.id, { year: "2026" });
  expect(result).toMatchObject({ ok: true, value: { total: 5, directions: [
    { direction: "incoming", documentCount: 4 }, { direction: "outgoing", documentCount: 1 },
  ], groups: [
    { direction: "incoming", currency: "CZK", documentCount: 2, netAmount: "900.00", vatAmount: "189.00", grossAmount: "1089.00" },
    { direction: "incoming", currency: "EUR", documentCount: 2, netAmount: "140.00", vatAmount: "29.40", grossAmount: "169.40" },
    { direction: "outgoing", currency: "CZK", documentCount: 1, netAmount: "500.00", vatAmount: "105.00", grossAmount: "605.00" },
  ], czkGroups: [
    { direction: "incoming", documentCount: 4, amountCount: 3, missingAmountCount: 1,
      netAmount: "3400.00", vatAmount: "714.00", grossAmount: "4114.00" },
    { direction: "outgoing", documentCount: 1, amountCount: 1, missingAmountCount: 0,
      netAmount: "500.00", vatAmount: "105.00", grossAmount: "605.00" },
  ] } });
  if (!result.ok) throw new Error(result.error);
  expect(result.value.entries.map(row => row.documentId).sort()).toEqual(ids.slice(0, 5).sort());
  for (const [contribution, expected] of [["czk_complete", [ids[0], ids[1], ids[3]]], ["missing_czk", [ids[4]]]] as const) {
    const drill = await getCounterpartyStatistics(owner.client, owner.companyId, party.id, { year: "2026", direction: "incoming", contribution });
    if (!drill.ok) throw new Error(drill.error);
    expect(drill.value.entries.map(row => row.documentId).sort()).toEqual([...expected].sort());
  }
  const old = await legacyCounterpartyTradeFixture(owner, [{ payload: { ...base, taxPointDate: "2020-01-01", totals: { netAmount: "0.01", vatAmount: "0.02", grossAmount: "0.04" } } }]);
  expect(await getCounterpartyStatistics(owner.client, owner.companyId, party.id, { year: "2020" })).toMatchObject({ ok: true, value: {
    total: 1, groups: [{ netAmount: "0.01", vatAmount: "0.02", grossAmount: "0.04" }], entries: [{ documentId: old[0], grossAmount: "0.04", grossMismatch: true }],
  } });
  await legacyCounterpartyTradeFixture(owner, [
    { payload: { ...base, taxPointDate: "2021-01-01", totals: { netAmount: "9007199254740993.01", vatAmount: "0.00", grossAmount: "9007199254740993.01" } } },
    { payload: { ...base, taxPointDate: "2021-01-02", documentType: "credit_note", totals: { netAmount: "-9007199254740993.00", vatAmount: "0.00", grossAmount: "-9007199254740993.00" } } },
  ]);
  expect(await getCounterpartyStatistics(owner.client, owner.companyId, party.id, { year: "2021" })).toMatchObject({ ok: true, value: {
    total: 2, groups: [{ netAmount: "0.01", vatAmount: "0.00", grossAmount: "0.01" }],
  } });
});

it("moves trade to the current stable link once and preserves it after directory edits and archive", async () => {
  const owner = await administratorWithCompany();
  await knownSupplierFixture(owner);
  const [old] = (await listCounterparties(owner.client, owner.companyId)).entries;
  const created = await createCounterparty(owner.client, { companyId: owner.companyId, name: "New identity", supplier: false, customer: true });
  if (!created.ok) throw new Error(created.error);
  const currentId = created.value.id;
  const ids = await legacyCounterpartyTradeFixture(owner, [{
    previous: { ...SAMPLE_EXTRACTION, counterpartyLink: { id: old.id } },
    payload: { ...SAMPLE_EXTRACTION, counterpartyLink: { id: currentId } },
  }]);
  expect((await listCounterpartyDocuments(owner.client, owner.companyId, old.id)).total).toBe(1);
  expect(await getCounterpartyStatistics(owner.client, owner.companyId, old.id, { year: "2026" })).toMatchObject({ ok: true, value: { total: 0, groups: [] } });
  expect((await updateCounterparty(owner.client, { companyId: owner.companyId, id: currentId, name: "Renamed", supplier: false, customer: true })).ok).toBe(true);
  expect((await archiveCounterparty(owner.client, { companyId: owner.companyId, id: currentId })).ok).toBe(true);
  expect(await getCounterpartyStatistics(owner.client, owner.companyId, currentId, { year: "2026" })).toMatchObject({ ok: true, value: {
    total: 1, groups: [{ direction: "incoming", netAmount: "1000.00" }], entries: [{ documentId: ids[0], version: 2 }],
  } });
});

it("omits malformed and stale stored fixings while preserving zero, signed and unavailable CZK contributions", async () => {
  const owner = await administratorWithCompany();
  await knownSupplierFixture(owner);
  const [party] = (await listCounterparties(owner.client, owner.companyId)).entries;
  const base = { ...SAMPLE_EXTRACTION, counterpartyLink: { id: party.id }, currency: "EUR", taxPointDate: "2026-10-01",
    totals: { netAmount: "100.00", vatAmount: "21.00", grossAmount: "121.00" } };
  const conversion = { originalCurrency: "EUR", source: "CNB" as const, rate: "25", unit: 1, rateDate: "2026-09-30",
    rateBreakdown: [{ rate: 21 as const, netAmount: "2500.00", vatAmount: "525.00" }],
    totals: { netAmount: "2500.00", vatAmount: "525.00", grossAmount: "3025.00" } };
  const invalid = [
    undefined,
    { ...conversion, originalCurrency: "USD" },
    { ...conversion, source: "unverified" },
    { ...conversion, rateDate: "2026-10-02" },
    { ...conversion, rateDate: "2026-02-30" },
    { ...conversion, rateDate: "0000-01-01" },
    { ...conversion, rateDate: "yesterday" },
    { ...conversion, rate: "0" },
    { ...conversion, rate: "-25" },
    { ...conversion, rate: "NaN" },
    { ...conversion, unit: 0 },
    { ...conversion, unit: 1.5 },
    { ...conversion, unit: "1" },
    { ...conversion, totals: { ...conversion.totals, vatAmount: null } },
    { ...conversion, totals: { ...conversion.totals, netAmount: "2500" } },
    { ...conversion, totals: { ...conversion.totals, grossAmount: "3024.00" } },
    { ...conversion, rate: "24" },
  ];
  // Historical malformed data is setup only; observations remain the real User query.
  const omitted = await legacyCounterpartyTradeFixture(owner, invalid.map(czkConversion => ({
    payload: { ...base, czkConversion } as typeof base,
  })));
  const allMissing = await getCounterpartyStatistics(owner.client, owner.companyId, party.id, { year: "2026" });
  expect(allMissing).toMatchObject({ ok: true, value: { total: 17,
    groups: [{ currency: "EUR", documentCount: 17, netAmount: "1700.00", vatAmount: "357.00", grossAmount: "2057.00" }],
    czkGroups: [{ direction: "incoming", documentCount: 17, amountCount: 0, missingAmountCount: 17,
      netAmount: null, vatAmount: null, grossAmount: null }],
  } });
  const valid = await legacyCounterpartyTradeFixture(owner, [
    { payload: { ...base, totals: { netAmount: "0.00", vatAmount: "0.00", grossAmount: "0.00" },
      czkConversion: { ...conversion, totals: { netAmount: "0.00", vatAmount: "0.00", grossAmount: "0.00" } } } },
    { payload: { ...base, documentType: "credit_note", totals: { netAmount: "-100.00", vatAmount: "-21.00", grossAmount: "-121.00" },
      czkConversion: { ...conversion, totals: { netAmount: "-2500.00", vatAmount: "-525.00", grossAmount: "-3025.00" } } } },
    { payload: { ...base, totals: { netAmount: "0.01", vatAmount: "0.00", grossAmount: "0.01" },
      czkConversion: { ...conversion, rate: "0.5", totals: { netAmount: "0.01", vatAmount: "0.00", grossAmount: "0.01" } } } },
    { payload: { ...base, documentType: "credit_note", totals: { netAmount: "-0.01", vatAmount: "0.00", grossAmount: "-0.01" },
      czkConversion: { ...conversion, rate: "0.5", totals: { netAmount: "-0.01", vatAmount: "0.00", grossAmount: "-0.01" } } } },
  ]);
  expect(await getCounterpartyStatistics(owner.client, owner.companyId, party.id, { year: "2026" })).toMatchObject({ ok: true, value: {
    total: 21, czkGroups: [{ documentCount: 21, amountCount: 4, missingAmountCount: 17,
      netAmount: "-2500.00", vatAmount: "-525.00", grossAmount: "-3025.00" }],
  } });
  for (const [contribution, expected] of [["czk_complete", valid], ["missing_czk", omitted]] as const) {
    const drill = await getCounterpartyStatistics(owner.client, owner.companyId, party.id, { year: "2026", currency: "EUR", contribution });
    if (!drill.ok) throw new Error(drill.error);
    expect(drill.value.entries.map(row => row.documentId).sort()).toEqual([...expected].sort());
    expect(drill.value.total).toBe(expected.length);
  }
});

it("uses the current full-Document conversion and discloses incomplete originals without trusting historical or reduced amounts", async () => {
  const owner = await administratorWithCompany();
  await knownSupplierFixture(owner);
  const [party] = (await listCounterparties(owner.client, owner.companyId)).entries;
  const base = { ...SAMPLE_EXTRACTION, counterpartyLink: { id: party.id }, currency: "EUR", taxPointDate: "2026-10-01",
    totals: { netAmount: "100.00", vatAmount: "21.00", grossAmount: "121.00" } };
  const conversion = { originalCurrency: "EUR", source: "CNB" as const, rate: "2500", unit: 100, rateDate: "2026-09-30",
    rateBreakdown: [{ rate: 21 as const, netAmount: "2500.00", vatAmount: "525.00" }],
    totals: { netAmount: "2500.00", vatAmount: "525.00", grossAmount: "3025.00" } };
  const ids = await legacyCounterpartyTradeFixture(owner, [
    { previous: { ...base, czkConversion: conversion }, payload: base },
    { payload: { ...base, czkConversion: conversion, partialClaim: { confirmed: true,
      rateBreakdown: [{ rate: 21, netAmount: "10.00", vatAmount: "2.10" }] },
      proportionalDeduction: { percentage: 40, confirmed: true, operatingExpenseConfirmed: true, actualUseConfirmed: true, origin: "user" } } },
    { payload: { ...base, currency: "CZK", totals: { netAmount: "100.00", vatAmount: null, grossAmount: "121.00" } } },
    { payload: { ...base, currency: null, czkConversion: { ...conversion, originalCurrency: null } } as unknown as typeof base },
    { payload: { ...base, totals: { netAmount: "100.00", vatAmount: null, grossAmount: "121.00" }, czkConversion: conversion } },
    { payload: { ...base, documentNumber: "SAVED-GROSS-ADVISORY", totals: { netAmount: "0.01", vatAmount: "0.02", grossAmount: "0.04" },
      czkConversion: { ...conversion, totals: { netAmount: "0.25", vatAmount: "0.50", grossAmount: "1.00" } } } },
  ]);
  expect(await getCounterpartyStatistics(owner.client, owner.companyId, party.id, { year: "2026" })).toMatchObject({ ok: true, value: {
    total: 6, missingAmountCount: 3,
    czkGroups: [{ documentCount: 6, amountCount: 2, missingAmountCount: 4, netAmount: "2500.25", vatAmount: "525.50", grossAmount: "3026.00" }],
  } });
  const contributors = await getCounterpartyStatistics(owner.client, owner.companyId, party.id, { year: "2026", contribution: "czk_complete" });
  if (!contributors.ok) throw new Error(contributors.error);
  expect(contributors.value.entries.map(row => row.documentId).sort()).toEqual([ids[1], ids[5]].sort());
  expect(contributors.value.entries.find(row => row.documentId === ids[5])).toMatchObject({ grossMismatch: true,
    czkNetAmount: "0.25", czkVatAmount: "0.50", czkGrossAmount: "1.00" });
  const missing = await getCounterpartyStatistics(owner.client, owner.companyId, party.id, { year: "2026", contribution: "missing_czk" });
  if (!missing.ok) throw new Error(missing.error);
  expect(missing.value.entries.map(row => row.documentId).sort()).toEqual([ids[0], ids[2], ids[3], ids[4]].sort());
});
