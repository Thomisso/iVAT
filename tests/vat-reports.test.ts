import { expect, it } from "vitest";
import { generateVatReport, getVatReport } from "@/application/vat-reports";
import { approveDocument, listDocuments } from "@/application/documents";
import { enableAiProcessing } from "@/application/companies";
import { listAuditEvents } from "@/application/audit";
import { uploadSourceFile } from "@/application/source-files";
import { administratorWithCompany, companyMember } from "./support/fixtures";
import { signedUpUser } from "./support/clients";
import { fixtureFile } from "./support/files";
import { testWorker } from "./support/worker";

async function companyWithReportDocuments() {
  const admin = await administratorWithCompany();
  const worker = testWorker();
  await enableAiProcessing(admin.client, worker.jobs, {
    companyId: admin.companyId,
    provider: worker.ai,
  });
  const file = await uploadSourceFile(admin.client, worker.jobs, {
    companyId: admin.companyId,
    fileName: "two-invoices.pdf",
    bytes: fixtureFile("two-invoices.pdf"),
  });
  if (!file.ok) throw new Error(file.error);
  expect(await worker.runJobs()).toEqual([]);
  const documents = await listDocuments(
    admin.client,
    admin.companyId,
    file.value.id,
  );
  await approveDocument(admin.client, {
    companyId: admin.companyId,
    documentId: documents[0].id,
    version: 1,
  });
  return { ...admin, documents };
}
it("a Company User generates a stored draft, with exclusions, source versions and an audit event, and regenerates it", async () => {
  const company = await companyWithReportDocuments();
  const member = await companyMember(company);
  const input = { companyId: company.companyId, period: "2026-10" };
  const result = await generateVatReport(member.client, input);
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.error);
  const report = await getVatReport(
    member.client,
    input.companyId,
    input.period,
  );
  expect(report).toEqual(
    expect.objectContaining({ id: result.value.id, period: "2026-10" }),
  );
  expect(report!.result.vatReturn.find((entry) => entry.line === "40")).toEqual(
    {
      line: "40",
      netAmount: "1000.00",
      vatAmount: "210.00",
      documentIds: [company.documents[0].id],
    },
  );
  expect(report!.documents).toHaveLength(2);
  expect(report!.documents[0].extractionVersionId).toEqual(expect.any(String));
  expect(report!.result.excludedDocuments).toEqual([
    { documentId: company.documents[1].id, reason: "not_approved" },
  ]);
  await approveDocument(company.client, {
    companyId: company.companyId,
    documentId: company.documents[1].id,
    version: 1,
  });
  expect(
    (await getVatReport(member.client, input.companyId, input.period))!.result
      .totals.inputVat,
  ).toBe("210.00");
  expect(await generateVatReport(member.client, input)).toEqual({
    ok: true,
    value: { id: result.value.id },
  });
  expect(
    (await getVatReport(member.client, input.companyId, input.period))!.result
      .totals.inputVat,
  ).toBe("420.00");
  const events = await listAuditEvents(company.client, company.organizationId);
  expect(
    events.filter((e) => e.action === "vat_report.generated"),
  ).toHaveLength(2);
});
it("isolates stored reports and generation from another Organization, including direct database access", async () => {
  const a = await companyWithReportDocuments();
  const b = await signedUpUser();
  const input = { companyId: a.companyId, period: "2026-10" };
  const result = await generateVatReport(a.client, input);
  expect(result.ok).toBe(true);
  expect(
    await getVatReport(b.client, input.companyId, input.period),
  ).toBeNull();
  expect(await generateVatReport(b.client, input)).toEqual({
    ok: false,
    error: "forbidden",
  });
  expect(
    (
      await b.client
        .from("vat_report")
        .select("id")
        .eq("company_id", a.companyId)
    ).data,
  ).toEqual([]);
  expect(
    (
      await b.client
        .from("vat_report_document")
        .select("id")
        .eq("company_id", a.companyId)
    ).data,
  ).toEqual([]);
  const direct = await b.client.rpc("save_vat_report", {
    target_company_id: a.companyId,
    target_period: "2026-10",
    expected_documents: [],
    computed_result: {},
  });
  expect(direct.error?.code).toBe("42501");
});
it("refuses invalid months without changing a report", async () => {
  const a = await administratorWithCompany();
  expect(
    await generateVatReport(a.client, {
      companyId: a.companyId,
      period: "2026-13",
    }),
  ).toEqual({ ok: false, error: "invalid_reporting_period" });
});
it("refuses a stale source snapshot and direct writes to a stored report", async () => {
  const a = await companyWithReportDocuments();
  await generateVatReport(a.client, {
    companyId: a.companyId,
    period: "2026-10",
  });
  const report = (await getVatReport(a.client, a.companyId, "2026-10"))!;
  await approveDocument(a.client, {
    companyId: a.companyId,
    documentId: a.documents[1].id,
    version: 1,
  });
  const stale = await a.client.rpc("save_vat_report", {
    target_company_id: a.companyId,
    target_period: "2026-10",
    expected_documents:
      report.documents as unknown as import("@/lib/database.types").Json,
    computed_result:
      report.result as unknown as import("@/lib/database.types").Json,
  });
  expect(stale.error?.hint).toBe("stale_report");
  const update = await a.client
    .from("vat_report")
    .update({ result: {} })
    .eq("id", report.id);
  expect(update.error?.code).toBe("42501");
  expect(
    (await getVatReport(a.client, a.companyId, "2026-10"))!.result.totals
      .inputVat,
  ).toBe("210.00");
});
