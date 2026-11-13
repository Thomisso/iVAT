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
type StoredArtifact = NonNullable<Awaited<ReturnType<typeof readVatReportArtifact>>> | NonNullable<Awaited<ReturnType<typeof readVatReportPdfArtifact>>>;
function expectSameArtifact(actual: StoredArtifact | null, before: StoredArtifact | null) {
  expect(actual?.artifact).toEqual(before?.artifact);
  expect(actual && before && Buffer.compare(actual.bytes, before.bytes)).toBe(0);
}
it("exports a professional natural-person default with either permitted identifier for both taxpayers and formats", async () => {
  const { updateCompanyIdentity } = await import("@/application/companies");
  const { companyDetails } = await import("./support/fixtures");
  for (const personType of ["natural", "legal"] as const) {
    const company = await administratorWithCompany();
    if (personType === "natural") expect(await updateCompanyIdentity(company.client, { companyId: company.companyId, ...companyDetails({ personType, firstName: "Karel", lastName: "Daňový", name: "Karel Daňový" }) })).toEqual({ ok: true, value: null });
    await generateVatReport(company.client, { companyId: company.companyId, period: "2026-10" });
    const user = await companyMember(company);
    for (const identity of [{ birthDate: "1981-02-03", evidenceNumber: "" }, { birthDate: "", evidenceNumber: "SYN-123" }]) {
      const professional = { ...representative, code: "4b", firstName: "Eva", lastName: "Poradná", ...identity } as const;
      expect(await saveCompanyFilingDefaults(company.client, { ...filing, companyId: company.companyId, representative: professional })).toEqual({ ok: true, value: null });
      expect((await getCompanyFilingDefaults(company.client, company.companyId))?.representative).toEqual(professional);
      for (const format of ["dphdp3", "dphkh1"] as const) {
        const input = { companyId: company.companyId, period: "2026-10", format, details: { preparedOn: "2026-10-27" } };
        const xml = await exportVatReport(user.client, input);
        if (!xml.ok) throw new Error(xml.error);
        expect(xml.value.xml).toContain('zast_kod="4b"');
        expect(xml.value.xml).toContain('zast_typ="F"');
        expect(xml.value.xml).toContain('zast_jmeno="Eva"');
        expect(xml.value.xml).toContain('zast_prijmeni="Poradná"');
        expect(xml.value.xml).toContain(identity.birthDate ? 'zast_dat_nar="03.02.1981"' : 'zast_ev_cislo="SYN-123"');
        expect(xml.value.xml).not.toMatch(identity.birthDate ? /zast_ev_cislo=/ : /zast_dat_nar=/);
        expect(xml.value.xml).not.toMatch(/zast_(?:nazev|ic)=/);
        if (personType === "natural") { expect(xml.value.xml).toContain('jmeno="Karel"'); expect(xml.value.xml).not.toContain("opr_"); }
        else expect(xml.value.xml).toContain('opr_jmeno="Jana"');
        const saved = await readVatReportArtifact(user.client, { companyId: company.companyId, artifactId: xml.value.artifactId });
        expect(saved?.bytes).toEqual(xml.value.bytes);
        expect(saved?.artifact).toMatchObject({ resolvedDetails: { representative: professional }, authorUserId: user.userId, serializerVersion: "5", schemaVersion: format === "dphdp3" ? "03.01.04" : "03.01.15" });
        const pdf = format === "dphdp3" ? await exportVatReturnPdf(user.client, input) : await exportControlStatementPdf(user.client, input, undefined);
        if (!pdf.ok) throw new Error(pdf.error);
        expect(await pdfField(pdf.value.bytes, format === "dphdp3" ? [191.6, 576.1, 219.4, 592.6] : [191.6, 598.4, 219.4, 614.9])).toBe("4b");
        expect(await pdfField(pdf.value.bytes, format === "dphdp3" ? [49.9, 605.8, 559.6, 622.3] : [49.9, 628.1, 559.6, 644.6])).toBe("Eva Poradná");
        expect(await pdfField(pdf.value.bytes, format === "dphdp3" ? [49.9, 634.2, 559.6, 650.7] : [49.9, 656.5, 559.6, 673])).toBe(identity.birthDate ? "03.02.1981" : "SYN-123");
        const storedPdf = await readVatReportPdfArtifact(user.client, { companyId: company.companyId, artifactId: pdf.value.artifactId! });
        // Compare every archived byte natively; object traversal dominates these large PDFs.
        expect(storedPdf && Buffer.compare(storedPdf.bytes, pdf.value.bytes)).toBe(0);
        expect(storedPdf?.artifact).toMatchObject({ resolvedDetails: { representative: professional }, serializerVersion: "5", authorUserId: user.userId });
      }
    }
  }
});
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
  const changed = await exportVatReport(company.client, { ...input, details: { ...input.details, representativeMode: "override", representativeCode: "4b", representativePersonType: "F", representativeFirstName: "Pavel", representativeLastName: "Jiný", representativeBirthDate: "", representativeEvidenceNumber: "SYN-123", representativeName: "stale corporation", representativeIco: "12345678" } });
  if (!changed.ok) throw new Error(changed.error);
  expect(changed.value.xml).toContain('zast_kod="4b"');
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
  await saveCompanyFilingDefaults(company.client, { ...filing, companyId: company.companyId, representative: { ...representative, code: "4b", firstName: "Marie" } });
  expect(await readVatReportArtifact(company.client, { companyId: company.companyId, artifactId: original.value.artifactId })).toEqual(archived);
});

it("retains compatible serializer-3 XML/PDF bytes and metadata after saving a professional profile", async () => {
  const company = await administratorWithCompany();
  await saveCompanyFilingDefaults(company.client, { ...filing, companyId: company.companyId, representative });
  await generateVatReport(company.client, { companyId: company.companyId, period: "2026-10" });
  for (const format of ["dphdp3", "dphkh1"] as const) {
    await saveCompanyFilingDefaults(company.client, { ...filing, companyId: company.companyId, representative });
    const input = { companyId: company.companyId, period: "2026-10", details: { preparedOn: "2026-10-27" } };
    const xml = await exportVatReport(company.client, { ...input, format });
    const pdf = format === "dphdp3" ? await exportVatReturnPdf(company.client, input) : await exportControlStatementPdf(company.client, input, undefined);
    if (!xml.ok || !pdf.ok) throw new Error("Fixture export failed");
    const current = await readVatReportArtifact(company.client, { companyId: company.companyId, artifactId: xml.value.artifactId });
    if (!current) throw new Error("Fixture archive missing");
    const common = { target_company_id: company.companyId, target_vat_report_id: current.artifact.vatReportId,
      target_report_generated_at: current.artifact.reportGeneratedAt, target_format: format,
      target_resolved_details: JSON.parse(JSON.stringify(current.artifact.resolvedDetails)),
      target_schema_version: format === "dphdp3" ? "03.01.04" : "03.01.15", target_serializer_version: "3" };
    // Exercise the retained public contract of a compatible older caller; do not reserialize history.
    const oldXml = await company.client.rpc("create_draft_vat_report_artifact", { ...common, target_file_name: xml.value.fileName, target_xml_base64: Buffer.from(xml.value.bytes).toString("base64") });
    const oldPdf = await company.client.rpc("create_vat_report_pdf_artifact", { ...common, target_pdf_base64: Buffer.from(pdf.value.bytes).toString("base64") });
    expect(oldXml.error).toBeNull(); expect(oldPdf.error).toBeNull();
    const xmlRead = { companyId: company.companyId, artifactId: oldXml.data! };
    const pdfRead = { companyId: company.companyId, artifactId: oldPdf.data! };
    const beforeXml = await readVatReportArtifact(company.client, xmlRead);
    const beforePdf = await readVatReportPdfArtifact(company.client, pdfRead);
    expect(beforeXml?.artifact.serializerVersion).toBe("3"); expect(beforePdf?.artifact.serializerVersion).toBe("3");
    expect(beforeXml?.bytes).toEqual(xml.value.bytes); expect(beforePdf?.bytes).toEqual(pdf.value.bytes);
    expect(await saveCompanyFilingDefaults(company.client, { ...filing, companyId: company.companyId, representative: { ...representative, code: "4b", firstName: "Eva" } })).toEqual({ ok: true, value: null });
    expect(await readVatReportArtifact(company.client, xmlRead)).toEqual(beforeXml);
    expect(await readVatReportPdfArtifact(company.client, pdfRead)).toEqual(beforePdf);
    expect((await company.client.rpc("create_draft_vat_report_artifact", { ...common, target_serializer_version: "999", target_file_name: xml.value.fileName, target_xml_base64: Buffer.from(xml.value.bytes).toString("base64") })).error?.hint).toBe("invalid_export_details");
    expect((await company.client.rpc("create_vat_report_pdf_artifact", { ...common, target_serializer_version: "999", target_pdf_base64: Buffer.from(pdf.value.bytes).toString("base64") })).error?.hint).toBe("invalid_export_details");
  }
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
  const selected = { preparedOn: "2026-10-27", representativeMode: "override", representativeCode: "4b", representativePersonType: "F", representativeFirstName: "Eva", representativeLastName: "", representativeBirthDate: "", representativeEvidenceNumber: "" };
  for (const format of ["dphdp3", "dphkh1"] as const) {
    const preview = format === "dphdp3" ? await exportVatReturnPdf(company.client, { ...input, details: selected }) : await exportControlStatementPdf(company.client, { ...input, details: selected }, undefined);
    if (!preview.ok) throw new Error(preview.error);
    expect(await pdfText(preview.value.bytes)).toContain("Eva");
    expect(await exportVatReport(company.client, { ...input, format, details: selected })).toEqual({ ok: false, error: "invalid_representative" });
    for (const missing of [{ representativeFirstName: "", representativeLastName: "Poradná", representativeBirthDate: "1981-02-03" }, { representativeFirstName: "Eva", representativeLastName: "Poradná", representativeBirthDate: "" }]) {
      const details = { ...selected, ...missing };
      expect(await exportVatReport(company.client, { ...input, format, details })).toEqual({ ok: false, error: "invalid_representative" });
      expect((format === "dphdp3" ? await exportVatReturnPdf(company.client, { ...input, details }) : await exportControlStatementPdf(company.client, { ...input, details }, undefined)).ok).toBe(true);
    }
    for (const patch of [
      { representativeCode: "4b", representativePersonType: "P" },
      { representativeCode: "4c", representativePersonType: "F" }, { representativeCode: "1" },
      { representativeBirthDate: "1981-02-30" }, { representativeFirstName: "X".repeat(21) },
      { representativeLastName: "Y".repeat(37) }, { representativeEvidenceNumber: "Z".repeat(37) },
      { representativeMode: "unknown" },
    ]) {
      const details = { ...selected, representativeLastName: "Jiná", representativeBirthDate: "1981-02-03", ...patch };
      expect(await exportVatReport(company.client, { ...input, format, details })).toEqual({ ok: false, error: "invalid_representative" });
      expect(format === "dphdp3" ? await exportVatReturnPdf(company.client, { ...input, details }) : await exportControlStatementPdf(company.client, { ...input, details }, undefined)).toEqual({ ok: false, error: "invalid_representative" });
    }
  }
});

it("enforces existing default permissions and tenant isolation at the direct RPC boundary without personal audit data", async () => {
  const company = await administratorWithCompany();
  const user = await companyMember(company);
  const { provisionedUser } = await import("./support/clients");
  const outsider = await provisionedUser();
  const professional = { ...representative, code: "4b" } as const;
  const input = { ...filing, companyId: company.companyId, representative: professional };
  expect(await saveCompanyFilingDefaults(company.client, input)).toEqual({ ok: true, value: null });
  expect(await saveCompanyFilingDefaults(user.client, input)).toEqual({ ok: false, error: "forbidden" });
  expect(await saveCompanyFilingDefaults(outsider.client, input)).toEqual({ ok: false, error: "forbidden" });
  expect(await getCompanyFilingDefaults(outsider.client, company.companyId)).toBeNull();
  expect((await outsider.client.from("company_filing_defaults").select("representative").eq("company_id", company.companyId)).data).toEqual([]);
  expect((await outsider.client.from("company_filing_defaults").update({ representative: null }).eq("company_id", company.companyId)).error?.code).toBe("42501");
  const rpc = { target_company_id: company.companyId, new_tax_office: "451", new_territorial_office: "2003", new_economic_activity: "621000", new_signatory_first_name: "Jana", new_signatory_last_name: "Podpisová", new_signatory_capacity: "jednatelka", new_email: "", new_phone: "", new_epo_street_name: "", new_epo_house_number: "", new_epo_orientation_number: "", new_epo_city: "", new_epo_postal_code: "", epo_address_confirmed: false, new_representative: professional };
  expect((await user.client.rpc("set_company_filing_defaults", rpc)).error?.code).toBe("42501");
  expect((await outsider.client.rpc("set_company_filing_defaults", rpc)).error?.code).toBe("42501");
  expect((await company.client.rpc("set_company_filing_defaults", rpc)).error).toBeNull();
  for (const profile of [{ ...professional, personType: "P" }, { ...professional, code: "4c" }, { ...professional, birthDate: "1981-02-30" }, { ...professional, firstName: "" }, { ...professional, firstName: 123 }, { ...professional, lastName: "" }, { ...professional, birthDate: "", evidenceNumber: "" }, { ...professional, evidenceNumber: "X".repeat(37) }]) {
    const refused = await company.client.rpc("set_company_filing_defaults", { ...rpc, new_representative: profile });
    expect(refused.error?.hint).toBe("invalid_representative");
  }
  expect((await getCompanyFilingDefaults(company.client, company.companyId))?.representative).toEqual(professional);
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
    await saveCompanyFilingDefaults(company.client, { ...filing, companyId: company.companyId, representative: { ...representative, code: "4b", firstName: "Marie" } });
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
    expect(archive?.artifact).toMatchObject({ kind: "draft", periodLockId: null, format, schemaVersion: format === "dphdp3" ? "03.01.04" : "03.01.15", serializerVersion: "5", authorUserId: user.userId });
    expect(await readVatReportPdfArtifact(outsider.client, read)).toBeNull();
    expect(await listVatReportPdfArtifacts(outsider.client, input)).toEqual([]);
    expect((await outsider.client.from("vat_report_pdf_artifact").select("id").eq("id", read.artifactId)).data).toEqual([]);
    expect((await outsider.client.from("vat_report_pdf_artifact").update({ file_name: "foreign-change.pdf" }).eq("id", read.artifactId)).error?.code).toBe("42501");
    expect((await outsider.client.from("vat_report_pdf_artifact").delete().eq("id", read.artifactId)).error?.code).toBe("42501");
    expect(await readVatReportPdfArtifact(user.client, read)).toEqual(archive);
    expect((await user.client.from("vat_report_pdf_artifact").update({ file_name: "changed.pdf" }).eq("id", read.artifactId)).error?.code).toBe("42501");
    expect((await user.client.from("vat_report_pdf_artifact").delete().eq("id", read.artifactId)).error?.code).toBe("42501");
    await saveCompanyFilingDefaults(company.client, { ...filing, companyId: company.companyId, representative: { ...representative, code: "4b", firstName: "Marie" } });
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


it("keeps a legal representative's confirmed signatory for a natural taxpayer in XML, PDF and immutable context", async () => {
  const company = await administratorWithCompany();
  const { updateCompanyIdentity } = await import("@/application/companies");
  const { companyDetails } = await import("./support/fixtures");
  expect(await updateCompanyIdentity(company.client, { companyId: company.companyId, ...companyDetails({ personType: "natural", firstName: "Karel", lastName: "Daňový", name: "Karel Daňový" }) })).toEqual({ ok: true, value: null });
  const legal = { code: "4a", personType: "P", name: "Atlas Poradenství s.r.o.", ico: "00123456", signatoryFirstName: "Irena", signatoryLastName: "Podpisová", signatoryCapacity: "jednatelka" } as const;
  expect(await saveCompanyFilingDefaults(company.client, { ...filing, companyId: company.companyId, representative: legal })).toEqual({ ok: true, value: null });
  expect((await getCompanyFilingDefaults(company.client, company.companyId))?.representative).toEqual(legal);
  await generateVatReport(company.client, { companyId: company.companyId, period: "2026-10" });
  const user = await companyMember(company);
  for (const format of ["dphdp3", "dphkh1"] as const) {
    const input = { companyId: company.companyId, period: "2026-10", details: { preparedOn: "2026-10-27" } };
    const xml = await exportVatReport(user.client, { ...input, format });
    if (!xml.ok) throw new Error(xml.error);
    for (const attribute of ['typ_ds="F"', 'jmeno="Karel"', 'prijmeni="Daňový"', 'zast_kod="4a"', 'zast_typ="P"', 'zast_nazev="Atlas Poradenství s.r.o."', 'zast_ic="00123456"', 'opr_jmeno="Irena"', 'opr_prijmeni="Podpisová"', 'opr_postaveni="jednatelka"']) expect(xml.value.xml).toContain(attribute);
    expect(xml.value.xml).not.toMatch(/zast_(?:jmeno|prijmeni|dat_nar|ev_cislo)=|opr_jmeno="Jana"|zkrobchjm=/);
    const saved = await readVatReportArtifact(user.client, { companyId: company.companyId, artifactId: xml.value.artifactId });
    expect(saved?.artifact).toMatchObject({ serializerVersion: "5", authorUserId: user.userId, resolvedDetails: { personType: "F", representative: legal, signatoryFirstName: "Irena", signatoryLastName: "Podpisová", signatoryCapacity: "jednatelka" } });
    const pdf = format === "dphdp3" ? await exportVatReturnPdf(user.client, input) : await exportControlStatementPdf(user.client, input, undefined);
    if (!pdf.ok) throw new Error(pdf.error);
    expect(await pdfField(pdf.value.bytes, format === "dphdp3" ? [49.9, 605.8, 559.6, 622.3] : [49.9, 628.1, 559.6, 644.6])).toBe("Atlas Poradenství s.r.o.");
    expect(await pdfField(pdf.value.bytes, format === "dphdp3" ? [49.9, 634.2, 559.6, 650.7] : [49.9, 656.5, 559.6, 673])).toBe("00123456");
    expect(await pdfField(pdf.value.bytes, format === "dphdp3" ? [49.9, 683.1, 559.6, 699.6] : [49.9, 705.4, 559.6, 721.9])).toBe("Irena Podpisová jednatelka");
    expect((await readVatReportPdfArtifact(user.client, { companyId: company.companyId, artifactId: pdf.value.artifactId! }))?.artifact).toMatchObject({ serializerVersion: "5", resolvedDetails: { personType: "F", representative: legal, signatoryFirstName: "Irena" } });
  }
});


it("never labels legal representative semantics with an older serializer and retains compatible old artifact bytes", async () => {
  const company = await administratorWithCompany();
  await saveCompanyFilingDefaults(company.client, { ...filing, companyId: company.companyId, representative });
  await generateVatReport(company.client, { companyId: company.companyId, period: "2026-10" });
  const { getVatReport } = await import("@/application/vat-reports");
  const report = (await getVatReport(company.client, company.companyId, "2026-10"))!;
  const retained: { id: string; fileName: string; bytes: Uint8Array; media: "xml" | "pdf"; before: StoredArtifact | null }[] = [];
  const legal = { code: "4c", personType: "P", name: "Atlas Poradenství s.r.o.", ico: "00123456", signatoryFirstName: "Irena", signatoryLastName: "Podpisová", signatoryCapacity: "jednatelka" } as const;
  for (const format of ["dphdp3", "dphkh1"] as const) {
    const input = { companyId: company.companyId, period: "2026-10", details: { preparedOn: "2026-10-27" } };
    const xml = await exportVatReport(company.client, { ...input, format });
    const pdf = format === "dphdp3" ? await exportVatReturnPdf(company.client, input) : await exportControlStatementPdf(company.client, input, undefined);
    if (!xml.ok || !pdf.ok) throw new Error("Artifacts refused");
    const original = (await readVatReportArtifact(company.client, { companyId: company.companyId, artifactId: xml.value.artifactId }))!;
    const common = { target_company_id: company.companyId, target_vat_report_id: report.id, target_report_generated_at: report.generatedAt, target_format: format, target_schema_version: format === "dphdp3" ? "03.01.04" : "03.01.15" };
    for (const version of ["3", "4"]) {
      const oldContext = { ...common, target_serializer_version: version, target_resolved_details: original.artifact.resolvedDetails as unknown as import("@/lib/database.types").Json };
      const oldXml = await company.client.rpc("create_draft_vat_report_artifact", { ...oldContext, target_file_name: xml.value.fileName, target_xml_base64: Buffer.from(xml.value.bytes).toString("base64") });
      const oldPdf = await company.client.rpc("create_vat_report_pdf_artifact", { ...oldContext, target_pdf_base64: Buffer.from(pdf.value.bytes).toString("base64") });
      expect(oldXml.error).toBeNull(); expect(oldPdf.error).toBeNull();
      const beforeXml = await readVatReportArtifact(company.client, { companyId: company.companyId, artifactId: oldXml.data! });
      const beforePdf = await readVatReportPdfArtifact(company.client, { companyId: company.companyId, artifactId: oldPdf.data! });
      retained.push({ id: oldXml.data!, fileName: xml.value.fileName, bytes: xml.value.bytes, media: "xml", before: beforeXml });
      retained.push({ id: oldPdf.data!, fileName: pdf.value.fileName, bytes: pdf.value.bytes, media: "pdf", before: beforePdf });
      const poContext = { ...oldContext, target_resolved_details: { ...original.artifact.resolvedDetails, representative: legal } as unknown as import("@/lib/database.types").Json };
      expect((await company.client.rpc("create_draft_vat_report_artifact", { ...poContext, target_file_name: xml.value.fileName, target_xml_base64: Buffer.from(xml.value.bytes).toString("base64") })).error?.hint).toBe("invalid_export_details");
      expect((await company.client.rpc("create_vat_report_pdf_artifact", { ...poContext, target_pdf_base64: Buffer.from(pdf.value.bytes).toString("base64") })).error?.hint).toBe("invalid_export_details");
      await saveCompanyFilingDefaults(company.client, { ...filing, companyId: company.companyId, representative: legal });
      expect(await readVatReportArtifact(company.client, { companyId: company.companyId, artifactId: oldXml.data! })).toEqual(beforeXml);
      expectSameArtifact(await readVatReportPdfArtifact(company.client, { companyId: company.companyId, artifactId: oldPdf.data! }), beforePdf);
      await saveCompanyFilingDefaults(company.client, { ...filing, companyId: company.companyId, representative });
    }
  }
  await saveCompanyFilingDefaults(company.client, { ...filing, companyId: company.companyId, representative: legal });
  const { finalizeVatReport, unlockReportingPeriod } = await import("@/application/vat-reports");
  const { exportFinalVatReport } = await import("@/application/epo-export");
  expect(await finalizeVatReport(company.client, { companyId: company.companyId, period: "2026-10", confirmed: true })).toEqual({ ok: true, value: null });
  for (const format of ["dphdp3", "dphkh1"] as const) {
    const final = await exportFinalVatReport(company.client, { companyId: company.companyId, period: "2026-10", format, details: { preparedOn: "2026-10-27" } });
    if (!final.ok) throw new Error(final.error);
    const stored = (await readVatReportArtifact(company.client, { companyId: company.companyId, artifactId: final.value.artifactId }))!;
    expect(stored.artifact).toMatchObject({ serializerVersion: "5", kind: "final", resolvedDetails: { representative: legal, signatoryFirstName: "Irena" } });
    retained.push({ id: final.value.artifactId, fileName: final.value.fileName, bytes: final.value.bytes, media: "xml", before: stored });
    for (const version of ["3", "4"]) expect((await company.client.rpc("create_final_vat_report_artifact", {
      target_company_id: company.companyId, target_vat_report_id: stored.artifact.vatReportId,
      target_report_generated_at: stored.artifact.reportGeneratedAt, target_format: format,
      target_file_name: final.value.fileName, target_xml_base64: Buffer.from(final.value.bytes).toString("base64"),
      target_resolved_details: stored.artifact.resolvedDetails as unknown as import("@/lib/database.types").Json,
      target_schema_version: stored.artifact.schemaVersion, target_serializer_version: version,
    })).error?.hint).toBe("invalid_export_details");
  }
  expect(await unlockReportingPeriod(company.client, { companyId: company.companyId, period: "2026-10", confirmed: true, reason: "Synthetic immutable representative artifact check" })).toEqual({ ok: true, value: null });
  const { exportCompanyData } = await import("@/application/company-deletion");
  const { testWorker } = await import("./support/worker");
  const { unzipSync, strFromU8 } = await import("fflate");
  const worker = testWorker();
  const download = await exportCompanyData(company.client, worker.jobs, { companyId: company.companyId });
  if (!download.ok) throw new Error(download.error);
  const archive = unzipSync(download.value.bytes);
  expect(JSON.parse(strFromU8(archive["company.json"])).filingDefaults.representative).toEqual(legal);
  for (const retainedArtifact of retained) {
    const directory = retainedArtifact.media === "xml" ? "vat-report-artifacts" : "vat-report-pdf-artifacts";
    const archivedBytes = archive[`${directory}/${retainedArtifact.id}/${retainedArtifact.fileName}`];
    expect(archivedBytes && Buffer.compare(archivedBytes, retainedArtifact.bytes)).toBe(0);
    const read = { companyId: company.companyId, artifactId: retainedArtifact.id };
    expectSameArtifact(retainedArtifact.media === "xml" ? await readVatReportArtifact(company.client, read) : await readVatReportPdfArtifact(company.client, read), retainedArtifact.before);
  }
  expect(await worker.runJobs()).toEqual([]);
});


it.each(["natural", "legal"] as const)("exports both legal representative kinds for a %s taxpayer with default, override and off", async taxpayer => {
  const company = await administratorWithCompany();
  const { updateCompanyIdentity } = await import("@/application/companies");
  const { companyDetails } = await import("./support/fixtures");
  if (taxpayer === "natural") await updateCompanyIdentity(company.client, { companyId: company.companyId, ...companyDetails({ personType: "natural", firstName: "Karel", lastName: "Daňový", name: "Karel Daňový" }) });
  const general = { code: "4a", personType: "P", name: "Atlas Poradenství s.r.o.", ico: "00123456", signatoryFirstName: "Irena", signatoryLastName: "Podpisová", signatoryCapacity: "jednatelka" } as const;
  expect(await saveCompanyFilingDefaults(company.client, { ...filing, companyId: company.companyId, representative: general })).toEqual({ ok: true, value: null });
  await generateVatReport(company.client, { companyId: company.companyId, period: "2026-10" });
  const { getVatReport } = await import("@/application/vat-reports");
  const before = await getVatReport(company.client, company.companyId, "2026-10");
  const user = await companyMember(company);
  for (const format of ["dphdp3", "dphkh1"] as const) {
    const input = { companyId: company.companyId, period: "2026-10", details: { preparedOn: "2026-10-27" } };
    const defaultXml = await exportVatReport(user.client, { ...input, format });
    if (!defaultXml.ok) throw new Error(defaultXml.error);
    expect(defaultXml.value.xml).toContain('zast_kod="4a"');
    const saved = await readVatReportArtifact(user.client, { companyId: company.companyId, artifactId: defaultXml.value.artifactId });
    const details = { ...input.details, representativeMode: "override", representativeCode: "4c", representativePersonType: "P", representativeName: "Beta Poradenství s.r.o.", representativeIco: "0123456789", representativeSignatoryFirstName: "Eva", representativeSignatoryLastName: "Poradná", representativeSignatoryCapacity: "zmocněná osoba", representativeFirstName: "stale FO", representativeLastName: "hidden", representativeBirthDate: "1981-02-03", representativeEvidenceNumber: "stale evidence", signatoryFirstName: "Company stale" };
    const override = await exportVatReport(user.client, { ...input, format, details });
    if (!override.ok) throw new Error(override.error);
    for (const attribute of ['zast_kod="4c"', 'zast_typ="P"', 'zast_nazev="Beta Poradenství s.r.o."', 'zast_ic="0123456789"', 'opr_jmeno="Eva"', 'opr_prijmeni="Poradná"', 'opr_postaveni="zmocněná osoba"']) expect(override.value.xml).toContain(attribute);
    expect(override.value.xml).not.toMatch(/zast_(?:jmeno|prijmeni|dat_nar|ev_cislo)=|stale|hidden/);
    expect(override.value.xml).toContain(taxpayer === "natural" ? 'typ_ds="F"' : 'typ_ds="P"');
    const pdf = format === "dphdp3" ? await exportVatReturnPdf(user.client, { ...input, details }) : await exportControlStatementPdf(user.client, { ...input, details }, undefined);
    if (!pdf.ok) throw new Error(pdf.error);
    expect(await pdfField(pdf.value.bytes, format === "dphdp3" ? [191.6, 576.1, 219.4, 592.6] : [191.6, 598.4, 219.4, 614.9])).toBe("4c");
    expect(await pdfField(pdf.value.bytes, format === "dphdp3" ? [49.9, 605.8, 559.6, 622.3] : [49.9, 628.1, 559.6, 644.6])).toBe("Beta Poradenství s.r.o.");
    expect(await pdfField(pdf.value.bytes, format === "dphdp3" ? [49.9, 634.2, 559.6, 650.7] : [49.9, 656.5, 559.6, 673])).toBe("0123456789");
    expect(await pdfField(pdf.value.bytes, format === "dphdp3" ? [49.9, 683.1, 559.6, 699.6] : [49.9, 705.4, 559.6, 721.9])).toBe("Eva Poradná zmocněná osoba");
    const pdfRead = { companyId: company.companyId, artifactId: pdf.value.artifactId! };
    const pdfBefore = await readVatReportPdfArtifact(user.client, pdfRead);
    const off = await exportVatReport(user.client, { ...input, format, details: { ...details, representativeMode: "off", signatoryFirstName: "Jana" } });
    if (!off.ok) throw new Error(off.error);
    expect(off.value.xml).not.toContain("zast_");
    if (taxpayer === "natural") expect(off.value.xml).not.toContain("opr_");
    else expect(off.value.xml).toContain('opr_jmeno="Jana"');
    const again = await exportVatReport(user.client, { ...input, format });
    if (!again.ok) throw new Error(again.error);
    expect(again.value.xml).toContain('zast_kod="4a"');
    expect((await getCompanyFilingDefaults(company.client, company.companyId))?.representative).toEqual(general);
    expect(await readVatReportArtifact(user.client, { companyId: company.companyId, artifactId: defaultXml.value.artifactId })).toEqual(saved);
    expect(await readVatReportPdfArtifact(user.client, pdfRead)).toEqual(pdfBefore);
    // A legal -> natural switch strips every incompatible PO/signatory field.
    const natural = await exportVatReport(user.client, { ...input, format, details: { ...details, representativeCode: "4b", representativePersonType: "F", representativeFirstName: "Eva", representativeLastName: "Poradná", representativeEvidenceNumber: "SYN-123", signatoryFirstName: "Jana" } });
    if (!natural.ok) throw new Error(natural.error);
    expect(natural.value.xml).toContain('zast_kod="4b"');
    expect(natural.value.xml).not.toMatch(/zast_(?:nazev|ic)=/);
    if (taxpayer === "natural") expect(natural.value.xml).not.toContain("opr_");
  }
  expect(await getVatReport(company.client, company.companyId, "2026-10")).toEqual(before);
});

it("requires complete legal defaults/XML but retains incomplete PDF review without borrowing a Company signatory", async () => {
  const company = await administratorWithCompany();
  const legal = { code: "4c", personType: "P", name: "Atlas Poradenství s.r.o.", ico: "00123456", signatoryFirstName: "Irena", signatoryLastName: "Podpisová", signatoryCapacity: "jednatelka" } as const;
  await saveCompanyFilingDefaults(company.client, { ...filing, companyId: company.companyId });
  await generateVatReport(company.client, { companyId: company.companyId, period: "2026-10" });
  const legalFields = (profile: { code: string; personType: string; name: string; ico: string; signatoryFirstName: string; signatoryLastName: string; signatoryCapacity: string }) => ({
    representativeMode: "override", representativeCode: profile.code, representativePersonType: profile.personType,
    representativeName: profile.name, representativeIco: profile.ico, representativeSignatoryFirstName: profile.signatoryFirstName,
    representativeSignatoryLastName: profile.signatoryLastName, representativeSignatoryCapacity: profile.signatoryCapacity,
  });
  const input = { companyId: company.companyId, period: "2026-10" };
  for (const key of ["name", "ico", "signatoryFirstName", "signatoryLastName", "signatoryCapacity"]) {
    const incomplete = { ...legal, [key]: "" };
    expect(await saveCompanyFilingDefaults(company.client, { ...filing, companyId: company.companyId, representative: incomplete })).toEqual({ ok: false, error: "invalid_representative" });
    for (const format of ["dphdp3", "dphkh1"] as const) {
      const details = legalFields(incomplete);
      expect(await exportVatReport(company.client, { ...input, format, details })).toEqual({ ok: false, error: "invalid_representative" });
      const preview = format === "dphdp3" ? await exportVatReturnPdf(company.client, { ...input, details }) : await exportControlStatementPdf(company.client, { ...input, details }, undefined);
      if (!preview.ok) throw new Error(preview.error);
      const archived = await readVatReportPdfArtifact(company.client, { companyId: company.companyId, artifactId: preview.value.artifactId! });
      expect(archived?.artifact.resolvedDetails.representative).toEqual(incomplete);
      expect(await pdfText(preview.value.bytes)).not.toContain("Jana");
    }
  }
  for (const patch of [{ name: "X".repeat(256) }, { ico: "12345678901" }, { ico: "12A" }, { ico: "-1" }, { ico: "1.0" }, { ico: 123 }, { name: false }, { signatoryFirstName: null }, { signatoryLastName: [] }, { signatoryCapacity: 1 }, { signatoryFirstName: "X".repeat(21) }, { signatoryLastName: "X".repeat(37) }, { signatoryCapacity: "X".repeat(41) }, { code: "4b" }, { code: "1" }, { personType: "F" }]) {
    expect(await saveCompanyFilingDefaults(company.client, { ...filing, companyId: company.companyId, representative: { ...legal, ...patch } as never })).toEqual({ ok: false, error: "invalid_representative" });
  }
  for (const patch of [{ representativeName: "X".repeat(256) }, { representativeIco: "12345678901" }, { representativeIco: "12A" }, { representativeIco: 123 }, { representativeSignatoryFirstName: "X".repeat(21) }, { representativeSignatoryLastName: "X".repeat(37) }, { representativeSignatoryCapacity: "X".repeat(41) }, { representativeCode: "4b" }, { representativeCode: "1" }, { representativePersonType: "F" }]) {
    for (const format of ["dphdp3", "dphkh1"] as const) {
      const details = { ...legalFields(legal), ...patch } as unknown as Record<string, string>;
      expect(await exportVatReport(company.client, { ...input, format, details })).toEqual({ ok: false, error: "invalid_representative" });
      expect(format === "dphdp3" ? await exportVatReturnPdf(company.client, { ...input, details }) : await exportControlStatementPdf(company.client, { ...input, details }, undefined)).toEqual({ ok: false, error: "invalid_representative" });
    }
  }
  // Official identification limits permit 1–10 decimal digits, including zeros;
  // roles can be occupied by the same person without a made-up inequality rule.
  for (const ico of ["0", "0123456789"]) {
    const boundary = { ...legal, name: "X".repeat(255), ico, signatoryFirstName: "I".repeat(20), signatoryLastName: "P".repeat(36), signatoryCapacity: "J".repeat(40) };
    expect(await saveCompanyFilingDefaults(company.client, { ...filing, companyId: company.companyId, representative: boundary })).toEqual({ ok: true, value: null });
    for (const format of ["dphdp3", "dphkh1"] as const) expect((await exportVatReport(company.client, { ...input, format, details: {} })).ok).toBe(true);
  }
});


it("enforces legal profile completeness and authority at direct RPC without personal audit data", async () => {
  const company = await administratorWithCompany();
  const user = await companyMember(company);
  const { provisionedUser } = await import("./support/clients");
  const outsider = await provisionedUser();
  const legal = { code: "4a", personType: "P", name: "Atlas Poradenství s.r.o.", ico: "00123456", signatoryFirstName: "Irena", signatoryLastName: "Podpisová", signatoryCapacity: "jednatelka" } as const;
  const rpc = { target_company_id: company.companyId, new_tax_office: "451", new_territorial_office: "2003", new_economic_activity: "621000", new_signatory_first_name: "Jana", new_signatory_last_name: "Stará", new_signatory_capacity: "jednatelka", new_email: "", new_phone: "", new_epo_street_name: "", new_epo_house_number: "", new_epo_orientation_number: "", new_epo_city: "", new_epo_postal_code: "", epo_address_confirmed: false, new_representative: legal };
  expect((await company.client.rpc("set_company_filing_defaults", rpc)).error).toBeNull();
  for (const actor of [user.client, outsider.client]) {
    expect((await actor.rpc("set_company_filing_defaults", rpc)).error?.code).toBe("42501");
    expect(await saveCompanyFilingDefaults(actor, { ...filing, companyId: company.companyId, representative: legal })).toEqual({ ok: false, error: "forbidden" });
  }
  expect(await getCompanyFilingDefaults(outsider.client, company.companyId)).toBeNull();
  for (const patch of [{ code: "4b" }, { personType: "F" }, { code: "1" }, { name: "" }, { ico: "" }, { signatoryFirstName: "" }, { signatoryLastName: "" }, { signatoryCapacity: "" }, { name: "X".repeat(256) }, { ico: "12345678901" }, { ico: "12A" }, { ico: 123 }, { signatoryFirstName: null }, { signatoryLastName: [] }, { signatoryCapacity: true }, { signatoryFirstName: "X".repeat(21) }, { signatoryLastName: "X".repeat(37) }, { signatoryCapacity: "X".repeat(41) }]) {
    expect((await company.client.rpc("set_company_filing_defaults", { ...rpc, new_representative: { ...legal, ...patch } })).error?.hint).toBe("invalid_representative");
  }
  expect((await getCompanyFilingDefaults(company.client, company.companyId))?.representative).toEqual(legal);
  const { listAuditEvents } = await import("@/application/audit");
  expect(JSON.stringify(await listAuditEvents(company.client, company.organizationId))).not.toMatch(/Atlas|00123456|Irena|Podpisová|Stará|representative/);
});


it("rechecks current MFA and revoked Membership before exposing legal defaults or historical artifacts", async () => {
  const company = await administratorWithCompany();
  const legal = { code: "4c", personType: "P", name: "Atlas Poradenství s.r.o.", ico: "00123456", signatoryFirstName: "Irena", signatoryLastName: "Podpisová", signatoryCapacity: "jednatelka" } as const;
  await saveCompanyFilingDefaults(company.client, { ...filing, companyId: company.companyId, representative: legal });
  await generateVatReport(company.client, { companyId: company.companyId, period: "2026-10" });
  const user = await companyMember(company);
  const input = { companyId: company.companyId, period: "2026-10", format: "dphdp3", details: { preparedOn: "2026-10-27" } };
  const xml = await exportVatReport(user.client, input);
  const pdf = await exportVatReturnPdf(user.client, input);
  if (!xml.ok || !pdf.ok) throw new Error("Fixture artifacts refused");
  const { beginTotpEnrollment, completeTotpEnrollment, verifyTotp } = await import("@/application/mfa");
  const { logIn, logOut } = await import("@/application/auth");
  const { totp } = await import("./support/totp");
  const enrolled = await beginTotpEnrollment(user.client);
  if (!enrolled.ok) throw new Error(enrolled.error);
  expect((await completeTotpEnrollment(user.client, { factorId: enrolled.value.factorId, code: totp(enrolled.value.secret) })).ok).toBe(true);
  await logOut(user.client);
  expect((await logIn(user.client, { email: user.email, password: "correct-horse-battery" })).ok).toBe(true);
  const xmlRead = { companyId: company.companyId, artifactId: xml.value.artifactId };
  const pdfRead = { companyId: company.companyId, artifactId: pdf.value.artifactId! };
  for (const condition of ["mfa", "revoked"] as const) {
    expect(await getCompanyFilingDefaults(user.client, company.companyId)).toBeNull();
    expect(await exportVatReport(user.client, input)).toEqual({ ok: false, error: "report_not_found" });
    expect(await exportVatReturnPdf(user.client, input)).toEqual({ ok: false, error: "report_not_found" });
    expect(await readVatReportArtifact(user.client, xmlRead)).toBeNull();
    expect(await readVatReportPdfArtifact(user.client, pdfRead)).toBeNull();
    if (condition === "mfa") {
      expect((await verifyTotp(user.client, { factorId: enrolled.value.factorId, code: totp(enrolled.value.secret) })).ok).toBe(true);
      expect((await getCompanyFilingDefaults(user.client, company.companyId))?.representative).toEqual(legal);
      expect((await exportVatReport(user.client, input)).ok).toBe(true);
      const { listMemberships, removeMembership } = await import("@/application/memberships");
      const memberships = await listMemberships(company.client, { organizationId: company.organizationId, companyId: company.companyId });
      const membership = memberships.find(item => item.userId === user.userId)!;
      expect(await removeMembership(company.client, membership.id)).toEqual({ ok: true, value: null });
    }
  }
});
