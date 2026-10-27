import { expect, it } from "vitest";
import { exportVatReport } from "@/application/epo-export";
import { generateVatReport } from "@/application/vat-reports";
import { approveDocument, listCompanyDocuments } from "@/application/documents";
import { createCompany } from "@/application/companies";
import { signedUpUser } from "./support/clients";
import {
  administratorWithCompany,
  companyMember,
  companyWithManyReportDocuments,
  companyDetails,
} from "./support/fixtures";

const details = {
  taxOffice: "451",
  personType: "P",
  preparedOn: "2026-10-27",
  email: "qa@example.test",
  signatoryFirstName: "Jana",
  signatoryLastName: "Nováková",
  signatoryCapacity: "jednatelka",
};
it("a Company User downloads a validated export of the saved draft, even after another approval", async () => {
  const a = await companyWithManyReportDocuments(2);
  const user = await companyMember(a);
  const input = {
    companyId: a.companyId,
    period: "2026-10",
    format: "dphdp3",
    details,
  };
  await generateVatReport(a.client, input);
  const [document] = await listCompanyDocuments(a.client, a.companyId);
  await approveDocument(a.client, {
    companyId: a.companyId,
    documentId: document.id,
    version: 1,
  });
  const saved = await exportVatReport(user.client, input);
  expect(saved.ok).toBe(true);
  if (!saved.ok) throw new Error(saved.error);
  expect(saved.value).toEqual(
    expect.objectContaining({
      fileName: "DPHDP3-2026-10.xml",
      mediaType: "application/xml; charset=utf-8",
    }),
  );
  expect(saved.value.xml).toContain('odp_tuz23_nar="0"');
  await generateVatReport(a.client, input);
  const regenerated = await exportVatReport(user.client, input);
  expect(regenerated.ok && regenerated.value.xml).toContain(
    'odp_tuz23_nar="210"',
  );
});
it.each(["dphdp3", "dphkh1"])(
  "another Organization cannot export %s",
  async (format) => {
    const a = await administratorWithCompany();
    const b = await signedUpUser();
    await generateVatReport(a.client, {
      companyId: a.companyId,
      period: "2026-10",
    });
    expect(
      await exportVatReport(b.client, {
        companyId: a.companyId,
        period: "2026-10",
        format,
        details,
      }),
    ).toEqual({ ok: false, error: "report_not_found" });
  },
);
it("refuses missing drafts and invalid export inputs without producing a download", async () => {
  const a = await administratorWithCompany();
  const input = {
    companyId: a.companyId,
    period: "2026-10",
    format: "dphdp3",
    details,
  };
  expect(await exportVatReport(a.client, input)).toEqual({
    ok: false,
    error: "report_not_found",
  });
  await generateVatReport(a.client, input);
  expect(
    await exportVatReport(a.client, { ...input, format: "../dphdp3" }),
  ).toEqual({ ok: false, error: "invalid_export_format" });
  expect(
    await exportVatReport(a.client, {
      ...input,
      details: { ...details, signatoryLastName: "" },
    }),
  ).toEqual({ ok: false, error: "invalid_export_details" });
});
it("uses the saved Company's person type for the XML header", async () => {
  const a = await signedUpUser();
  const company = await createCompany(a.client, {
    organizationId: a.organizationId,
    ...companyDetails({ personType: "natural" }),
  });
  if (!company.ok) throw new Error(company.error);
  const input = {
    companyId: company.value.id,
    period: "2026-10",
    format: "dphdp3",
    details: {
      ...details,
      personType: "P",
      firstName: "Jan",
      lastName: "Novák",
    },
  };
  await generateVatReport(a.client, input);

  const result = await exportVatReport(a.client, input);

  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.error);
  expect(result.value.xml).toContain('typ_ds="F"');
  expect(result.value.xml).toContain('jmeno="Jan" prijmeni="Novák"');
  expect(result.value.xml).not.toContain("zkrobchjm");
});
it.each(["dphdp3", "dphkh1"])(
  "blocks %s whose saved Company header fails the official schema",
  async (format) => {
    const a = await signedUpUser();
    const company = await createCompany(a.client, {
      organizationId: a.organizationId,
      ...companyDetails({ name: "x".repeat(256) }),
    });
    if (!company.ok) throw new Error(company.error);
    const input = {
      companyId: company.value.id,
      period: "2026-10",
      format,
      details,
    };
    await generateVatReport(a.client, input);
    expect(await exportVatReport(a.client, input)).toEqual({
      ok: false,
      error: "xml_invalid",
    });
  },
);
