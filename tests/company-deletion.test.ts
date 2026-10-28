import { strFromU8, unzipSync } from "fflate";
import { expect, it } from "vitest";
import { listAuditEvents } from "@/application/audit";
import {
  enableAiProcessing,
  getCompany,
  listMyCompanies,
} from "@/application/companies";
import {
  exportCompanyData,
  softDeleteCompany,
} from "@/application/company-deletion";
import { approveDocument, listDocuments } from "@/application/documents";
import { uploadSourceFile } from "@/application/source-files";
import {
  finalizeVatReport,
  generateVatReport,
} from "@/application/vat-reports";
import { administratorWithCompany, companyMember } from "./support/fixtures";
import { fixtureFile } from "./support/files";
import { systemClient, testWorker } from "./support/worker";

it("exports a Company's originals and Document data before retaining it as soft-deleted", async () => {
  const company = await administratorWithCompany();
  const member = await companyMember(company);
  const worker = testWorker();
  await enableAiProcessing(company.client, worker.jobs, {
    companyId: company.companyId,
    provider: worker.ai,
  });
  const original = fixtureFile("receipt.png");
  const uploaded = await uploadSourceFile(company.client, worker.jobs, {
    companyId: company.companyId,
    fileName: "receipt.png",
    bytes: original,
    preselectedDirection: "incoming",
  });
  if (!uploaded.ok) throw new Error(uploaded.error);
  expect(await worker.runJobs()).toEqual([]);
  const [document] = await listDocuments(
    company.client,
    company.companyId,
    uploaded.value.id,
  );

  const result = await exportCompanyData(company.client, {
    companyId: company.companyId,
  });

  expect(result).toEqual({
    ok: true,
    value: {
      bytes: expect.any(Uint8Array),
      exportId: expect.any(String),
      fileName: expect.stringMatching(/^iVAT-company-\d{8}-\d{4}-\d{2}-\d{2}\.zip$/),
      mediaType: "application/zip",
    },
  });
  if (!result.ok) return;
  const archive = unzipSync(result.value.bytes);
  expect(archive[`source-files/${uploaded.value.id}/receipt.png`]).toEqual(
    original,
  );
  expect(JSON.parse(strFromU8(archive["documents.json"]))).toEqual([
    expect.objectContaining({
      id: document.id,
      sourceFileId: uploaded.value.id,
      extractionVersions: [
        expect.objectContaining({ version: 1, payload: expect.any(Object) }),
      ],
    }),
  ]);
  expect(await getCompany(company.client, company.companyId)).not.toBeNull();
  expect(
    await softDeleteCompany(company.client, {
      companyId: company.companyId,
      exportId: result.value.exportId,
    }),
  ).toEqual({ ok: true, value: null });
  expect(await getCompany(company.client, company.companyId)).toBeNull();
  expect(await listMyCompanies(company.client)).toEqual([]);
  expect(await listMyCompanies(member.client)).toEqual([]);
  const hiddenDocuments = await member.client
    .from("document")
    .select("id")
    .eq("company_id", company.companyId);
  expect(hiddenDocuments.error).toBeNull();
  expect(hiddenDocuments.data).toEqual([]);

  const retainedCompany = await systemClient()
    .from("company")
    .select("deleted_at, deleted_by")
    .eq("id", company.companyId)
    .single();
  expect(retainedCompany.error).toBeNull();
  expect(retainedCompany.data).toEqual({
    deleted_at: expect.any(String),
    deleted_by: company.userId,
  });
  expect(
    await systemClient()
      .from("document")
      .select("id")
      .eq("id", document.id)
      .single(),
  ).toEqual(expect.objectContaining({ data: { id: document.id }, error: null }));
  const retainedOriginal = await systemClient()
    .storage.from("source-files")
    .download(`${company.companyId}/${uploaded.value.id}`);
  expect(retainedOriginal.error).toBeNull();
  expect(
    new Uint8Array(await retainedOriginal.data!.arrayBuffer()),
  ).toEqual(original);
  expect(
    (await listAuditEvents(company.client, company.organizationId)).at(-1),
  ).toEqual(
    expect.objectContaining({
      action: "company.deleted",
      actorUserId: company.userId,
      companyId: company.companyId,
      targetType: "company",
      targetId: company.companyId,
      payload: {
        document_count: 1,
        export_id: result.value.exportId,
        source_file_count: 1,
      },
    }),
  );
});

it("allows a Company Administrator, but refuses a User and another tenant", async () => {
  const company = await administratorWithCompany();
  const administrator = await companyMember(company, "administrator");
  const user = await companyMember(company, "user");
  const outsider = await administratorWithCompany("Another Organization");

  expect(
    await exportCompanyData(user.client, {
      companyId: company.companyId,
    }),
  ).toEqual({ ok: false, error: "forbidden" });
  expect(
    await exportCompanyData(outsider.client, {
      companyId: company.companyId,
    }),
  ).toEqual({ ok: false, error: "forbidden" });
  expect(await getCompany(company.client, company.companyId)).not.toBeNull();

  const exported = await exportCompanyData(administrator.client, {
    companyId: company.companyId,
  });
  expect(exported).toEqual({
    ok: true,
    value: expect.objectContaining({ mediaType: "application/zip" }),
  });
  if (!exported.ok) return;
  expect(
    await softDeleteCompany(user.client, {
      companyId: company.companyId,
      exportId: exported.value.exportId,
    }),
  ).toEqual({ ok: false, error: "forbidden" });
  expect(
    await softDeleteCompany(outsider.client, {
      companyId: company.companyId,
      exportId: exported.value.exportId,
    }),
  ).toEqual({ ok: false, error: "forbidden" });
  expect(
    await softDeleteCompany(administrator.client, {
      companyId: company.companyId,
      exportId: exported.value.exportId,
    }),
  ).toEqual({ ok: true, value: null });
  expect(await getCompany(user.client, company.companyId)).toBeNull();
});

it("refuses a soft delete without the Administrator's completed export", async () => {
  const company = await administratorWithCompany();

  expect(
    await softDeleteCompany(company.client, {
      companyId: company.companyId,
      exportId: "00000000-0000-4000-8000-000000000000",
    }),
  ).toEqual({ ok: false, error: "export_required" });
  expect(await getCompany(company.client, company.companyId)).not.toBeNull();
});

it("keeps a Company active when any Source File cannot be exported", async () => {
  const company = await administratorWithCompany();
  const uploaded = await uploadSourceFile(
    company.client,
    { async send() {} },
    {
      companyId: company.companyId,
      fileName: "receipt.png",
      bytes: fixtureFile("receipt.png"),
    },
  );
  if (!uploaded.ok) throw new Error(uploaded.error);
  const objectPath = `${company.companyId}/${uploaded.value.id}`;
  expect(
    (await systemClient().storage.from("source-files").remove([objectPath]))
      .error,
  ).toBeNull();

  expect(
    await exportCompanyData(company.client, {
      companyId: company.companyId,
    }),
  ).toEqual({ ok: false, error: "export_failed" });
  expect(await getCompany(company.client, company.companyId)).not.toBeNull();
  expect(
    await systemClient()
      .from("company")
      .select("deleted_at")
      .eq("id", company.companyId)
      .single(),
  ).toEqual(
    expect.objectContaining({ data: { deleted_at: null }, error: null }),
  );
});

it("retains an Approved Document and its Period Lock after the Company is soft-deleted", async () => {
  const company = await administratorWithCompany();
  const worker = testWorker();
  await enableAiProcessing(company.client, worker.jobs, {
    companyId: company.companyId,
    provider: worker.ai,
  });
  const uploaded = await uploadSourceFile(company.client, worker.jobs, {
    companyId: company.companyId,
    fileName: "receipt.png",
    bytes: fixtureFile("receipt.png"),
    preselectedDirection: "incoming",
  });
  if (!uploaded.ok) throw new Error(uploaded.error);
  expect(await worker.runJobs()).toEqual([]);
  const [document] = await listDocuments(
    company.client,
    company.companyId,
    uploaded.value.id,
  );
  expect(
    await approveDocument(company.client, {
      companyId: company.companyId,
      documentId: document.id,
      version: 1,
    }),
  ).toEqual({ ok: true, value: null });
  const report = { companyId: company.companyId, period: "2026-10" };
  expect((await generateVatReport(company.client, report)).ok).toBe(true);
  expect(await finalizeVatReport(company.client, report)).toEqual({
    ok: true,
    value: null,
  });

  const exported = await exportCompanyData(company.client, report);
  expect(exported.ok).toBe(true);
  if (!exported.ok) return;
  expect(
    await softDeleteCompany(company.client, {
      companyId: company.companyId,
      exportId: exported.value.exportId,
    }),
  ).toEqual({ ok: true, value: null });
  expect(
    await systemClient()
      .from("document")
      .select("id, status")
      .eq("id", document.id)
      .single(),
  ).toEqual(
    expect.objectContaining({
      data: { id: document.id, status: "approved" },
      error: null,
    }),
  );
  const physicalDeletion = await systemClient()
    .from("document")
    .delete()
    .eq("id", document.id);
  expect(physicalDeletion.error?.code).toBe("42501");
  expect(
    (
      await systemClient()
        .from("document")
        .select("id")
        .eq("id", document.id)
        .single()
    ).data,
  ).toEqual({ id: document.id });
});
