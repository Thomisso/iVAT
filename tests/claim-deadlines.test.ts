import { expect, it, inject } from "vitest";
import { SAMPLE_EXTRACTION } from "@/ai/fake";
import type { ExtractionPayload } from "@/application/extraction-payload";
import { setCurrentReportingYear } from "@/application/companies";
import { createManualDocument, approveDocument, getDocument } from "@/application/documents";
import { fakeExchangeRates } from "@/cnb/fake";
import { fakeVatPayerRegistry } from "@/vat-registry/fake";
import { administratorWithCompany } from "./support/fixtures";
import { withClaimDate } from "./support/claim-clock";

it("includes the old claim's 1 July 2014 last day and refuses a new approval on 2 July", async () => {
  await withClaimDate(inject("databaseUrl"), "2014-07-01", async clock => {
    const user = await administratorWithCompany();
    expect(await setCurrentReportingYear(user.client, { companyId: user.companyId, year: 2011, filingFrequency: "quarterly" })).toEqual({ ok: true, value: null });
    const create = async () => {
      const result = await createManualDocument(user.client, { companyId: user.companyId, payload: {
        ...SAMPLE_EXTRACTION, taxPointDate: "2011-06-15", issueDate: "2011-06-15",
        rateBreakdown: [{ rate: 20, netAmount: "1000.00", vatAmount: "200.00" }],
        totals: { netAmount: "1000.00", vatAmount: "200.00", grossAmount: "1200.00" },
        claimEligibility: { period: "2011-Q2", origin: "user", confirmed: true },
      } }, fakeExchangeRates(), fakeVatPayerRegistry());
      if (!result.ok) throw new Error(result.error);
      return { companyId: user.companyId, documentId: result.value.id, version: 1 };
    };
    const timely = await create();
    const late = await create();
    expect(await approveDocument(user.client, timely)).toEqual({ ok: true, value: null });
    await clock.setDate("2014-07-02");
    expect(await approveDocument(user.client, late)).toEqual({ ok: false, error: "claim_deadline_expired" });
    expect(await getDocument(user.client, late.companyId, late.documentId)).toMatchObject({ status: "needs_review", importDate: null });
    expect(await getDocument(user.client, timely.companyId, timely.documentId)).toMatchObject({ status: "approved" });
  });
});

it("ends a 2025 entitlement on 31 December 2027 independently of upload or approval time", async () => {
  await withClaimDate(inject("databaseUrl"), "2027-12-31", async clock => {
    const user = await administratorWithCompany();
    expect(await setCurrentReportingYear(user.client, { companyId: user.companyId, year: 2025, filingFrequency: "monthly" })).toEqual({ ok: true, value: null });
    const create = async () => {
      const result = await createManualDocument(user.client, { companyId: user.companyId, payload: {
        ...SAMPLE_EXTRACTION, taxPointDate: "2025-05-26", issueDate: "2025-05-26",
        claimEligibility: { period: "2025-07", origin: "user", confirmed: true },
      } }, fakeExchangeRates(), fakeVatPayerRegistry());
      if (!result.ok) throw new Error(result.error);
      return { companyId: user.companyId, documentId: result.value.id, version: 1 };
    };
    const timely = await create();
    const late = await create();
    // Possession is first confirmed for July; do not claim in May's proposal.
    const { updateDocumentReporting } = await import("@/application/documents");
    for (const input of [timely, late]) expect(await updateDocumentReporting(user.client, { ...input, claimedReportingPeriod: "2025-07" })).toEqual({ ok: true, value: null });
    expect(await approveDocument(user.client, timely)).toEqual({ ok: true, value: null });
    await clock.setDate("2028-01-01");
    expect(await approveDocument(user.client, late)).toEqual({ ok: false, error: "claim_deadline_expired" });
  });
});

it.each([
  ["2016-10-15", "2019-11-01", "2019-11-02"],
  ["2016-11-15", "2019-12-02", "2019-12-03"],
  ["2016-12-15", "2020-01-02", "2020-01-03"],
  ["2017-01-15", "2020-02-03", "2020-02-04"],
  ["2017-02-15", "2020-03-02", "2020-03-03"],
  ["2021-03-15", "2024-04-02", "2024-04-03"],
  ["2021-04-15", "2024-05-02", "2024-05-03"],
  ["2023-12-15", "2027-01-04", "2027-01-05"],
  ["2024-12-15", "2028-01-03", "2028-01-04"],
  ["2026-05-26", "2029-01-02", "2029-01-03"],
])("retains the inclusive Czech calendar deadline for origin %s through public approval", async (origin, last, lateDate) => {
  await withClaimDate(inject("databaseUrl"), last, async clock => {
    const user = await administratorWithCompany();
    expect(await setCurrentReportingYear(user.client, { companyId: user.companyId, year: Number(origin.slice(0, 4)), filingFrequency: "monthly" })).toEqual({ ok: true, value: null });
    const create = async () => {
      const result = await createManualDocument(user.client, { companyId: user.companyId, payload: {
        ...SAMPLE_EXTRACTION, taxPointDate: origin, issueDate: origin,
        claimEligibility: { period: origin.slice(0, 7), origin: "user", confirmed: true },
      } }, fakeExchangeRates(), fakeVatPayerRegistry());
      if (!result.ok) throw new Error(result.error);
      return { companyId: user.companyId, documentId: result.value.id, version: 1 };
    };
    const timely = await create();
    const late = await create();
    expect(await approveDocument(user.client, timely)).toEqual({ ok: true, value: null });
    await clock.setDate(lateDate);
    expect(await approveDocument(user.client, late)).toEqual({ ok: false, error: "claim_deadline_expired" });
  });
});

it.each(["draft", "final"] as const)("rechecks the old cutoff for new %s XML while retaining exact archived bytes", async kind => {
  await withClaimDate(inject("databaseUrl"), "2019-12-02", async clock => {
    const { updateDocumentReporting } = await import("@/application/documents");
    const { generateVatReport, getVatReport, finalizeVatReport } = await import("@/application/vat-reports");
    const { exportVatReport, exportFinalVatReport, readVatReportArtifact, listVatReportArtifacts } = await import("@/application/epo-export");
    const user = await administratorWithCompany();
    for (const year of [2016, 2019]) expect(await setCurrentReportingYear(user.client, { companyId: user.companyId, year, filingFrequency: "monthly" })).toEqual({ ok: true, value: null });
    const created = await createManualDocument(user.client, { companyId: user.companyId, payload: {
      ...SAMPLE_EXTRACTION, taxPointDate: "2016-11-15", issueDate: "2016-11-15",
      claimEligibility: { period: "2016-11", origin: "user", confirmed: true },
    } }, fakeExchangeRates(), fakeVatPayerRegistry());
    if (!created.ok) throw new Error(created.error);
    expect(await updateDocumentReporting(user.client, { companyId: user.companyId, documentId: created.value.id, claimedReportingPeriod: "2019-11" })).toEqual({ ok: true, value: null });
    expect(await approveDocument(user.client, { companyId: user.companyId, documentId: created.value.id, version: 1 })).toEqual({ ok: true, value: null });
    // November ended immediately before the cutoff; filing need not wait for
    // the ordinary 25th-day due date. This is the last feasible ordinary month.
    expect(await generateVatReport(user.client, { companyId: user.companyId, period: "2019-11" })).toMatchObject({ ok: true });
    const saved = await getVatReport(user.client, user.companyId, "2019-11");
    expect(saved?.result.vatReturn.find(line => line.line === "40")).toMatchObject({ netAmount: "1000.00", vatAmount: "210.00", documentIds: [created.value.id] });
    if (kind === "final") expect(await finalizeVatReport(user.client, { companyId: user.companyId, period: "2019-11", confirmed: true })).toEqual({ ok: true, value: null });
    const exporter = kind === "final" ? exportFinalVatReport : exportVatReport;
    const input = { companyId: user.companyId, period: "2019-11", format: "dphdp3", details: {
      taxOffice: "451", territorialOffice: "2003", economicActivity: "621000", personType: "P", preparedOn: "2019-12-02",
      email: "qa@example.test", phone: "", signatoryFirstName: "Jana", signatoryLastName: "Nováková", signatoryCapacity: "jednatelka",
    } };
    const artifact = await exporter(user.client, input);
    if (!artifact.ok) throw new Error(artifact.error);
    expect(artifact.value.xml).toContain('odp_tuz23_nar="210"');
    const original = await readVatReportArtifact(user.client, { companyId: user.companyId, artifactId: artifact.value.artifactId });
    await clock.setDate("2019-12-03");
    expect(await exporter(user.client, input, () => new Date("2019-12-02T12:00:00Z"))).toEqual({ ok: false, error: "claim_eligibility_unresolved" });
    const direct = await user.client.rpc(kind === "final" ? "create_final_vat_report_artifact" : "create_draft_vat_report_artifact", {
      target_company_id: user.companyId, target_vat_report_id: saved!.id, target_report_generated_at: saved!.generatedAt,
      target_format: "dphdp3", target_file_name: artifact.value.fileName, target_xml_base64: Buffer.from(artifact.value.bytes).toString("base64"),
      target_resolved_details: { ...input.details, claimEvaluatedOn: "2019-12-02" }, target_schema_version: "03.01.04", target_serializer_version: "2",
    });
    expect(direct.error).toMatchObject({ code: "P0001", hint: "claim_eligibility_unresolved" });
    expect(await generateVatReport(user.client, { companyId: user.companyId, period: "2019-11" })).toEqual({ ok: false, error: "claim_eligibility_unresolved" });
    expect(await getVatReport(user.client, user.companyId, "2019-11")).toEqual(saved);
    expect(await readVatReportArtifact(user.client, { companyId: user.companyId, artifactId: artifact.value.artifactId })).toEqual(original);
    expect(await listVatReportArtifacts(user.client, { companyId: user.companyId, period: "2019-11" })).toHaveLength(1);
  });
});

it.each([
  ["monthly", "2025-07", "2027-11", "2027-12"],
  ["quarterly", "2025-Q3", "2027-Q3", "2027-Q4"],
] as const)("limits %s ordinary claims to a period that can end before the filing cutoff", async (frequency, earliest, latest, impossible) => {
  await withClaimDate(inject("databaseUrl"), "2027-12-31", async () => {
    const { updateDocumentReporting, listDeferredClaimPeriods } = await import("@/application/documents");
    const user = await administratorWithCompany();
    for (const year of [2025, 2027]) expect(await setCurrentReportingYear(user.client, { companyId: user.companyId, year, filingFrequency: frequency })).toEqual({ ok: true, value: null });
    const created = await createManualDocument(user.client, { companyId: user.companyId, payload: {
      ...SAMPLE_EXTRACTION, taxPointDate: "2025-05-26", issueDate: "2025-05-26",
      claimEligibility: { period: earliest, origin: "user", confirmed: true },
    } }, fakeExchangeRates(), fakeVatPayerRegistry());
    if (!created.ok) throw new Error(created.error);
    const input = { companyId: user.companyId, documentId: created.value.id };
    expect(await updateDocumentReporting(user.client, { ...input, claimedReportingPeriod: impossible })).toEqual({ ok: false, error: "claimed_period_after_deadline" });
    expect((await user.client.rpc("update_document_reporting", { target_document_id: input.documentId, new_claimed_reporting_period: impossible })).error)
      .toMatchObject({ code: "P0001", hint: "claimed_period_after_deadline" });
    const options = await listDeferredClaimPeriods(user.client, input.companyId, input.documentId);
    expect(options).toContain(latest);
    expect(options).not.toContain(impossible);
    expect(await updateDocumentReporting(user.client, { ...input, claimedReportingPeriod: latest })).toEqual({ ok: true, value: null });
    expect(await approveDocument(user.client, { ...input, version: 1 })).toEqual({ ok: true, value: null });
  });
});

it("shows the trusted assessment date and records it on preparation and XML independently of presentation dates", async () => {
  await withClaimDate(inject("databaseUrl"), "2027-12-31", async clock => {
    const { updateDocumentReporting } = await import("@/application/documents");
    const { getDocumentReview } = await import("@/application/document-review");
    const { generateVatReport, getVatReport } = await import("@/application/vat-reports");
    const { exportVatReport, readVatReportArtifact } = await import("@/application/epo-export");
    const user = await administratorWithCompany();
    for (const year of [2025, 2027]) await setCurrentReportingYear(user.client, { companyId: user.companyId, year, filingFrequency: "monthly" });
    const created = await createManualDocument(user.client, { companyId: user.companyId, payload: {
      ...SAMPLE_EXTRACTION, taxPointDate: "2025-05-26", issueDate: "2025-05-26",
      claimEligibility: { period: "2025-07", origin: "user", confirmed: true },
    } }, fakeExchangeRates(), fakeVatPayerRegistry());
    if (!created.ok) throw new Error(created.error);
    const input = { companyId: user.companyId, documentId: created.value.id };
    await updateDocumentReporting(user.client, { ...input, claimedReportingPeriod: "2027-11" });
    expect((await getDocumentReview(user.client, input))?.reporting).toMatchObject({ claimDeadline: {
      lastFilingDate: "2027-12-31", evaluatedOn: "2027-12-31", latestOrdinaryPeriod: "2027-11",
    } });
    expect(await approveDocument(user.client, { ...input, version: 1 })).toEqual({ ok: true, value: null });
    expect(await generateVatReport(user.client, { companyId: user.companyId, period: "2027-11" })).toMatchObject({ ok: true });
    expect((await getVatReport(user.client, user.companyId, "2027-11"))?.result).toMatchObject({ claimEvaluatedOn: "2027-12-31" });
    const artifact = await exportVatReport(user.client, { companyId: user.companyId, period: "2027-11", format: "dphdp3", details: {
      taxOffice: "451", territorialOffice: "2003", economicActivity: "621000", personType: "P", preparedOn: "2027-12-01",
      email: "qa@example.test", phone: "", signatoryFirstName: "Jana", signatoryLastName: "Nováková", signatoryCapacity: "jednatelka",
    } }, () => new Date("2027-12-01T12:00:00Z"));
    if (!artifact.ok) throw new Error(artifact.error);
    expect(artifact.value).toMatchObject({ claimEvaluatedOn: "2027-12-31", timing: { today: "2027-12-01" } });
    expect((await readVatReportArtifact(user.client, { companyId: user.companyId, artifactId: artifact.value.artifactId }))?.artifact.resolvedDetails)
      .toMatchObject({ claimEvaluatedOn: "2027-12-31", preparedOn: "2027-12-01" });
    await clock.setDate("2028-01-01");
    const review = await getDocumentReview(user.client, input);
    expect(review?.reporting).toMatchObject({ claimDeadline: { lastFilingDate: "2027-12-31", evaluatedOn: "2028-01-01" } });
    expect(review?.shownFindings).toContainEqual(expect.objectContaining({ code: "claim_deadline_expired" }));
    expect(await exportVatReport(user.client, { companyId: user.companyId, period: "2027-11", format: "dphdp3", details: {
      taxOffice: "451", territorialOffice: "2003", economicActivity: "621000", personType: "P", preparedOn: "2027-12-01",
      email: "qa@example.test", phone: "", signatoryFirstName: "Jana", signatoryLastName: "Nováková", signatoryCapacity: "jednatelka",
    } }, () => new Date("2027-12-01T12:00:00Z"))).toEqual({ ok: false, error: "claim_eligibility_unresolved" });
    expect((await readVatReportArtifact(user.client, { companyId: user.companyId, artifactId: artifact.value.artifactId }))?.bytes).toEqual(artifact.value.bytes);

  });
});

it("refuses an impossible ordinary period even without an earliest-period confirmation", async () => {
  await withClaimDate(inject("databaseUrl"), "2027-12-31", async () => {
    const { updateDocumentReporting } = await import("@/application/documents");
    const user = await administratorWithCompany();
    for (const year of [2025, 2027]) await setCurrentReportingYear(user.client, { companyId: user.companyId, year, filingFrequency: "monthly" });
    const created = await createManualDocument(user.client, { companyId: user.companyId, payload: {
      ...SAMPLE_EXTRACTION, taxPointDate: "2025-05-26", issueDate: "2025-05-26",
    } }, fakeExchangeRates(), fakeVatPayerRegistry());
    if (!created.ok) throw new Error(created.error);
    expect(await updateDocumentReporting(user.client, { companyId: user.companyId, documentId: created.value.id, claimedReportingPeriod: "2027-12" }))
      .toEqual({ ok: false, error: "claimed_period_after_deadline" });
  });
});

it("keeps an unapproved excluded Document distinct from a fresh deduction when exporting a draft", async () => {
  await withClaimDate(inject("databaseUrl"), "2026-11-07", async () => {
    const { generateVatReport, getVatReport } = await import("@/application/vat-reports");
    const { exportVatReport } = await import("@/application/epo-export");
    const user = await administratorWithCompany();
    const created = await createManualDocument(user.client, { companyId: user.companyId, payload: SAMPLE_EXTRACTION }, fakeExchangeRates(), fakeVatPayerRegistry());
    if (!created.ok) throw new Error(created.error);
    expect(await generateVatReport(user.client, { companyId: user.companyId, period: "2026-10" })).toMatchObject({ ok: true });
    expect((await getVatReport(user.client, user.companyId, "2026-10"))?.result.excludedDocuments)
      .toContainEqual({ documentId: created.value.id, reason: "not_approved" });
    const exported = await exportVatReport(user.client, { companyId: user.companyId, period: "2026-10", format: "dphdp3", details: {
      taxOffice: "451", territorialOffice: "2003", economicActivity: "621000", personType: "P", preparedOn: "2026-11-07",
      email: "qa@example.test", phone: "", signatoryFirstName: "Jana", signatoryLastName: "Nováková", signatoryCapacity: "jednatelka",
    } });
    expect(exported).toMatchObject({ ok: true, value: { xml: expect.stringContaining('odp_tuz23_nar="0"') } });
  });
});

it("records a confirmed zero choice after expiry without a fictitious deduction while positive claims still expire", async () => {
  await withClaimDate(inject("databaseUrl"), "2027-12-31", async clock => {
    const { getDocumentReview } = await import("@/application/document-review");
    const { listDeferredClaimPeriods, returnDocumentToReview, updateDocumentReporting } = await import("@/application/documents");
    const { generateVatReport, getVatReport } = await import("@/application/vat-reports");
    const { exportVatReport, readVatReportArtifact } = await import("@/application/epo-export");
    const user = await administratorWithCompany();
    for (const year of [2025, 2027]) await setCurrentReportingYear(user.client, { companyId: user.companyId, year, filingFrequency: "monthly" });
    const create = async (documentNumber: string, zero: boolean) => {
      const created = await createManualDocument(user.client, { companyId: user.companyId, payload: {
        ...SAMPLE_EXTRACTION, documentNumber, taxPointDate: "2025-05-26", issueDate: "2025-05-26",
        claimEligibility: { period: "2025-05", origin: "user", confirmed: true },
        partialClaim: zero ? { confirmed: true, zeroConfirmed: true, rateBreakdown: [
          { rate: 21, netAmount: "0.00", vatAmount: "0.00" },
        ] } : undefined,
      } }, fakeExchangeRates(), fakeVatPayerRegistry());
      if (!created.ok) throw new Error(created.error);
      return { companyId: user.companyId, documentId: created.value.id, version: 1 };
    };
    const details = {
      taxOffice: "451", territorialOffice: "2003", economicActivity: "621000", personType: "P", preparedOn: "2027-12-31",
      email: "qa@example.test", phone: "", signatoryFirstName: "Jana", signatoryLastName: "Nováková", signatoryCapacity: "jednatelka",
    };
    const archivedZero = await create("ZERO-ARCHIVED-238", true);
    expect(await approveDocument(user.client, archivedZero)).toEqual({ ok: true, value: null });
    expect(await generateVatReport(user.client, { companyId: user.companyId, period: "2025-05" })).toMatchObject({ ok: true });
    const originalReport = await getVatReport(user.client, user.companyId, "2025-05");
    const archived = await exportVatReport(user.client, { companyId: user.companyId, period: "2025-05", format: "dphdp3", details });
    if (!archived.ok) throw new Error(archived.error);
    const originalArtifact = await readVatReportArtifact(user.client, { companyId: user.companyId, artifactId: archived.value.artifactId });

    await clock.setDate("2028-01-01");
    const zero = await create("ZERO-AFTER-CUTOFF-238", true);
    const positive = await create("POSITIVE-AFTER-CUTOFF-238", false);
    const zeroOptions = await listDeferredClaimPeriods(user.client, zero.companyId, zero.documentId);
    // The first RED must be the real approval of an otherwise-valid zero choice.
    expect(await approveDocument(user.client, zero)).toEqual({ ok: true, value: null });
    expect(await approveDocument(user.client, positive)).toEqual({ ok: false, error: "claim_deadline_expired" });
    expect((await user.client.rpc("approve_document", { target_document_id: positive.documentId, reviewed_version: 1 })).error)
      .toMatchObject({ code: "P0001", hint: "claim_deadline_expired" });
    expect((await getDocumentReview(user.client, zero))?.shownFindings.some(finding => finding.code === "claim_deadline_expired" || finding.code === "claimed_period_after_deadline")).toBe(false);
    expect(zeroOptions).toContain("2027-12");
    // Explicitly recording zero in December does not claim a late deduction.
    expect(await returnDocumentToReview(user.client, zero)).toEqual({ ok: true, value: null });
    expect(await updateDocumentReporting(user.client, { ...zero, claimedReportingPeriod: "2027-12" })).toEqual({ ok: true, value: null });
    expect(await approveDocument(user.client, zero)).toEqual({ ok: true, value: null });
    expect(await generateVatReport(user.client, { companyId: user.companyId, period: "2027-12" })).toMatchObject({ ok: true });
    const report = await getVatReport(user.client, user.companyId, "2027-12");
    expect(report?.result.totals.inputVat).toBe("0.00");
    expect(report?.result.controlStatement).toEqual([]);
    expect(report?.result.excludedDocuments).toEqual([]);
    for (const format of ["dphdp3", "dphkh1"]) {
      const exported = await exportVatReport(user.client, { companyId: user.companyId, period: "2027-12", format, details: { ...details, preparedOn: "2028-01-01" } });
      if (!exported.ok) throw new Error(exported.error);
      if (format === "dphdp3") expect(exported.value.xml).toContain('odp_tuz23_nar="0"');
      else expect(exported.value.xml).not.toMatch(/<VetaB[123]\b/);
    }
    expect(await getVatReport(user.client, user.companyId, "2025-05")).toEqual(originalReport);
    expect(await readVatReportArtifact(user.client, { companyId: user.companyId, artifactId: archived.value.artifactId })).toEqual(originalArtifact);
    expect(await getDocument(user.client, positive.companyId, positive.documentId)).toMatchObject({ status: "needs_review" });
  });
});

it.each([
  { name: "positive selection with the zero flag", partialClaim: { confirmed: true, zeroConfirmed: true,
    rateBreakdown: [{ rate: 21, netAmount: "500.00", vatAmount: "105.00" }] }, finding: "claim_deadline_expired" },
  { name: "unconfirmed zero", partialClaim: { confirmed: false, zeroConfirmed: true,
    rateBreakdown: [{ rate: 21, netAmount: "0.00", vatAmount: "0.00" }] }, finding: "partial_claim_invalid" },
  { name: "zero without explicit zero confirmation", partialClaim: { confirmed: true, zeroConfirmed: false,
    rateBreakdown: [{ rate: 21, netAmount: "0.00", vatAmount: "0.00" }] }, finding: "partial_claim_invalid" },
  { name: "stale zero", partialClaim: { confirmed: true, zeroConfirmed: true, basis: {
    documentType: "invoice", direction: "incoming", currency: "CZK", proposedVatRegime: "domestic", taxPointDate: "2026-10-01",
    rateBreakdown: [{ rate: 21, netAmount: "1000.00", vatAmount: "210.00" }], totals: { netAmount: "1000.00", vatAmount: "210.00", grossAmount: "1210.00" },
  }, rateBreakdown: [{ rate: 21, netAmount: "0.00", vatAmount: "0.00" }] }, finding: "partial_claim_invalid" },
  { name: "inconsistent original net amount", partialClaim: { confirmed: true, zeroConfirmed: true,
    rateBreakdown: [{ rate: 21, netAmount: "0.00", vatAmount: "0.00" }] },
    totals: { netAmount: "1500.00", vatAmount: "210.00", grossAmount: "1710.00" }, finding: "total_net_amount_mismatch" },
] satisfies { name: string; partialClaim: NonNullable<ExtractionPayload["partialClaim"]>; totals?: ExtractionPayload["totals"]; finding: string }[])("does not use $name to bypass an expired claim or hide original findings", async ({ name, partialClaim, finding, ...changes }) => {
  await withClaimDate(inject("databaseUrl"), "2028-01-01", async () => {
    const { listDeferredClaimPeriods } = await import("@/application/documents");
    const { getDocumentReview } = await import("@/application/document-review");
    const user = await administratorWithCompany();
    for (const year of [2025, 2027]) await setCurrentReportingYear(user.client, { companyId: user.companyId, year, filingFrequency: "monthly" });
    const created = await createManualDocument(user.client, { companyId: user.companyId, payload: {
      ...SAMPLE_EXTRACTION, documentNumber: name, taxPointDate: "2025-05-26", issueDate: "2025-05-26", ...changes,
      claimEligibility: { period: "2025-05", origin: "user", confirmed: true },
      partialClaim: { ...partialClaim, rateBreakdown: [...partialClaim.rateBreakdown] },
    } }, fakeExchangeRates(), fakeVatPayerRegistry());
    if (!created.ok) throw new Error(created.error);
    const input = { companyId: user.companyId, documentId: created.value.id };
    expect(await approveDocument(user.client, { ...input, version: 1 })).toMatchObject({ ok: false });
    expect((await getDocumentReview(user.client, input))?.shownFindings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: finding, severity: "error" }),
      expect.objectContaining({ code: "claim_deadline_expired", severity: "error" }),
    ]));
    expect(await listDeferredClaimPeriods(user.client, input.companyId, input.documentId)).not.toContain("2027-12");
    expect(await getDocument(user.client, input.companyId, input.documentId)).toMatchObject({ status: "needs_review" });
  });
});

it("still requires predecessor earliest-period confirmation for an expired valid zero choice", async () => {
  await withClaimDate(inject("databaseUrl"), "2028-01-01", async () => {
    const user = await administratorWithCompany();
    await setCurrentReportingYear(user.client, { companyId: user.companyId, year: 2025, filingFrequency: "monthly" });
    const created = await createManualDocument(user.client, { companyId: user.companyId, payload: {
      ...SAMPLE_EXTRACTION, taxPointDate: "2025-05-26", issueDate: "2025-05-26",
      partialClaim: { confirmed: true, zeroConfirmed: true, rateBreakdown: [{ rate: 21, netAmount: "0.00", vatAmount: "0.00" }] },
    } }, fakeExchangeRates(), fakeVatPayerRegistry());
    if (!created.ok) throw new Error(created.error);
    expect(await approveDocument(user.client, { companyId: user.companyId, documentId: created.value.id, version: 1 }))
      .toEqual({ ok: false, error: "claim_eligibility_required" });
  });
});
