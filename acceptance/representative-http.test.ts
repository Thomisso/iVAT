import { expect, it } from "vitest";
import { getCompanyFilingDefaults } from "@/application/company-filing-defaults";
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
  const form = filingForm(await settings.text());
  for (const [name, entry] of Object.entries({ taxOffice: "451", territorialOffice: "2003", economicActivity: "621000", signatoryFirstName: "Jana", signatoryLastName: "Podpisová", signatoryCapacity: "jednatelka", email: "", phone: "", representativeMode: "override", representativeCode: "4a", representativePersonType: "F", representativeFirstName: "Alena", representativeLastName: "Zástupná", representativeBirthDate: "1981-02-03", representativeEvidenceNumber: "" })) form.set(name, entry);
  const saved = await adminRequest(settingsPath, { method: "POST", headers: { Origin: baseUrl() }, body: form });
  expect(saved.status).toBe(200);
  expect((await getCompanyFilingDefaults(company.client, company.companyId))?.representative?.firstName).toBe("Alena");
  const refusedForm = filingForm(await (await adminRequest(settingsPath)).text());
  for (const [key, entry] of form.entries()) if (!key.startsWith("$ACTION")) refusedForm.set(key, entry);
  refusedForm.set("representativeFirstName", "Name exceeding twenty characters");
  const refusedSave = await adminRequest(settingsPath, { method: "POST", headers: { Origin: baseUrl() }, body: refusedForm });
  expect(refusedSave.status).toBe(200);
  const refusedHtml = await refusedSave.text();
  expect(refusedHtml).toContain("Select a supported representative");
  expect(refusedHtml).toContain('value="Name exceeding twenty characters"');
  expect((await getCompanyFilingDefaults(company.client, company.companyId))?.representative?.firstName).toBe("Alena");
  value(await generateVatReport(company.client, { companyId: company.companyId, period: "2026-10" }));
  const user = await companyMember(company);
  const request = await httpAs(user.client);
  const prefix = `/companies/${company.companyId}/vat-reports/2026-10`;
  const outsiderRequest = await httpAs((await provisionedUser()).client);
  for (const format of ["dphdp3", "dphkh1"] as const) {
    const xml = await request(`${prefix}/xml`, { method: "POST", body: new URLSearchParams({ format, preparedOn: "2026-10-27" }) });
    expect(xml.status).toBe(200);
    const xmlText = await xml.text();
    expect(xmlText).toContain('zast_jmeno="Alena"');
    expect(xmlText).toContain('zast_dat_nar="03.02.1981"');
    expect((await readVatReportArtifact(user.client, { companyId: company.companyId, artifactId: xml.headers.get("x-ivat-artifact-id")! }))?.artifact.resolvedDetails.representative?.firstName).toBe("Alena");
    const pdfPath = format === "dphdp3" ? `${prefix}/pdf` : `${prefix}/control-statement/pdf`;
    const pdf = await request(pdfPath, { method: "POST", body: new URLSearchParams({ preparedOn: "2026-10-27" }) });
    expect(pdf.status).toBe(200);
    expect(pdf.headers.get("content-type")).toBe("application/pdf");
    expect(pdf.headers.get("cache-control")).toBe("private, no-store");
    const artifactId = pdf.headers.get("x-ivat-artifact-id")!;
    const pdfBytes = new Uint8Array(await pdf.arrayBuffer());
    const stored = await readVatReportPdfArtifact(user.client, { companyId: company.companyId, artifactId });
    expect(stored?.bytes).toEqual(pdfBytes);
    expect(stored?.artifact.resolvedDetails.representative?.firstName).toBe("Alena");
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
    const invalid = new URLSearchParams({ format, representativeMode: "override", representativeCode: "4b", representativePersonType: "F" });
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
