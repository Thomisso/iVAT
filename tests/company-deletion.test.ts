import { createHash } from "node:crypto";
import { strFromU8, unzipSync } from "fflate";
import { expect, it } from "vitest";
import type { AppClient } from "@/application/client";
import { listAuditEvents } from "@/application/audit";
import {
  enableAiProcessing,
  getCompany,
  listMyCompanies,
} from "@/application/companies";
import {
  exportCompanyData,
  getCompanyDataExportStatus,
  softDeleteCompany,
} from "@/application/company-deletion";
import { approveDocument, listDocuments, mergeDocuments } from "@/application/documents";
import { uploadSourceFile } from "@/application/source-files";
import {
  finalizeVatReport,
  generateVatReport,
} from "@/application/vat-reports";
import { administratorWithCompany, companyMember } from "./support/fixtures";
import { fixtureFile, workbookFile } from "./support/files";
import { systemClient, testWorker } from "./support/worker";

async function exportAndComplete(client: AppClient, input: { companyId: string }) {
  const worker = testWorker();
  const result = await exportCompanyData(client, worker.jobs, input);
  if (result.ok) expect(await worker.runJobs()).toEqual([]);
  return result;
}

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

  const result = await exportAndComplete(company.client, {
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
  ).toEqual({ ok: true, value: expect.objectContaining({
    sourceFileCount: 1,
    documentCount: 1,
  }) });
  expect(await getCompany(company.client, company.companyId)).toBeNull();
  expect(await listMyCompanies(company.client)).toEqual([]);
  expect(await listMyCompanies(member.client)).toEqual([]);
  const hiddenDocuments = await member.client
    .from("document")
    .select("id")
    .eq("company_id", company.companyId);
  expect(hiddenDocuments.error).toBeNull();
  expect(hiddenDocuments.data).toEqual([]);

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
  expect((await listAuditEvents(company.client, company.organizationId)).find((event) => (
    event.action === "company.data_exported"
  ))).toEqual(expect.objectContaining({
    payload: {
      byte_size: result.value.bytes.byteLength,
      export_id: result.value.exportId,
      file_name: result.value.fileName,
      sha256: createHash("sha256").update(result.value.bytes).digest("hex"),
    },
  }));
});

it("allows a Company Administrator, but refuses a User and another tenant", async () => {
  const company = await administratorWithCompany();
  const administrator = await companyMember(company, "administrator");
  const user = await companyMember(company, "user");
  const outsider = await administratorWithCompany("Another Organization");

  expect(
    await exportAndComplete(user.client, {
      companyId: company.companyId,
    }),
  ).toEqual({ ok: false, error: "forbidden" });
  expect(
    await exportAndComplete(outsider.client, {
      companyId: company.companyId,
    }),
  ).toEqual({ ok: false, error: "forbidden" });
  expect(await getCompany(company.client, company.companyId)).not.toBeNull();

  const exported = await exportAndComplete(administrator.client, {
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
  ).toEqual({ ok: true, value: expect.objectContaining({ sourceFileCount: 0, documentCount: 0 }) });
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

it("refuses a forged export receipt through an authenticated RPC", async () => {
  const company = await administratorWithCompany();
  const started = await company.client.rpc("create_company_data_export", {
    target_company_id: company.companyId,
  });
  if (started.error) throw started.error;
  const pending = started.data as unknown as {
    exportId: string;
  };
  const forged = await Reflect.apply(company.client.rpc, company.client, [
    "complete_company_data_export",
    {
      target_export_id: pending.exportId,
      target_byte_size: 1,
      target_sha256: "0".repeat(64),
    },
  ]) as { error: { code?: string } | null };
  const removedPath = await Reflect.apply(company.client.rpc, company.client, [
    "record_company_data_export",
    {
      target_company_id: company.companyId,
      target_export_id: pending.exportId,
      target_file_name: "forged.zip",
      target_byte_size: 1,
      target_sha256: "0".repeat(64),
      expected_data_revision: 0,
    },
  ]) as { error: unknown };
  const workerSnapshot = await Reflect.apply(company.client.rpc, company.client, [
    "company_data_export_for_completion",
    { target_export_id: pending.exportId },
  ]) as { error: { code?: string } | null };
  const forcedFailure = await Reflect.apply(company.client.rpc, company.client, [
    "fail_company_data_export",
    { target_export_id: pending.exportId },
  ]) as { error: { code?: string } | null };

  expect(forged.error?.code).toBe("42501");
  expect(removedPath.error).not.toBeNull();
  expect(workerSnapshot.error?.code).toBe("42501");
  expect(forcedFailure.error?.code).toBe("42501");
  expect(await softDeleteCompany(company.client, {
    companyId: company.companyId,
    exportId: pending.exportId,
  })).toEqual({ ok: false, error: "export_required" });
});

it("completes an export idempotently when the worker runs the job twice at once", async () => {
  const company = await administratorWithCompany();
  const worker = testWorker();
  const exported = await exportCompanyData(company.client, worker.jobs, {
    companyId: company.companyId,
  });
  if (!exported.ok) throw new Error(exported.error);
  expect(worker.queued).toEqual([{
    name: "complete-company-export",
    data: { exportId: exported.value.exportId },
  }]);
  expect(await getCompanyDataExportStatus(company.client, {
    companyId: company.companyId,
    exportId: exported.value.exportId,
  })).toEqual({ ok: true, value: "pending" });
  expect(await softDeleteCompany(company.client, {
    companyId: company.companyId,
    exportId: exported.value.exportId,
  })).toEqual({ ok: false, error: "export_required" });

  const [completionJob] = worker.queued;
  worker.queued.push(completionJob);
  expect(await worker.runJobsConcurrently()).toEqual([]);
  worker.queued.push(completionJob);
  expect(await worker.runJobs()).toEqual([]);
  expect(await getCompanyDataExportStatus(company.client, {
    companyId: company.companyId,
    exportId: exported.value.exportId,
  })).toEqual({ ok: true, value: "completed" });
  expect((await listAuditEvents(company.client, company.organizationId)).filter((event) => (
    event.action === "company.data_exported"
  ))).toHaveLength(1);
  expect(await softDeleteCompany(company.client, {
    companyId: company.companyId,
    exportId: exported.value.exportId,
  })).toEqual({ ok: true, value: expect.any(Object) });
});

it("marks a terminal export worker failure instead of leaving the receipt pending", async () => {
  const company = await administratorWithCompany();
  const worker = testWorker();
  const original = fixtureFile("receipt.png");
  const uploaded = await uploadSourceFile(company.client, { async send() {} }, {
    companyId: company.companyId,
    fileName: "receipt.png",
    bytes: original,
  });
  if (!uploaded.ok) throw new Error(uploaded.error);
  const exported = await exportCompanyData(company.client, worker.jobs, { companyId: company.companyId });
  if (!exported.ok) throw new Error(exported.error);
  const [completionJob] = worker.queued;
  const objectPath = `${company.companyId}/${uploaded.value.id}`;
  expect((await systemClient().storage.from("source-files").remove([objectPath])).error).toBeNull();

  expect(await worker.runJobs({ final: false })).toHaveLength(1);
  expect(await getCompanyDataExportStatus(company.client, {
    companyId: company.companyId,
    exportId: exported.value.exportId,
  })).toEqual({ ok: true, value: "pending" });
  worker.queued.push(completionJob);
  expect(await worker.runJobs({ final: true })).toHaveLength(1);
  expect(await getCompanyDataExportStatus(company.client, {
    companyId: company.companyId,
    exportId: exported.value.exportId,
  })).toEqual({ ok: true, value: "failed" });

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
    await exportAndComplete(company.client, {
      companyId: company.companyId,
    }),
  ).toEqual({ ok: false, error: "export_failed" });
  expect(await getCompany(company.client, company.companyId)).not.toBeNull();
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

  const exported = await exportAndComplete(company.client, report);
  expect(exported.ok).toBe(true);
  if (!exported.ok) return;
  expect(
    await softDeleteCompany(company.client, {
      companyId: company.companyId,
      exportId: exported.value.exportId,
    }),
  ).toEqual({ ok: true, value: {
    sourceFileCount: 1,
    documentCount: 1,
    approvedDocumentCount: 1,
    periodLockCount: 1,
  } });
  expect(await getCompany(company.client, company.companyId)).toBeNull();
});

it("exports every Document beyond the API row limit, including superseded rows", async () => {
  const company = await administratorWithCompany();
  const worker = testWorker();
  worker.ai.split = async () => ({
    documents: Array.from({ length: 1001 }, (_, index) => ({
      sheetName: "Invoices",
      firstRow: index + 2,
      lastRow: index + 2,
    })),
    model: "test-split",
  });
  await enableAiProcessing(company.client, worker.jobs, {
    companyId: company.companyId,
    provider: worker.ai,
  });
  const uploaded = await uploadSourceFile(company.client, worker.jobs, {
    companyId: company.companyId,
    fileName: "many-rows.xlsx",
    bytes: workbookFile("xlsx", [["Invoice"], ...Array.from({ length: 1001 }, (_, i) => [`INV-${i}`])]),
  });
  if (!uploaded.ok) throw new Error(uploaded.error);
  await worker.runNextJob();
  const supersededWorker = testWorker();
  const supersededSource = await uploadSourceFile(company.client, supersededWorker.jobs, {
    companyId: company.companyId,
    fileName: "two-invoices.pdf",
    bytes: fixtureFile("two-invoices.pdf"),
  });
  if (!supersededSource.ok) throw new Error(supersededSource.error);
  expect(await supersededWorker.runJobs()).toEqual([]);
  const [first, second] = await listDocuments(company.client, company.companyId, supersededSource.value.id);
  expect(await mergeDocuments(company.client, worker.jobs, {
    companyId: company.companyId,
    leftDocumentId: first.id,
    rightDocumentId: second.id,
  })).toEqual({ ok: true, value: null });

  const exported = await exportAndComplete(company.client, { companyId: company.companyId });
  expect(exported.ok).toBe(true);
  if (!exported.ok) return;
  const documents = JSON.parse(strFromU8(unzipSync(exported.value.bytes)["documents.json"]));
  expect(documents).toHaveLength(1003);
  expect(new Set(documents.map((document: { id: string }) => document.id)).size).toBe(1003);
  expect(documents).toContainEqual(expect.objectContaining({ id: second.id }));
});

it("refuses deletion when Company data changed after its completed export", async () => {
  const company = await administratorWithCompany();
  const exported = await exportAndComplete(company.client, { companyId: company.companyId });
  if (!exported.ok) throw new Error(exported.error);
  const changed = await uploadSourceFile(company.client, { async send() {} }, {
    companyId: company.companyId,
    fileName: "new-receipt.png",
    bytes: fixtureFile("receipt.png"),
  });
  if (!changed.ok) throw new Error(changed.error);

  expect(await getCompanyDataExportStatus(company.client, {
    companyId: company.companyId,
    exportId: exported.value.exportId,
  })).toEqual({ ok: true, value: "stale" });

  expect(await softDeleteCompany(company.client, {
    companyId: company.companyId,
    exportId: exported.value.exportId,
  })).toEqual({ ok: false, error: "stale_export" });
  expect(await getCompany(company.client, company.companyId)).not.toBeNull();
});

it("refuses an export receipt when Company data changes after its snapshot", async () => {
  const company = await administratorWithCompany();
  let announceSnapshot!: () => void;
  let releaseSnapshot!: () => void;
  const snapshotReady = new Promise<void>((resolve) => { announceSnapshot = resolve; });
  const snapshotGate = new Promise<void>((resolve) => { releaseSnapshot = resolve; });
  const delayedClient = new Proxy(company.client, {
    get(target, property, receiver) {
      if (property === "rpc") {
        return async (...args: unknown[]) => {
          const result = await Reflect.apply(target.rpc, target, args);
          if (args[0] === "create_company_data_export") {
            announceSnapshot();
            await snapshotGate;
          }
          return result;
        };
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as AppClient;
  const worker = testWorker();
  const exporting = exportCompanyData(delayedClient, worker.jobs, { companyId: company.companyId });
  await snapshotReady;
  const changed = await uploadSourceFile(company.client, { async send() {} }, {
    companyId: company.companyId,
    fileName: "changed-after-snapshot.png",
    bytes: fixtureFile("receipt.png"),
  });
  releaseSnapshot();
  if (!changed.ok) throw new Error(changed.error);

  const exported = await exporting;
  if (!exported.ok) throw new Error(exported.error);
  expect(await worker.runJobs()).toEqual([]);
  expect(await getCompanyDataExportStatus(company.client, {
    companyId: company.companyId,
    exportId: exported.value.exportId,
  })).toEqual({ ok: true, value: "stale" });
  expect(await getCompany(company.client, company.companyId)).not.toBeNull();
});

it("throws unexpected Company export failures", async () => {
  const brokenClient = {
    rpc() {
      throw new Error("database unavailable");
    },
  } as unknown as AppClient;

  await expect(exportCompanyData(brokenClient, testWorker().jobs, {
    companyId: "00000000-0000-4000-8000-000000000001",
  })).rejects.toThrow("database unavailable");
});

it("does not expose Company export receipts through direct table reads or writes", async () => {
  const company = await administratorWithCompany();
  const outsider = await administratorWithCompany("Other Organization");
  const exported = await exportAndComplete(company.client, { companyId: company.companyId });
  if (!exported.ok) throw new Error(exported.error);

  const reads = [
    await company.client.from("company_data_export").select("*").eq("id", exported.value.exportId),
    await outsider.client.from("company_data_export").select("*").eq("id", exported.value.exportId),
  ];
  for (const read of reads) expect(read.error?.code).toBe("42501");
  const attempts = [
    await outsider.client.from("company_data_export").insert({
      id: "00000000-0000-4000-8000-000000000099",
      company_id: company.companyId,
      organization_id: company.organizationId,
      created_by: company.userId,
      file_name: "forged.zip",
      byte_size: 1,
      sha256: "0".repeat(64),
      snapshot: {},
    }),
    await outsider.client.from("company_data_export").update({ file_name: "changed.zip" }).eq("id", exported.value.exportId),
    await outsider.client.from("company_data_export").delete().eq("id", exported.value.exportId),
  ];
  for (const attempt of attempts) expect(attempt.error?.code).toBe("42501");
});
