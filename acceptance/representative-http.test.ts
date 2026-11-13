import { expect, it } from "vitest";
import { strFromU8, unzipSync } from "fflate";
import { getCompanyFilingDefaults } from "@/application/company-filing-defaults";
import { getCompanyDataExportStatus, softDeleteCompany } from "@/application/company-deletion";
import { generateVatReport } from "@/application/vat-reports";
import { readVatReportArtifact } from "@/application/epo-export";
import { readVatReportPdfArtifact } from "@/application/vat-report-pdf-artifacts";
import { administratorWithCompany, companyMember } from "../tests/support/fixtures";
import { provisionedUser } from "../tests/support/clients";
import { baseUrl, httpAs, value } from "./support/http";

it("saves a profile through the real settings action and serves matching XML/PDF artifacts with explicit-off and refusal routes", async () => {
  const company = await administratorWithCompany("Representative HTTP synthetic organization");
  const adminRequest = await httpAs(company.client);
  const settingsPath = `/companies/${company.companyId}/settings/vat`;
  const settings = await adminRequest(settingsPath);
  expect(settings.status).toBe(200);
  const settingsHtml = await settings.text();
  expect(settingsHtml).toContain("4b — tax adviser or lawyer, natural person");
  const form = filingForm(settingsHtml);
  for (const [name, entry] of Object.entries({ taxOffice: "451", territorialOffice: "2003", economicActivity: "621000", signatoryFirstName: "Jana", signatoryLastName: "Podpisová", signatoryCapacity: "jednatelka", email: "", phone: "", representativeMode: "override", representativeCode: "4b", representativePersonType: "F", representativeFirstName: "Alena", representativeLastName: "Zástupná", representativeBirthDate: "1981-02-03", representativeEvidenceNumber: "" })) form.set(name, entry);
  const saved = await adminRequest(settingsPath, { method: "POST", headers: { Origin: baseUrl() }, body: form });
  expect(saved.status).toBe(200);
  expect((await getCompanyFilingDefaults(company.client, company.companyId))?.representative).toMatchObject({ code: "4b", firstName: "Alena" });
  const savedHtml = await (await adminRequest(settingsPath)).text();
  expect(savedHtml.includes('value="4b" selected=""')).toBe(true);
  expect(savedHtml.includes('name="representativeCode" value="4b"')).toBe(true);
  const refusedForm = filingForm(savedHtml);
  for (const [key, entry] of form.entries()) if (!key.startsWith("$ACTION")) refusedForm.set(key, entry);
  refusedForm.set("representativeFirstName", "Name exceeding twenty characters");
  const refusedSave = await adminRequest(settingsPath, { method: "POST", headers: { Origin: baseUrl() }, body: refusedForm });
  expect(refusedSave.status).toBe(200);
  const refusedHtml = await refusedSave.text();
  expect(refusedHtml).toContain("Select a supported representative");
  expect(refusedHtml).toContain('value="Name exceeding twenty characters"');
  expect((await getCompanyFilingDefaults(company.client, company.companyId))?.representative).toMatchObject({ firstName: "Alena" });
  value(await generateVatReport(company.client, { companyId: company.companyId, period: "2026-10" }));
  const user = await companyMember(company);
  const request = await httpAs(user.client);
  const prefix = `/companies/${company.companyId}/vat-reports/2026-10`;
  const outsiderRequest = await httpAs((await provisionedUser()).client);
  const retained: { id: string; fileName: string; bytes: Uint8Array; mediaType: "xml" | "pdf" }[] = [];
  for (const format of ["dphdp3", "dphkh1"] as const) {
    const xml = await request(`${prefix}/xml`, { method: "POST", body: new URLSearchParams({ format, preparedOn: "2026-10-27" }) });
    expect(xml.status).toBe(200);
    const xmlText = await xml.text();
    retained.push({ id: xml.headers.get("x-ivat-artifact-id")!, fileName: `DRAFT_${format.toUpperCase()}_2026-10.xml`, bytes: new TextEncoder().encode(xmlText), mediaType: "xml" });
    expect(xmlText).toContain('zast_kod="4b"');
    expect(xmlText).toContain('zast_jmeno="Alena"');
    expect(xmlText).toContain('zast_dat_nar="03.02.1981"');
    expect((await readVatReportArtifact(user.client, { companyId: company.companyId, artifactId: xml.headers.get("x-ivat-artifact-id")! }))?.artifact.resolvedDetails.representative).toMatchObject({ firstName: "Alena" });
    const pdfPath = format === "dphdp3" ? `${prefix}/pdf` : `${prefix}/control-statement/pdf`;
    const pdf = await request(pdfPath, { method: "POST", body: new URLSearchParams({ preparedOn: "2026-10-27" }) });
    expect(pdf.status).toBe(200);
    expect(pdf.headers.get("content-type")).toBe("application/pdf");
    expect(pdf.headers.get("cache-control")).toBe("private, no-store");
    const artifactId = pdf.headers.get("x-ivat-artifact-id")!;
    const pdfBytes = new Uint8Array(await pdf.arrayBuffer());
    retained.push({ id: artifactId, fileName: `${format.toUpperCase()}-2026-10.pdf`, bytes: pdfBytes, mediaType: "pdf" });
    const stored = await readVatReportPdfArtifact(user.client, { companyId: company.companyId, artifactId });
    expect(stored?.bytes).toEqual(pdfBytes);
    expect(stored?.artifact.resolvedDetails.representative).toMatchObject({ firstName: "Alena" });
    const archivePath = `${prefix}/artifacts/${artifactId}`;
    const historical = await request(archivePath);
    expect(historical.status).toBe(200);
    expect(historical.headers.get("content-type")).toBe("application/pdf");
    expect(new Uint8Array(await historical.arrayBuffer())).toEqual(pdfBytes);
    expect((await outsiderRequest(archivePath)).status).toBe(404);
    expect((await outsiderRequest(`${prefix}/xml`, { method: "POST", body: new URLSearchParams({ format }) })).status).toBe(404);
    expect((await outsiderRequest(pdfPath)).status).toBe(404);
    const off = await request(`${prefix}/xml`, { method: "POST", body: new URLSearchParams({ format, representativeMode: "off" }) });
    expect(off.status).toBe(200);
    expect(await off.text()).not.toContain("zast_");
    const incomplete = new URLSearchParams({ format, representativeMode: "override", representativeCode: "4b", representativePersonType: "F", representativeFirstName: "Eva" });
    const incompleteXml = await request(`${prefix}/xml`, { method: "POST", body: incomplete });
    expect(incompleteXml.status).toBe(422);
    expect(await incompleteXml.json()).toMatchObject({ error: "invalid_representative" });
    const incompletePdf = await request(pdfPath, { method: "POST", body: incomplete });
    expect(incompletePdf.status).toBe(200);
    const incompleteArchive = await readVatReportPdfArtifact(user.client, { companyId: company.companyId, artifactId: incompletePdf.headers.get("x-ivat-artifact-id")! });
    expect(incompleteArchive?.artifact.resolvedDetails.representative).toEqual({ code: "4b", personType: "F", firstName: "Eva", lastName: "", birthDate: "", evidenceNumber: "" });
    const invalid = new URLSearchParams({ format, representativeMode: "override", representativeCode: "4b", representativePersonType: "P" });
    const refusedXml = await request(`${prefix}/xml`, { method: "POST", body: invalid });
    expect(refusedXml.status).toBe(422);
    expect(await refusedXml.json()).toMatchObject({ error: "invalid_representative" });
    const refusedPdf = await request(pdfPath, { method: "POST", body: invalid });
    expect(refusedPdf.status).toBe(422);
    expect(await refusedPdf.json()).toMatchObject({ error: "invalid_representative" });
  }
  const history = await request(`${prefix}/exports`);
  expect(history.status).toBe(200);
  const html = await history.text();
  expect(html.includes("Alena Zástupná · 03.02.1981")).toBe(true);
  expect(html).toContain("DPHDP3-2026-10.pdf");
  expect(html).toContain("DPHKH1-2026-10.pdf");
  const exported = await adminRequest(`/companies/${company.companyId}/export`, { method: "POST" });
  expect(exported.status).toBe(200);
  const archive = unzipSync(new Uint8Array(await exported.arrayBuffer()));
  expect(JSON.parse(strFromU8(archive["company.json"])).filingDefaults.representative).toMatchObject({ code: "4b", personType: "F", firstName: "Alena", lastName: "Zástupná", birthDate: "1981-02-03" });
  for (const artifact of retained) {
    const directory = artifact.mediaType === "pdf" ? "vat-report-pdf-artifacts" : "vat-report-artifacts";
    expect(archive[`${directory}/${artifact.id}/${artifact.fileName}`]).toEqual(artifact.bytes);
  }
  expect(JSON.parse(strFromU8(archive["vat-report-pdf-artifacts.json"]))).toEqual(expect.arrayContaining(
    retained.filter(artifact => artifact.mediaType === "pdf").map(artifact => expect.objectContaining({ id: artifact.id, resolvedDetails: expect.objectContaining({ representative: expect.objectContaining({ firstName: "Alena" }) }) })),
  ));
  const receipt = { companyId: company.companyId, exportId: exported.headers.get("X-Company-Export-Id")! };
  await expect.poll(async () => value(await getCompanyDataExportStatus(company.client, receipt)), { timeout: 30_000, interval: 200 }).toBe("completed");
  expect((await request(`${prefix}/pdf`, { method: "POST", body: new URLSearchParams({ preparedOn: "2026-10-27" }) })).status).toBe(200);
  expect(value(await getCompanyDataExportStatus(company.client, receipt))).toBe("stale");
  expect(await softDeleteCompany(company.client, receipt)).toEqual({ ok: false, error: "stale_export" });
});


it.each(["natural", "legal"] as const)("saves legal representation and its own signatory through settings for a %s taxpayer", async taxpayer => {
  const company = await administratorWithCompany("Legal representative HTTP organization");
  const { updateCompanyIdentity } = await import("@/application/companies");
  const { companyDetails } = await import("../tests/support/fixtures");
  if (taxpayer === "natural") value(await updateCompanyIdentity(company.client, { companyId: company.companyId, ...companyDetails({ personType: "natural", firstName: "Karel", lastName: "Daňový", name: "Karel Daňový" }) }));
  const admin = await httpAs(company.client);
  const settingsPath = `/companies/${company.companyId}/settings/vat`;
  let html = await (await admin(settingsPath)).text();
  expect(html).toContain("4a — general representative, legal person");
  expect(html).toContain("4c — tax advisory legal person");
  const legal = { representativeMode: "override", representativeCode: "4a", representativePersonType: "P", representativeName: "Atlas Poradenství s.r.o.", representativeIco: "00123456", representativeSignatoryFirstName: "Irena", representativeSignatoryLastName: "Podpisová", representativeSignatoryCapacity: "jednatelka" };
  const form = filingForm(html);
  for (const [key, entry] of Object.entries({ taxOffice: "451", territorialOffice: "2003", economicActivity: "621000", signatoryFirstName: "Jana", signatoryLastName: "Stará", signatoryCapacity: "jednatelka", ...legal })) form.set(key, entry);
  expect((await admin(settingsPath, { method: "POST", headers: { Origin: baseUrl() }, body: form })).status).toBe(200);
  expect((await getCompanyFilingDefaults(company.client, company.companyId))?.representative).toEqual({ code: "4a", personType: "P", name: "Atlas Poradenství s.r.o.", ico: "00123456", signatoryFirstName: "Irena", signatoryLastName: "Podpisová", signatoryCapacity: "jednatelka" });
  html = await (await admin(settingsPath)).text();
  expect(html).toContain('value="4a/P" selected=""');
  expect(html).toContain('name="representativeSignatoryFirstName"');
  const invalidForm = filingForm(html);
  invalidForm.set("representativeSignatoryFirstName", "");
  const refused = await admin(settingsPath, { method: "POST", headers: { Origin: baseUrl() }, body: invalidForm });
  const refusedHtml = await refused.text();
  expect(refusedHtml).toContain('value="4a/P" selected=""');
  expect(refusedHtml).toContain('value="Atlas Poradenství s.r.o."');
  expect(refusedHtml).toContain("Select a supported representative");
  value(await generateVatReport(company.client, { companyId: company.companyId, period: "2026-10" }));
  const user = await companyMember(company);
  const request = await httpAs(user.client);
  const outsider = await httpAs((await provisionedUser()).client);
  const prefix = `/companies/${company.companyId}/vat-reports/2026-10`;
  for (const format of ["dphdp3", "dphkh1"] as const) {
    const pdfPath = format === "dphdp3" ? `${prefix}/pdf` : `${prefix}/control-statement/pdf`;
    for (const code of ["4a", "4c"]) {
      const fields = { ...legal, format, representativeCode: code };
      const xml = await request(`${prefix}/xml`, { method: "POST", body: new URLSearchParams(fields) });
      expect(xml.status).toBe(200);
      const xmlText = await xml.text();
      for (const attribute of [taxpayer === "natural" ? 'typ_ds="F"' : 'typ_ds="P"', `zast_kod="${code}"`, 'zast_typ="P"', 'zast_nazev="Atlas Poradenství s.r.o."', 'zast_ic="00123456"', 'opr_jmeno="Irena"', 'opr_prijmeni="Podpisová"', 'opr_postaveni="jednatelka"']) expect(xmlText).toContain(attribute);
      expect(xmlText).not.toMatch(/zast_(?:jmeno|prijmeni|dat_nar|ev_cislo)=/);
      const pdf = await request(pdfPath, { method: "POST", body: new URLSearchParams(fields) });
      expect(pdf.status).toBe(200);
      expect(pdf.headers.get("content-type")).toBe("application/pdf");
      const bytes = new Uint8Array(await pdf.arrayBuffer());
      const id = pdf.headers.get("x-ivat-artifact-id")!;
      const archive = await readVatReportPdfArtifact(user.client, { companyId: company.companyId, artifactId: id });
      expect(archive?.bytes).toEqual(bytes);
      expect(archive?.artifact).toMatchObject({ serializerVersion: "5", authorUserId: user.userId, resolvedDetails: { personType: taxpayer === "natural" ? "F" : "P", signatoryFirstName: "Irena", representative: { code, personType: "P", ico: "00123456" } } });
      expect((await outsider(`${prefix}/artifacts/${id}`)).status).toBe(404);
      for (const key of ["representativeName", "representativeIco", "representativeSignatoryFirstName", "representativeSignatoryLastName", "representativeSignatoryCapacity"]) {
        const incomplete = { ...fields, [key]: "" };
        const xml = await request(`${prefix}/xml`, { method: "POST", body: new URLSearchParams(incomplete) });
        expect(xml.status).toBe(422);
        expect(await xml.json()).toMatchObject({ error: "invalid_representative" });
        expect((await request(pdfPath, { method: "POST", body: new URLSearchParams(incomplete) })).status).toBe(200);
      }
      const invalid = { ...fields, representativeIco: "12A" };
      for (const route of [`${prefix}/xml`, pdfPath]) expect((await request(route, { method: "POST", body: new URLSearchParams(invalid) })).status).toBe(422);
      const off = await request(`${prefix}/xml`, { method: "POST", body: new URLSearchParams({ ...fields, representativeMode: "off" }) });
      expect(off.status).toBe(200);
      const offXml = await off.text();
      expect(offXml).not.toContain("zast_");
      if (taxpayer === "natural") expect(offXml).not.toContain("opr_");
      else expect(offXml).toContain('opr_jmeno="Jana"');
    }
    const fromDefault = await request(`${prefix}/xml`, { method: "POST", body: new URLSearchParams({ format }) });
    expect(await fromDefault.text()).toContain('zast_kod="4a"');
  }
  const history = await (await request(`${prefix}/exports`)).text();
  expect(history).toContain("Atlas Poradenství s.r.o.");
  expect(history).toContain("00123456");
  expect(history).toContain("Irena Podpisová");
});

function filingForm(html: string) {
  const form = html.match(/<form\b[^>]*>[\s\S]*?<\/form>/g)?.find(item => item.includes('name="representativeMode"'));
  expect(form).toBeDefined();
  const data = new FormData();
  const decode = (value: string) => value.replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
  for (const input of form!.matchAll(/<input\b[^>]*>/g)) {
    const name = input[0].match(/\bname="([^"]*)"/)?.[1];
    const entry = input[0].match(/\bvalue="([^"]*)"/)?.[1] ?? "";
    if (name) data.append(decode(name), decode(entry));
  }
  return data;
}
