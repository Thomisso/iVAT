import { createHash } from "node:crypto";
import { PDFDocument } from "pdf-lib";
import * as XLSX from "xlsx";
import { expect, it } from "vitest";
import { saveCompanyFilingDefaults } from "@/application/company-filing-defaults";
import { approveDocument, correctDocument, listCompanyDocuments } from "@/application/documents";
import { readVatReportArtifact } from "@/application/epo-export";
import { finalizeVatReport, generateVatReport, unlockReportingPeriod } from "@/application/vat-reports";
import { fakeVatPayerRegistry } from "@/vat-registry/fake";
import { provisionedUser } from "../tests/support/clients";
import { companyMember } from "../tests/support/fixtures";
import { baseUrl, httpAs, reviewedSource, value } from "./support/http";

it.each(["dphdp3", "dphkh1"] as const)("serves immutable %s draft/final HTTP artifacts, refuses stale intent and enforces tenant/period boundaries", async format => {
  const fixture = await reviewedSource();
  const period = "2026-10";
  const documents = await listCompanyDocuments(fixture.client, fixture.companyId);
  for (const [index, document] of documents.entries()) {
    value(await correctDocument(fixture.client, {
      companyId: fixture.companyId, documentId: document.id, basedOnVersion: 1,
      payload: { ...fixture.first.payload, documentNumber: `HTTP-${format}-${index}`,
        claimEligibility: { period, origin: "user", confirmed: true } },
    }, undefined, fakeVatPayerRegistry()));
    value(await approveDocument(fixture.client, { companyId: fixture.companyId, documentId: document.id, version: 2 }));
  }
  value(await saveCompanyFilingDefaults(fixture.client, {
    companyId: fixture.companyId, taxOffice: "451", territorialOffice: "2003", economicActivity: "621000",
    signatoryFirstName: "Jana", signatoryLastName: "Nováková", signatoryCapacity: "jednatelka",
    email: "http@example.test", phone: "+420123456789", epoAddressOverride: null,
  }));
  value(await generateVatReport(fixture.client, { companyId: fixture.companyId, period }));
  const member = await companyMember(fixture);
  const request = await httpAs(member.client);
  const prefix = `/companies/${fixture.companyId}/vat-reports/${period}`;
  if (format === "dphdp3") {
    const pdf = await request(`${prefix}/pdf`);
    expect(pdf.status).toBe(200);
    expect(pdf.headers.get("content-type")).toBe("application/pdf");
    expect(pdf.headers.get("x-content-type-options")).toBe("nosniff");
    expect((await PDFDocument.load(await pdf.arrayBuffer())).getPageCount()).toBeGreaterThan(0);
    const workbook = await request(`${prefix}/xlsx`);
    expect(workbook.status).toBe(200);
    expect(workbook.headers.get("content-type")).toContain("spreadsheetml.sheet");
    expect(workbook.headers.get("cache-control")).toBe("private, no-store");
    const sheets = XLSX.read(await workbook.arrayBuffer(), { type: "array" });
    expect(JSON.stringify(sheets.Sheets)).toContain("HTTP-dphdp3-0");
    expect(JSON.stringify(sheets.Sheets)).toContain("1210");
  }
  const post = (kind: string) => request(`${prefix}/xml`, { method: "POST", body: new URLSearchParams({ format, kind, preparedOn: "2026-10-29" }) });
  const draft = await post("draft");
  expect(draft.status).toBe(200);
  expect(draft.headers.get("content-type")).toBe("application/xml; charset=utf-8");
  expect(draft.headers.get("content-disposition")).toBe(`attachment; filename="DRAFT_${format.toUpperCase()}_${period}.xml"`);
  expect(draft.headers.get("cache-control")).toBe("private, no-store");
  expect(draft.headers.get("x-content-type-options")).toBe("nosniff");
  const draftId = draft.headers.get("x-ivat-artifact-id")!;
  expect(draftId).toMatch(/^[a-f0-9-]{36}$/);
  expect(draft.headers.get("x-ivat-report-generated-at")).toBeTruthy();
  const draftBytes = new Uint8Array(await draft.arrayBuffer());
  expect(new TextDecoder().decode(draftBytes)).toContain(format === "dphdp3" ? "<DPHDP3" : "<DPHKH1");
  const stored = await readVatReportArtifact(member.client, { companyId: fixture.companyId, artifactId: draftId });
  expect(stored?.bytes).toEqual(draftBytes);
  expect(stored?.artifact.kind).toBe("draft");
  const premature = await post("final");
  expect(premature.status).toBe(422);
  expect(await premature.json()).toMatchObject({ error: "report_not_finalized" });
  value(await finalizeVatReport(fixture.client, { companyId: fixture.companyId, period, confirmed: true }));
  const stale = await post("draft");
  expect(stale.status).toBe(422);
  const final = await post("final");
  expect(final.status).toBe(200);
  expect(final.headers.get("content-disposition")).toBe(`attachment; filename="${format.toUpperCase()}_${period}.xml"`);
  expect(final.headers.get("x-ivat-period-lock-id")).toMatch(/^[a-f0-9-]{36}$/);
  const finalId = final.headers.get("x-ivat-artifact-id")!;
  expect(finalId).not.toBe(draftId);
  const finalBytes = new Uint8Array(await final.arrayBuffer());
  value(await unlockReportingPeriod(fixture.client, { companyId: fixture.companyId, period, confirmed: true, reason: "HTTP artifact historical readback" }));
  for (const [id, bytes] of [[draftId, draftBytes], [finalId, finalBytes]] as const) {
    const path = `${prefix}/artifacts/${id}`;
    const archived = await request(path);
    expect(archived.status).toBe(200);
    expect(archived.headers.get("cache-control")).toBe("private, no-store");
    expect(archived.headers.get("x-content-type-options")).toBe("nosniff");
    expect(archived.headers.get("x-ivat-artifact-id")).toBe(id);
    expect(archived.headers.get("digest")).toBe(`sha-256=${createHash("sha256").update(bytes).digest("base64")}`);
    expect(new Uint8Array(await archived.arrayBuffer())).toEqual(bytes);
    expect((await request(path.replace(period, "2026-09"))).status).toBe(404);
    const stranger = await provisionedUser();
    expect((await (await httpAs(stranger.client))(path)).status).toBe(404);
    expect(await readVatReportArtifact(stranger.client, { companyId: fixture.companyId, artifactId: id })).toBeNull();
    const anonymous = await fetch(new URL(path, baseUrl()), { redirect: "manual" });
    expect(anonymous.status).toBe(307);
  }
});
