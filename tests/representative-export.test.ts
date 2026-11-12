import { expect, it } from "vitest";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { getCompanyFilingDefaults, saveCompanyFilingDefaults } from "@/application/company-filing-defaults";
import { exportVatReport, readVatReportArtifact } from "@/application/epo-export";
import { readVatReportPdfArtifact } from "@/application/vat-report-pdf-artifacts";
import { exportVatReturnPdf } from "@/application/vat-return-pdf";
import { exportControlStatementPdf } from "@/application/control-statement-pdf";
import { generateVatReport } from "@/application/vat-reports";
import { administratorWithCompany, companyMember } from "./support/fixtures";

const representative = { code: "4a", personType: "F", firstName: "Alena", lastName: "Zástupná", birthDate: "1981-02-03", evidenceNumber: "" } as const;
const filing = { taxOffice: "451", territorialOffice: "2003", economicActivity: "621000", signatoryFirstName: "Jana", signatoryLastName: "Podpisová", signatoryCapacity: "jednatelka", email: "", phone: "", epoAddressOverride: null };
async function pdfText(bytes: Uint8Array) {
  const task = getDocument({ data: bytes.slice(), useSystemFonts: true });
  const pdf = await task.promise;
  try { return (await (await pdf.getPage(1)).getTextContent()).items.map(item => "str" in item ? item.str : "").join(" "); }
  finally { await task.destroy(); }
}
async function pdfField(bytes: Uint8Array, cell: readonly [number, number, number, number]) {
  const task = getDocument({ data: bytes.slice(), useSystemFonts: true });
  try {
    const page = await (await task.promise).getPage(1);
    const [left, top, right, bottom] = cell;
    return (await page.getTextContent()).items.flatMap(item => "str" in item
      && item.transform[4] >= left && item.transform[4] + item.width <= right + .5
      && page.view[3] - item.transform[5] >= top && page.view[3] - item.transform[5] <= bottom ? [item.str] : []).join("").trim();
  } finally { await task.destroy(); }
}
it("uses the Administrator's natural-person representative in both User XML/PDF exports and immutable metadata", async () => {
  const company = await administratorWithCompany();
  expect(await saveCompanyFilingDefaults(company.client, { ...filing, companyId: company.companyId, representative })).toEqual({ ok: true, value: null });
  expect((await getCompanyFilingDefaults(company.client, company.companyId))?.representative).toEqual(representative);
  await generateVatReport(company.client, { companyId: company.companyId, period: "2026-10" });
  const user = await companyMember(company);
  for (const format of ["dphdp3", "dphkh1"] as const) {
    const input = { companyId: company.companyId, period: "2026-10", details: { preparedOn: "2026-10-27" } };
    const xml = await exportVatReport(user.client, { ...input, format });
    if (!xml.ok) throw new Error(xml.error);
    expect(xml.value.xml).toContain('zast_kod="4a"');
    expect(xml.value.xml).toContain('zast_typ="F"');
    expect(xml.value.xml).toContain('zast_jmeno="Alena"');
    expect(xml.value.xml).toContain('zast_prijmeni="Zástupná"');
    expect(xml.value.xml).toContain('zast_dat_nar="03.02.1981"');
    expect(xml.value.xml).toContain('opr_jmeno="Jana"');
    const saved = await readVatReportArtifact(user.client, { companyId: company.companyId, artifactId: xml.value.artifactId });
    expect(saved?.artifact.resolvedDetails.representative).toEqual(representative);
    const pdf = format === "dphdp3" ? await exportVatReturnPdf(user.client, input) : await exportControlStatementPdf(user.client, input, undefined);
    if (!pdf.ok) throw new Error(pdf.error);
    expect(await pdfText(pdf.value.bytes)).toContain("Alena Zástupná");
    expect(await pdfText(pdf.value.bytes)).toContain("03.02.1981");
    expect(await pdfField(pdf.value.bytes, format === "dphdp3" ? [191.6, 576.1, 219.4, 592.6] : [191.6, 598.4, 219.4, 614.9])).toBe("4a");
    expect(await pdfField(pdf.value.bytes, format === "dphdp3" ? [49.9, 605.8, 559.6, 622.3] : [49.9, 628.1, 559.6, 644.6])).toBe("Alena Zástupná");
    expect(await pdfField(pdf.value.bytes, format === "dphdp3" ? [49.9, 634.2, 559.6, 650.7] : [49.9, 656.5, 559.6, 673])).toBe("03.02.1981");
    const pdfArchive = await readVatReportPdfArtifact(user.client, { companyId: company.companyId, artifactId: pdf.value.artifactId! });
    expect(pdfArchive?.bytes).toEqual(pdf.value.bytes);
    expect(pdfArchive?.artifact.resolvedDetails.representative).toEqual(representative);
  }
});

it("distinguishes omission, one-off override and explicit off without rewriting defaults or old artifacts", async () => {
  const company = await administratorWithCompany();
  await saveCompanyFilingDefaults(company.client, { ...filing, companyId: company.companyId, representative });
  await generateVatReport(company.client, { companyId: company.companyId, period: "2026-10" });
  const input = { companyId: company.companyId, period: "2026-10", format: "dphdp3", details: { preparedOn: "2026-10-27" } };
  const original = await exportVatReport(company.client, input);
  if (!original.ok) throw new Error(original.error);
  const archived = await readVatReportArtifact(company.client, { companyId: company.companyId, artifactId: original.value.artifactId });
  const changed = await exportVatReport(company.client, { ...input, details: { ...input.details, representativeMode: "override", representativeCode: "4a", representativePersonType: "F", representativeFirstName: "Pavel", representativeLastName: "Jiný", representativeBirthDate: "", representativeEvidenceNumber: "SYN-123", representativeName: "stale corporation", representativeIco: "12345678" } });
  if (!changed.ok) throw new Error(changed.error);
  expect(changed.value.xml).toContain('zast_jmeno="Pavel"');
  expect(changed.value.xml).toContain('zast_ev_cislo="SYN-123"');
  expect(changed.value.xml).not.toMatch(/zast_(?:dat_nar|nazev|ic)=/);
  const off = await exportVatReport(company.client, { ...input, details: { ...input.details, representativeMode: "off", representativeCode: "4c", representativeFirstName: "hidden" } });
  if (!off.ok) throw new Error(off.error);
  expect(off.value.xml).not.toContain("zast_");
  expect((await getCompanyFilingDefaults(company.client, company.companyId))?.representative).toEqual(representative);
  const again = await exportVatReport(company.client, input);
  if (!again.ok) throw new Error(again.error);
  expect(again.value.xml).toContain('zast_jmeno="Alena"');
  await saveCompanyFilingDefaults(company.client, { ...filing, companyId: company.companyId, representative: { ...representative, firstName: "Marie" } });
  expect(await readVatReportArtifact(company.client, { companyId: company.companyId, artifactId: original.value.artifactId })).toEqual(archived);
});

it("keeps natural taxpayers, their natural representative and the account author distinct, including direct legacy exports", async () => {
  const company = await administratorWithCompany();
  const { updateCompanyIdentity } = await import("@/application/companies");
  const { companyDetails } = await import("./support/fixtures");
  expect(await updateCompanyIdentity(company.client, { companyId: company.companyId, ...companyDetails({ personType: "natural", firstName: "Karel", lastName: "Daňový", name: "Karel Daňový" }) })).toEqual({ ok: true, value: null });
  await saveCompanyFilingDefaults(company.client, { ...filing, companyId: company.companyId });
  await generateVatReport(company.client, { companyId: company.companyId, period: "2026-10" });
  const user = await companyMember(company);
  for (const format of ["dphdp3", "dphkh1"] as const) {
    const input = { companyId: company.companyId, period: "2026-10", format, details: { preparedOn: "2026-10-27" } };
    const direct = await exportVatReport(user.client, input);
    if (!direct.ok) throw new Error(direct.error);
    expect(direct.value.xml).not.toMatch(/zast_|opr_/);
    expect(direct.value.xml).toContain('typ_ds="F"');
    expect(direct.value.xml).toContain('jmeno="Karel"');
    await saveCompanyFilingDefaults(company.client, { ...filing, companyId: company.companyId, representative });
    const represented = await exportVatReport(user.client, input);
    if (!represented.ok) throw new Error(represented.error);
    expect(represented.value.xml).toContain('zast_jmeno="Alena"');
    expect(represented.value.xml).toContain('jmeno="Karel"');
    expect(represented.value.xml).not.toContain("opr_");
    const archive = await readVatReportArtifact(user.client, { companyId: company.companyId, artifactId: represented.value.artifactId });
    expect(archive?.artifact.authorUserId).toBe(user.userId);
    const pdf = format === "dphdp3" ? await exportVatReturnPdf(user.client, input) : await exportControlStatementPdf(user.client, input, undefined);
    if (!pdf.ok) throw new Error(pdf.error);
    expect(await pdfText(pdf.value.bytes)).toContain("Alena Zástupná");
    expect(await pdfText(pdf.value.bytes)).toContain("Karel");
    const off = await exportVatReport(user.client, { ...input, details: { ...input.details, representativeMode: "off" } });
    if (!off.ok) throw new Error(off.error);
    expect(off.value.xml).not.toContain("zast_");
    await saveCompanyFilingDefaults(company.client, { ...filing, companyId: company.companyId });
  }
});

it("allows incomplete representative previews but refuses incomplete XML and all unsupported combinations without fallback", async () => {
  const company = await administratorWithCompany();
  await saveCompanyFilingDefaults(company.client, { ...filing, companyId: company.companyId, representative });
  await generateVatReport(company.client, { companyId: company.companyId, period: "2026-10" });
  const input = { companyId: company.companyId, period: "2026-10" };
  const selected = { preparedOn: "2026-10-27", representativeMode: "override", representativeCode: "4a", representativePersonType: "F", representativeFirstName: "Eva", representativeLastName: "", representativeBirthDate: "", representativeEvidenceNumber: "" };
  for (const format of ["dphdp3", "dphkh1"] as const) {
    const preview = format === "dphdp3" ? await exportVatReturnPdf(company.client, { ...input, details: selected }) : await exportControlStatementPdf(company.client, { ...input, details: selected }, undefined);
    if (!preview.ok) throw new Error(preview.error);
    expect(await pdfText(preview.value.bytes)).toContain("Eva");
    expect(await exportVatReport(company.client, { ...input, format, details: selected })).toEqual({ ok: false, error: "invalid_representative" });
    for (const patch of [
      { representativeCode: "4b", representativePersonType: "F" }, { representativeCode: "4b", representativePersonType: "P" },
      { representativeCode: "4c", representativePersonType: "F" }, { representativeCode: "4c", representativePersonType: "P" },
      { representativeCode: "4a", representativePersonType: "P" }, { representativeCode: "1" },
      { representativeBirthDate: "1981-02-30" }, { representativeFirstName: "X".repeat(21) },
      { representativeLastName: "Y".repeat(37) }, { representativeEvidenceNumber: "Z".repeat(37) },
      { representativeMode: "unknown" },
    ]) {
      expect(await exportVatReport(company.client, { ...input, format, details: { ...selected, representativeLastName: "Jiná", representativeBirthDate: "1981-02-03", ...patch } })).toEqual({ ok: false, error: "invalid_representative" });
    }
  }
});

it("enforces existing default permissions and tenant isolation at the direct RPC boundary without personal audit data", async () => {
  const company = await administratorWithCompany();
  const user = await companyMember(company);
  const { provisionedUser } = await import("./support/clients");
  const outsider = await provisionedUser();
  const input = { ...filing, companyId: company.companyId, representative };
  expect(await saveCompanyFilingDefaults(company.client, input)).toEqual({ ok: true, value: null });
  expect(await saveCompanyFilingDefaults(user.client, input)).toEqual({ ok: false, error: "forbidden" });
  expect(await saveCompanyFilingDefaults(outsider.client, input)).toEqual({ ok: false, error: "forbidden" });
  expect(await getCompanyFilingDefaults(outsider.client, company.companyId)).toBeNull();
  expect((await outsider.client.from("company_filing_defaults").select("representative").eq("company_id", company.companyId)).data).toEqual([]);
  expect((await outsider.client.from("company_filing_defaults").update({ representative: null }).eq("company_id", company.companyId)).error?.code).toBe("42501");
  const rpc = { target_company_id: company.companyId, new_tax_office: "451", new_territorial_office: "2003", new_economic_activity: "621000", new_signatory_first_name: "Jana", new_signatory_last_name: "Podpisová", new_signatory_capacity: "jednatelka", new_email: "", new_phone: "", new_epo_street_name: "", new_epo_house_number: "", new_epo_orientation_number: "", new_epo_city: "", new_epo_postal_code: "", epo_address_confirmed: false, new_representative: representative };
  expect((await user.client.rpc("set_company_filing_defaults", rpc)).error?.code).toBe("42501");
  expect((await outsider.client.rpc("set_company_filing_defaults", rpc)).error?.code).toBe("42501");
  for (const profile of [{ ...representative, code: "4b" }, { ...representative, personType: "P" }, { ...representative, birthDate: "1981-02-30" }, { ...representative, firstName: "" }, { ...representative, firstName: 123 }]) {
    const refused = await company.client.rpc("set_company_filing_defaults", { ...rpc, new_representative: profile });
    expect(refused.error?.hint).toBe("invalid_representative");
  }
  expect((await getCompanyFilingDefaults(company.client, company.companyId))?.representative).toEqual(representative);
  const { listAuditEvents } = await import("@/application/audit");
  const audit = JSON.stringify(await listAuditEvents(company.client, company.organizationId));
  expect(audit).not.toMatch(/Alena|Zástupná|1981-02-03|representative|Podpisová/);
});

it("preserves finalized report state and historical final artifacts when defaults change", async () => {
  const company = await administratorWithCompany();
  await saveCompanyFilingDefaults(company.client, { ...filing, companyId: company.companyId, representative });
  await generateVatReport(company.client, { companyId: company.companyId, period: "2026-10" });
  const { finalizeVatReport, getVatReport, getPeriodLock } = await import("@/application/vat-reports");
  const { exportFinalVatReport } = await import("@/application/epo-export");
  await finalizeVatReport(company.client, { companyId: company.companyId, period: "2026-10", confirmed: true });
  const before = await getVatReport(company.client, company.companyId, "2026-10");
  const lock = await getPeriodLock(company.client, company.companyId, "2026-10");
  const user = await companyMember(company);
  for (const format of ["dphdp3", "dphkh1"] as const) {
    const input = { companyId: company.companyId, period: "2026-10", format, details: { preparedOn: "2026-10-27" } };
    const first = await exportFinalVatReport(user.client, input);
    if (!first.ok) throw new Error(first.error);
    const readInput = { companyId: company.companyId, artifactId: first.value.artifactId };
    const archive = await readVatReportArtifact(user.client, readInput);
    await saveCompanyFilingDefaults(company.client, { ...filing, companyId: company.companyId, representative: { ...representative, firstName: "Marie" } });
    const next = await exportFinalVatReport(user.client, { ...input, details: { ...input.details, representativeMode: "off" } });
    if (!next.ok) throw new Error(next.error);
    expect(next.value.xml).not.toContain("zast_");
    expect(next.value.reportGeneratedAt).toBe(first.value.reportGeneratedAt);
    expect(next.value.periodLockId).toBe(first.value.periodLockId);
    expect(await readVatReportArtifact(user.client, readInput)).toEqual(archive);
    expect(await getVatReport(company.client, company.companyId, "2026-10")).toEqual(before);
    expect(await getPeriodLock(company.client, company.companyId, "2026-10")).toEqual(lock);
  }
});

it("archives complete PDF exports immutably without changing XML progress, while thumbnails remain ephemeral", async () => {
  const company = await administratorWithCompany();
  await saveCompanyFilingDefaults(company.client, { ...filing, companyId: company.companyId, representative });
  await generateVatReport(company.client, { companyId: company.companyId, period: "2026-10" });
  const user = await companyMember(company);
  const { provisionedUser } = await import("./support/clients");
  const outsider = await provisionedUser();
  const { listVatReportPdfArtifacts } = await import("@/application/vat-report-pdf-artifacts");
  const { exportVatReturnThumbnail } = await import("@/application/vat-return-pdf");
  const { exportControlStatementThumbnail } = await import("@/application/control-statement-pdf");
  const { finalizeVatReport, getVatReport, getPeriodLock, unlockReportingPeriod } = await import("@/application/vat-reports");
  const { getVatReportExportProgress } = await import("@/application/epo-export");
  const input = { companyId: company.companyId, period: "2026-10", details: { preparedOn: "2026-10-27" } };
  const report = await getVatReport(user.client, input.companyId, input.period);
  if (!report) throw new Error("Report not found");
  for (const format of ["dphdp3", "dphkh1"] as const) {
    const thumbnail = format === "dphdp3" ? await exportVatReturnThumbnail(user.client, input) : await exportControlStatementThumbnail(user.client, input);
    expect(thumbnail.ok).toBe(true);
    expect(await listVatReportPdfArtifacts(user.client, input)).toHaveLength(format === "dphdp3" ? 0 : 1);
    const pdf = format === "dphdp3" ? await exportVatReturnPdf(user.client, input) : await exportControlStatementPdf(user.client, input, undefined);
    if (!pdf.ok || !pdf.value.artifactId) throw new Error("PDF not archived");
    const read = { companyId: company.companyId, artifactId: pdf.value.artifactId };
    const archive = await readVatReportPdfArtifact(user.client, read);
    expect(archive?.bytes).toEqual(pdf.value.bytes);
    expect(archive?.artifact).toMatchObject({ kind: "draft", periodLockId: null, format, schemaVersion: format === "dphdp3" ? "03.01.04" : "03.01.15", serializerVersion: "3", authorUserId: user.userId });
    expect(await readVatReportPdfArtifact(outsider.client, read)).toBeNull();
    expect(await listVatReportPdfArtifacts(outsider.client, input)).toEqual([]);
    expect((await outsider.client.from("vat_report_pdf_artifact").select("id").eq("id", read.artifactId)).data).toEqual([]);
    expect((await outsider.client.from("vat_report_pdf_artifact").update({ file_name: "foreign-change.pdf" }).eq("id", read.artifactId)).error?.code).toBe("42501");
    expect((await outsider.client.from("vat_report_pdf_artifact").delete().eq("id", read.artifactId)).error?.code).toBe("42501");
    expect(await readVatReportPdfArtifact(user.client, read)).toEqual(archive);
    expect((await user.client.from("vat_report_pdf_artifact").update({ file_name: "changed.pdf" }).eq("id", read.artifactId)).error?.code).toBe("42501");
    expect((await user.client.from("vat_report_pdf_artifact").delete().eq("id", read.artifactId)).error?.code).toBe("42501");
    await saveCompanyFilingDefaults(company.client, { ...filing, companyId: company.companyId, representative: { ...representative, firstName: "Marie" } });
    expect(await readVatReportPdfArtifact(user.client, read)).toEqual(archive);
  }
  expect(await getVatReportExportProgress(user.client, { companyId: input.companyId, period: input.period, reportGeneratedAt: report.generatedAt, kind: "draft" })).toEqual({ downloadedFormats: [], skippedFormats: [] });
  await finalizeVatReport(company.client, { ...input, confirmed: true });
  const lock = await getPeriodLock(company.client, input.companyId, input.period);
  const final = await exportVatReturnPdf(user.client, { ...input, details: { ...input.details, representativeMode: "off", taxOffice: "" } });
  if (!final.ok || !final.value.artifactId) throw new Error("Final review PDF refused");
  const archivedFinal = await readVatReportPdfArtifact(user.client, { companyId: input.companyId, artifactId: final.value.artifactId });
  expect(archivedFinal?.artifact).toMatchObject({ kind: "final", periodLockId: lock?.id, resolvedDetails: { taxOffice: "" } });
  expect(await unlockReportingPeriod(company.client, { ...input, confirmed: true, reason: "Synthetic PDF retention lifecycle check" })).toEqual({ ok: true, value: null });
  expect(await readVatReportPdfArtifact(user.client, { companyId: input.companyId, artifactId: final.value.artifactId })).toEqual(archivedFinal);
});
